import type { calendar_v3 } from 'googleapis';
import { calendar } from './googleCalendar';
import { supabase } from './supabase';
import { getSchedulingConfig, type SchedulingConfig } from './schedulingConfig';
import { mergeIntervals, subtractIntervals, filterByMinDuration, type Interval } from './intervals';
import { normalizeEventToInterval } from './busyIntervals';
import { decodeEventMetadata } from './eventMetadata';
import { findFreeSlots } from './freeSlots';
import { getCurrentPeriodRange } from './periodRanges';
import {
  resolveHabitPriority,
  resolveHabitOccurrenceDurationMinutes,
  compareHabitsByUrgency,
  type HabitRow,
  type HabitCadence,
  type HabitPlacementContext,
} from './habits';
import { splitIntoSegments, findOccurrenceSlot } from './habitSpacing';
import { createProposedChange, type ProposedChangeRow } from './proposedChanges';

const BURNER_CALENDAR_ID = process.env.GOOGLE_BURNER_CALENDAR_ID!;
const PAGE_SIZE = 2500;
const MAX_PAGES = 20;

async function fetchHabitOccurrenceEvents(
  habitId: string,
  periodStart: Date,
  periodEnd: Date,
  config: SchedulingConfig
): Promise<Interval[]> {
  const intervals: Interval[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const { data } = await calendar.events.list({
      calendarId: BURNER_CALENDAR_ID,
      singleEvents: true,
      showDeleted: false,
      timeMin: periodStart.toISOString(),
      timeMax: periodEnd.toISOString(),
      maxResults: PAGE_SIZE,
      pageToken,
    });

    for (const event of data.items ?? []) {
      const meta = decodeEventMetadata(event.extendedProperties);
      if (meta.type !== 'habit' || meta.sourceId !== habitId) continue;
      const interval = normalizeEventToInterval(event as calendar_v3.Schema$Event, config.homeTimezone);
      if (!interval) continue;
      intervals.push({ start: interval.start, end: interval.end });
    }

    pageToken = data.nextPageToken ?? undefined;
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  return intervals;
}

interface PendingProposalRow {
  proposed_start: string | null;
  proposed_end: string | null;
}

async function fetchPendingHabitProposals(
  habitId: string,
  periodStart: Date,
  periodEnd: Date
): Promise<Interval[]> {
  const { data, error } = await supabase
    .from('proposed_changes')
    .select('proposed_start, proposed_end')
    .eq('change_type', 'create')
    .eq('category', 'habit')
    .eq('source_system', 'ai-engine')
    .eq('source_id', habitId)
    .in('status', ['pending', 'failed'])
    .gte('proposed_start', periodStart.toISOString())
    .lt('proposed_start', periodEnd.toISOString());
  if (error) throw new Error(`proposed_changes read failed: ${error.message}`);

  return ((data ?? []) as PendingProposalRow[])
    .filter((row) => row.proposed_start && row.proposed_end)
    .map((row) => ({ start: Date.parse(row.proposed_start!), end: Date.parse(row.proposed_end!) }));
}

async function fetchAllPendingHabitProposals(habitId: string): Promise<Interval[]> {
  const { data, error } = await supabase
    .from('proposed_changes')
    .select('proposed_start, proposed_end')
    .eq('change_type', 'create')
    .eq('category', 'habit')
    .eq('source_system', 'ai-engine')
    .eq('source_id', habitId)
    .in('status', ['pending', 'failed']);
  if (error) throw new Error(`proposed_changes read failed: ${error.message}`);

  return ((data ?? []) as PendingProposalRow[])
    .filter((row) => row.proposed_start && row.proposed_end)
    .map((row) => ({ start: Date.parse(row.proposed_start!), end: Date.parse(row.proposed_end!) }));
}

interface HabitContext extends HabitPlacementContext {
  pendingIntervals: Interval[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// 'interval' cadence has no fixed calendar period to anchor to (unlike
// weekly/monthly/daily) — it rolls forward from this habit's own last known
// occurrence instead. Finds the most recent one, whether a real calendar
// event or a still-pending/failed proposal (either is a legitimate claim on
// a slot, same "satisfied" treatment the period-based cadences already give
// pending proposals), scanning a bounded lookback/lookahead window around
// `now` rather than the habit's entire history.
async function fetchLastHabitOccurrence(
  habitId: string,
  config: SchedulingConfig,
  now: Date,
  intervalDays: number
): Promise<{ lastStart: number | null; pendingIntervals: Interval[] }> {
  const lookbackDays = Math.max(intervalDays * 10, 90);
  const timeMin = new Date(now.getTime() - lookbackDays * MS_PER_DAY);
  const timeMax = new Date(now.getTime() + intervalDays * MS_PER_DAY);

  const [events, pendingIntervals] = await Promise.all([
    fetchHabitOccurrenceEvents(habitId, timeMin, timeMax, config),
    fetchAllPendingHabitProposals(habitId),
  ]);

  const allStarts = [...events.map((e) => e.start), ...pendingIntervals.map((p) => p.start)];
  const lastStart = allStarts.length > 0 ? Math.max(...allStarts) : null;

  return { lastStart, pendingIntervals };
}

// Rolling-window equivalent of getCurrentPeriodRange for 'interval' cadence.
// The next occurrence must land no earlier than `interval_days` after the
// last one (a real event or a pending proposal, whichever is more recent,
// past or future) — this is what actually delivers "never less than N days
// apart," including across what would be a period boundary for the
// fixed-calendar cadences (see backend-build-order.md item 21's finding that
// weekly/monthly spacing has no such cross-boundary guarantee today).
// Simplification: target_count > 1 is treated all-or-nothing (fully
// satisfied during cooldown, fully due once it lapses) rather than counting
// partial occurrences within the rolling window — 'interval' cadence's
// primary shape ("every other day") is a single recurring action, so this
// isn't expected to matter in practice.
async function computeIntervalHabitContext(
  habit: HabitRow,
  config: SchedulingConfig,
  now: Date
): Promise<HabitContext> {
  const intervalDays = habit.interval_days!;
  const { lastStart, pendingIntervals } = await fetchLastHabitOccurrence(habit.id, config, now, intervalDays);

  const earliestAllowedMs = lastStart !== null ? lastStart + intervalDays * MS_PER_DAY : now.getTime();
  const inCooldown = lastStart !== null && earliestAllowedMs > now.getTime();

  const periodStart = new Date(Math.max(now.getTime(), earliestAllowedMs));
  const periodEnd = new Date(periodStart.getTime() + intervalDays * MS_PER_DAY);

  const occurrencesSatisfied = inCooldown ? habit.target_count : 0;
  const occurrencesRemaining = Math.max(0, habit.target_count - occurrencesSatisfied);

  return { habit, periodStart, periodEnd, occurrencesSatisfied, occurrencesRemaining, pendingIntervals };
}

async function computeHabitPlacementContext(
  habit: HabitRow,
  config: SchedulingConfig,
  now: Date
): Promise<HabitContext> {
  if (habit.cadence === 'interval') {
    return computeIntervalHabitContext(habit, config, now);
  }

  const { periodStart, periodEnd } = getCurrentPeriodRange(habit.cadence, config, now);
  const [events, pendingIntervals] = await Promise.all([
    fetchHabitOccurrenceEvents(habit.id, periodStart, periodEnd, config),
    fetchPendingHabitProposals(habit.id, periodStart, periodEnd),
  ]);

  // Count, not duration — per the user's explicit "occurrence, not duration" call.
  const occurrencesSatisfied = events.length + pendingIntervals.length;
  const occurrencesRemaining = Math.max(0, habit.target_count - occurrencesSatisfied);

  return { habit, periodStart, periodEnd, occurrencesSatisfied, occurrencesRemaining, pendingIntervals };
}

function cadenceLabel(cadence: HabitCadence): string {
  switch (cadence) {
    case 'weekly':
      return 'week';
    case 'monthly':
      return 'month';
    case 'daily':
      return 'day';
    case 'interval':
      return 'interval';
  }
}

export type HabitOccurrenceOutcome = 'proposed' | 'skipped-no-slot' | 'skipped-error';

export interface HabitOccurrenceResult {
  habitId: string;
  title: string;
  occurrenceIndex: number; // 1-based, within this habit's remaining occurrences this run; 0 for a habit-level error
  outcome: HabitOccurrenceOutcome;
  proposal?: ProposedChangeRow;
  reason?: string;
}

export interface HabitPlacementSummary {
  now: string;
  habitsScanned: number;
  habitsAlreadySatisfied: number;
  occurrencesProposed: number;
  occurrencesSkippedNoSlot: number;
  results: HabitOccurrenceResult[];
}

// Occurrence-count auto-fill with spacing (architecture-plan.md section 4f).
// No from/to params — like planFocusTime, always "the current period,"
// here per-habit via each habit's own cadence rather than one
// caller-supplied range.
export async function planHabitPlacement(now: Date = new Date()): Promise<HabitPlacementSummary> {
  const config = getSchedulingConfig();

  const { data: habitRows, error } = await supabase.from('habits').select('*').eq('status', 'active');
  if (error) throw new Error(`habits read failed: ${error.message}`);
  const habits = (habitRows ?? []) as HabitRow[];

  const allContexts = await Promise.all(habits.map((habit) => computeHabitPlacementContext(habit, config, now)));

  // Seed run-wide claimed time from every active habit's still-pending
  // proposals, not just the ones due this run — an already-satisfied
  // habit's unapproved occurrence still occupies real future time a
  // different habit's new proposal must not collide with.
  let claimedIntervals = mergeIntervals(allContexts.flatMap((c) => c.pendingIntervals));

  const due = allContexts.filter((c) => c.occurrencesRemaining > 0);
  due.sort((a, b) => compareHabitsByUrgency(a, b, now));

  const result: HabitPlacementSummary = {
    now: now.toISOString(),
    habitsScanned: habits.length,
    habitsAlreadySatisfied: habits.length - due.length,
    occurrencesProposed: 0,
    occurrencesSkippedNoSlot: 0,
    results: [],
  };

  for (const ctx of due) {
    const occurrenceDurationMinutes = resolveHabitOccurrenceDurationMinutes(ctx.habit);
    const durationMs = occurrenceDurationMinutes * 60_000;
    const searchStart = new Date(Math.max(ctx.periodStart.getTime(), now.getTime()));

    if (searchStart.getTime() >= ctx.periodEnd.getTime()) {
      for (let i = 1; i <= ctx.occurrencesRemaining; i++) {
        result.occurrencesSkippedNoSlot++;
        result.results.push({
          habitId: ctx.habit.id,
          title: ctx.habit.title,
          occurrenceIndex: i,
          outcome: 'skipped-no-slot',
          reason: 'Period has already elapsed',
        });
      }
      continue;
    }

    try {
      const { slots } = await findFreeSlots(searchStart, ctx.periodEnd, {
        minDurationMinutes: occurrenceDurationMinutes,
        config,
      });

      let fitting = filterByMinDuration(subtractIntervals(slots, claimedIntervals), occurrenceDurationMinutes);

      const segments = splitIntoSegments(
        searchStart.getTime(),
        ctx.periodEnd.getTime(),
        ctx.occurrencesRemaining
      );

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        const chosen = findOccurrenceSlot(fitting, segment.start, segment.end, durationMs);

        if (!chosen) {
          result.occurrencesSkippedNoSlot++;
          result.results.push({
            habitId: ctx.habit.id,
            title: ctx.habit.title,
            occurrenceIndex: i + 1,
            outcome: 'skipped-no-slot',
            reason: `No opening of ${occurrenceDurationMinutes}m found for this occurrence`,
          });
          continue;
        }

        const proposal = await createProposedChange({
          change_type: 'create',
          category: 'habit',
          // Opposite of Focus Time's auto-defend — fine to get bumped, fine
          // to not fit some period. flexible:'true' lets autoReschedule.ts
          // move it aside for anything less yielding; priority:'low' (by
          // default) means it loses every tie against everything else.
          flexible: 'true',
          priority: resolveHabitPriority(ctx.habit),
          source_system: 'ai-engine',
          source_id: ctx.habit.id,
          proposed_summary: ctx.habit.title,
          proposed_description: ctx.habit.description ?? undefined,
          duration_minutes: occurrenceDurationMinutes,
          tags: ctx.habit.tags ?? undefined,
          proposed_start: new Date(chosen.start).toISOString(),
          proposed_end: new Date(chosen.end).toISOString(),
          reason: `Habit "${ctx.habit.title}" — occurrence ${i + 1} of ${ctx.habit.target_count} needed this ${cadenceLabel(
            ctx.habit.cadence
          )}`,
        });

        result.occurrencesProposed++;
        result.results.push({
          habitId: ctx.habit.id,
          title: ctx.habit.title,
          occurrenceIndex: i + 1,
          outcome: 'proposed',
          proposal,
        });

        claimedIntervals = mergeIntervals([...claimedIntervals, chosen]);
        fitting = filterByMinDuration(subtractIntervals(fitting, [chosen]), occurrenceDurationMinutes);
      }
    } catch (err) {
      // One habit's failure shouldn't abort the whole batch.
      result.results.push({
        habitId: ctx.habit.id,
        title: ctx.habit.title,
        occurrenceIndex: 0,
        outcome: 'skipped-error',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
