import { DateTime } from 'luxon';
import type { calendar_v3 } from 'googleapis';
import { calendar } from './googleCalendar';
import { supabase } from './supabase';
import { getSchedulingConfig, type SchedulingConfig } from './schedulingConfig';
import { mergeIntervals, subtractIntervals, type Interval } from './intervals';
import { normalizeEventToInterval } from './busyIntervals';
import { decodeEventMetadata } from './eventMetadata';
import { findFreeSlots } from './freeSlots';
import { createProposedChange, type ProposedChangeRow } from './proposedChanges';

const BURNER_CALENDAR_ID = process.env.GOOGLE_BURNER_CALENDAR_ID!;
const PAGE_SIZE = 2500;
const MAX_PAGES = 20;

// Below this, a "focus block" isn't meaningfully deep work — skip proposing
// slivers even if the weekly goal still has room left.
const MIN_BLOCK_MINUTES = 30;
const DEFAULT_BLOCK_MINUTES = 90;

function getFocusTimeConfig(): { weeklyGoalMinutes: number; blockMinutes: number } {
  const rawGoal = process.env.FOCUS_TIME_WEEKLY_GOAL_MINUTES?.trim();
  if (!rawGoal) {
    throw new Error(
      'FOCUS_TIME_WEEKLY_GOAL_MINUTES is not set — this is a personal target, not something with a safe default'
    );
  }
  const weeklyGoalMinutes = Number(rawGoal);
  if (!Number.isFinite(weeklyGoalMinutes) || weeklyGoalMinutes <= 0) {
    throw new Error(`FOCUS_TIME_WEEKLY_GOAL_MINUTES="${rawGoal}" must be a positive number`);
  }

  const rawBlock = process.env.FOCUS_TIME_BLOCK_MINUTES?.trim();
  const blockMinutes = rawBlock ? Number(rawBlock) : DEFAULT_BLOCK_MINUTES;
  if (!Number.isFinite(blockMinutes) || blockMinutes < MIN_BLOCK_MINUTES) {
    throw new Error(`FOCUS_TIME_BLOCK_MINUTES must be at least ${MIN_BLOCK_MINUTES} (got "${rawBlock}")`);
  }

  return { weeklyGoalMinutes, blockMinutes };
}

// Monday 00:00 through the following Monday 00:00, in HOME_TIMEZONE — the
// week the weekly goal is tracked against. Independent of WORKING_DAYS (the
// goal is about your week, not just the days you'd normally schedule
// through) — though new blocks only ever land within working hours, same as
// everything else findFreeSlots proposes into.
export function getCurrentWeekRange(
  config: SchedulingConfig,
  now: Date = new Date()
): { weekStart: Date; weekEnd: Date } {
  const start = DateTime.fromJSDate(now, { zone: config.homeTimezone }).startOf('week');
  return { weekStart: start.toJSDate(), weekEnd: start.plus({ weeks: 1 }).toJSDate() };
}

interface FocusTimeEvent {
  eventId: string;
  interval: Interval;
}

async function fetchFocusTimeEvents(
  weekStart: Date,
  weekEnd: Date,
  config: SchedulingConfig
): Promise<FocusTimeEvent[]> {
  const events: FocusTimeEvent[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const { data } = await calendar.events.list({
      calendarId: BURNER_CALENDAR_ID,
      singleEvents: true,
      showDeleted: false,
      timeMin: weekStart.toISOString(),
      timeMax: weekEnd.toISOString(),
      maxResults: PAGE_SIZE,
      pageToken,
    });

    for (const event of data.items ?? []) {
      const meta = decodeEventMetadata(event.extendedProperties);
      if (meta.type !== 'focusTime') continue;
      const interval = normalizeEventToInterval(event as calendar_v3.Schema$Event, config.homeTimezone);
      if (!interval) continue;
      events.push({ eventId: interval.eventId, interval: { start: interval.start, end: interval.end } });
    }

    pageToken = data.nextPageToken ?? undefined;
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  return events;
}

interface ProposedChangeTimeRow {
  id: string;
  proposed_start: string | null;
  proposed_end: string | null;
}

interface PendingFocusProposal {
  id: string;
  interval: Interval;
}

async function fetchPendingFocusProposals(weekStart: Date, weekEnd: Date): Promise<PendingFocusProposal[]> {
  const { data, error } = await supabase
    .from('proposed_changes')
    .select('id, proposed_start, proposed_end')
    .eq('change_type', 'create')
    .eq('category', 'focusTime')
    .eq('source_system', 'ai-engine')
    .in('status', ['pending', 'failed'])
    .gte('proposed_start', weekStart.toISOString())
    .lt('proposed_start', weekEnd.toISOString());
  if (error) throw new Error(`proposed_changes read failed: ${error.message}`);

  return ((data ?? []) as ProposedChangeTimeRow[])
    .filter((row) => row.proposed_start && row.proposed_end)
    .map((row) => ({
      id: row.id,
      interval: { start: Date.parse(row.proposed_start!), end: Date.parse(row.proposed_end!) },
    }));
}

function sumMinutes(intervals: Interval[]): number {
  return Math.round(intervals.reduce((total, i) => total + (i.end - i.start), 0) / 60_000);
}

export interface FocusTimePlanSummary {
  weekStart: string;
  weekEnd: string;
  goalMinutes: number;
  alreadyAccountedMinutes: number;
  remainingMinutes: number;
  proposalsCreated: number;
  proposals: ProposedChangeRow[];
  noRoomLeftInWeek: boolean;
}

// Weekly-goal auto-fill: if this week's focusTime blocks (already on the
// calendar, plus this engine's own still-pending proposals) fall short of
// FOCUS_TIME_WEEKLY_GOAL_MINUTES, propose new blocks into free slots for the
// rest of the week until the goal's covered or the week runs out of room.
// On-demand only, same as every other run-this-now endpoint so far —
// nothing in this backend is on a cron yet.
export async function planFocusTime(now: Date = new Date()): Promise<FocusTimePlanSummary> {
  const config = getSchedulingConfig();
  const { weeklyGoalMinutes, blockMinutes } = getFocusTimeConfig();
  const { weekStart, weekEnd } = getCurrentWeekRange(config, now);

  const [existingEvents, pendingProposals] = await Promise.all([
    fetchFocusTimeEvents(weekStart, weekEnd, config),
    fetchPendingFocusProposals(weekStart, weekEnd),
  ]);

  const existingMinutes = sumMinutes(existingEvents.map((e) => e.interval));
  const pendingMinutes = sumMinutes(pendingProposals.map((p) => p.interval));
  const alreadyAccountedMinutes = existingMinutes + pendingMinutes;
  let remainingMinutes = weeklyGoalMinutes - alreadyAccountedMinutes;

  const result: FocusTimePlanSummary = {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    goalMinutes: weeklyGoalMinutes,
    alreadyAccountedMinutes,
    remainingMinutes: Math.max(0, remainingMinutes),
    proposalsCreated: 0,
    proposals: [],
    noRoomLeftInWeek: false,
  };

  if (remainingMinutes < MIN_BLOCK_MINUTES) {
    return result;
  }

  const searchStart = new Date(Math.max(weekStart.getTime(), now.getTime()));
  if (searchStart.getTime() >= weekEnd.getTime()) {
    result.noRoomLeftInWeek = true;
    return result;
  }

  const { slots } = await findFreeSlots(searchStart, weekEnd, { minDurationMinutes: MIN_BLOCK_MINUTES, config });

  // Pending proposals aren't real calendar events yet, so findFreeSlots
  // still sees their time as open — carve it back out so re-running this
  // before those are approved doesn't double-propose the same slice of week.
  const pendingIntervals = mergeIntervals(pendingProposals.map((p) => p.interval));
  const openSlots = subtractIntervals(slots, pendingIntervals);

  for (const slot of openSlots) {
    let cursor = slot.start;
    while (remainingMinutes >= MIN_BLOCK_MINUTES && cursor < slot.end) {
      const slotRemainingMinutes = Math.round((slot.end - cursor) / 60_000);
      if (slotRemainingMinutes < MIN_BLOCK_MINUTES) break;

      const thisBlockMinutes = Math.min(remainingMinutes, blockMinutes, slotRemainingMinutes);
      const blockStart = cursor;
      const blockEnd = cursor + thisBlockMinutes * 60_000;

      const proposal = await createProposedChange({
        change_type: 'create',
        category: 'focusTime',
        flexible: 'true',
        // Auto-defend: outranks medium-priority flexible events in item 5's
        // auto-reschedule, so other things move around a focus block rather
        // than the reverse. Still below 'critical' — an unmovable fixed
        // event should win, not get blocked by a focus session.
        priority: 'high',
        source_system: 'ai-engine',
        proposed_summary: 'Focus Time',
        proposed_start: new Date(blockStart).toISOString(),
        proposed_end: new Date(blockEnd).toISOString(),
        reason: `Weekly focus-time goal catch-up (${weeklyGoalMinutes} min/week)`,
      });

      result.proposalsCreated++;
      result.proposals.push(proposal);
      remainingMinutes -= thisBlockMinutes;
      cursor = blockEnd;
    }
    if (remainingMinutes < MIN_BLOCK_MINUTES) break;
  }

  result.remainingMinutes = Math.max(0, remainingMinutes);
  result.noRoomLeftInWeek = remainingMinutes >= MIN_BLOCK_MINUTES;

  return result;
}

export interface DeepWorkIndexStats {
  weekStart: string;
  weekEnd: string;
  goalMinutes: number;
  completedMinutes: number;
  scheduledMinutes: number;
  pendingProposalMinutes: number;
  deepWorkIndex: number; // completedMinutes / goalMinutes, as a percentage — uncapped, so >100 is visible if you overshoot
}

// completedMinutes only counts focusTime blocks that have already happened
// (end <= now) — this is a stat about actual deep work done this week, not
// a projection of what's merely booked. scheduledMinutes/pendingProposalMinutes
// are broken out separately so a client can still show the fuller picture.
export async function getDeepWorkIndex(now: Date = new Date()): Promise<DeepWorkIndexStats> {
  const config = getSchedulingConfig();
  const { weeklyGoalMinutes } = getFocusTimeConfig();
  const { weekStart, weekEnd } = getCurrentWeekRange(config, now);

  const [existingEvents, pendingProposals] = await Promise.all([
    fetchFocusTimeEvents(weekStart, weekEnd, config),
    fetchPendingFocusProposals(weekStart, weekEnd),
  ]);

  const nowMs = now.getTime();
  const completedMinutes = sumMinutes(
    existingEvents.filter((e) => e.interval.end <= nowMs).map((e) => e.interval)
  );
  const scheduledMinutes = sumMinutes(
    existingEvents.filter((e) => e.interval.end > nowMs).map((e) => e.interval)
  );
  const pendingProposalMinutes = sumMinutes(pendingProposals.map((p) => p.interval));

  return {
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    goalMinutes: weeklyGoalMinutes,
    completedMinutes,
    scheduledMinutes,
    pendingProposalMinutes,
    deepWorkIndex: Math.round((completedMinutes / weeklyGoalMinutes) * 100),
  };
}
