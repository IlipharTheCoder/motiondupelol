import type { calendar_v3 } from 'googleapis';
import { calendar } from './googleCalendar';
import { supabase } from './supabase';
import { getSchedulingConfig, type SchedulingConfig } from './schedulingConfig';
import { intervalsOverlap, type Interval } from './intervals';
import { normalizeEventToInterval } from './busyIntervals';
import { decodeEventMetadata, type BurnerEventType } from './eventMetadata';
import { detectConflicts } from './freeSlots';
import { createProposedChange, ValidationError, type ProposedChangeRow } from './proposedChanges';

const BURNER_CALENDAR_ID = process.env.GOOGLE_BURNER_CALENDAR_ID!;
const PAGE_SIZE = 2500;
const MAX_PAGES = 20;

// Each independently optional and 0 by default ("off") — unlike Focus Time's
// weekly goal, a buffer kind sitting unset just means you don't want that
// kind, not a missing personal target.
function getNonNegativeMinutesEnv(name: string): number {
  const raw = process.env[name]?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number (got "${raw}")`);
  }
  return value;
}

interface BufferTimeConfig {
  travelMinutes: number;
  prepMinutes: number;
  followupMinutes: number;
}

function getBufferTimeConfig(): BufferTimeConfig {
  return {
    travelMinutes: getNonNegativeMinutesEnv('BUFFER_TRAVEL_MINUTES'),
    prepMinutes: getNonNegativeMinutesEnv('BUFFER_PREP_MINUTES'),
    followupMinutes: getNonNegativeMinutesEnv('BUFFER_FOLLOWUP_MINUTES'),
  };
}

interface TriggerEvent {
  eventId: string;
  summary: string | null;
  hasLocation: boolean;
  category: BurnerEventType;
  interval: Interval;
}

interface TaggedBuffer {
  sourceId: string | null;
  interval: Interval;
}

async function fetchEventsInRange(
  rangeStart: Date,
  rangeEnd: Date,
  config: SchedulingConfig
): Promise<{ triggers: TriggerEvent[]; existingBuffers: TaggedBuffer[] }> {
  const triggers: TriggerEvent[] = [];
  const existingBuffers: TaggedBuffer[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const { data } = await calendar.events.list({
      calendarId: BURNER_CALENDAR_ID,
      singleEvents: true,
      showDeleted: false,
      timeMin: rangeStart.toISOString(),
      timeMax: rangeEnd.toISOString(),
      maxResults: PAGE_SIZE,
      pageToken,
    });

    for (const event of data.items ?? []) {
      const interval = normalizeEventToInterval(event as calendar_v3.Schema$Event, config.homeTimezone);
      if (!interval) continue;
      const meta = decodeEventMetadata(event.extendedProperties);
      const category = meta.type ?? 'meeting';

      if (category === 'buffer') {
        existingBuffers.push({ sourceId: meta.sourceId ?? null, interval: { start: interval.start, end: interval.end } });
        continue;
      }

      const hasLocation = !!event.location?.trim();
      // Only a trigger if there's something to buffer around: a meeting (for
      // prep/follow-up) or anything with a location (for travel), regardless
      // of category — an errand-type task with an address still needs
      // travel time even though it isn't a "meeting."
      if (category !== 'meeting' && !hasLocation) continue;

      triggers.push({
        eventId: interval.eventId,
        summary: interval.summary,
        hasLocation,
        category,
        interval: { start: interval.start, end: interval.end },
      });
    }

    pageToken = data.nextPageToken ?? undefined;
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  return { triggers, existingBuffers };
}

interface PendingBufferRow {
  source_id: string | null;
  proposed_start: string | null;
  proposed_end: string | null;
}

// Not date-filtered — a personal calendar's pending-buffer volume is small
// enough that fetching everything is simpler than reasoning about a trigger
// event whose computed buffer window straddles a range boundary.
async function fetchPendingBuffers(): Promise<TaggedBuffer[]> {
  const { data, error } = await supabase
    .from('proposed_changes')
    .select('source_id, proposed_start, proposed_end')
    .eq('change_type', 'create')
    .eq('category', 'buffer')
    .in('status', ['pending', 'failed']);
  if (error) throw new Error(`proposed_changes read failed: ${error.message}`);

  return ((data ?? []) as PendingBufferRow[])
    .filter((row) => row.proposed_start && row.proposed_end)
    .map((row) => ({
      sourceId: row.source_id,
      interval: { start: Date.parse(row.proposed_start!), end: Date.parse(row.proposed_end!) },
    }));
}

type BufferKind = 'travel-before' | 'prep' | 'travel-after' | 'follow-up';

interface BufferCandidate {
  kind: BufferKind;
  interval: Interval;
  summary: string;
}

// Chained so multiple buffer kinds around the same trigger stay contiguous:
// [prep][travel][MEETING][travel][follow-up]. Travel sits immediately
// against the trigger (you have to actually be traveling right up until you
// arrive); prep/follow-up sit further out.
function buildCandidates(trigger: TriggerEvent, config: BufferTimeConfig): BufferCandidate[] {
  const candidates: BufferCandidate[] = [];
  const summary = trigger.summary ?? 'event';

  let cursorBefore = trigger.interval.start;
  if (trigger.hasLocation && config.travelMinutes > 0) {
    const start = cursorBefore - config.travelMinutes * 60_000;
    candidates.push({ kind: 'travel-before', interval: { start, end: cursorBefore }, summary: `Travel to ${summary}` });
    cursorBefore = start;
  }
  if (trigger.category === 'meeting' && config.prepMinutes > 0) {
    const start = cursorBefore - config.prepMinutes * 60_000;
    candidates.push({ kind: 'prep', interval: { start, end: cursorBefore }, summary: `Prep for ${summary}` });
  }

  let cursorAfter = trigger.interval.end;
  if (trigger.hasLocation && config.travelMinutes > 0) {
    const end = cursorAfter + config.travelMinutes * 60_000;
    candidates.push({ kind: 'travel-after', interval: { start: cursorAfter, end }, summary: `Travel from ${summary}` });
    cursorAfter = end;
  }
  if (trigger.category === 'meeting' && config.followupMinutes > 0) {
    const end = cursorAfter + config.followupMinutes * 60_000;
    candidates.push({ kind: 'follow-up', interval: { start: cursorAfter, end }, summary: `Follow-up: ${summary}` });
  }

  return candidates;
}

export interface BufferTimePlanSummary {
  rangeStart: string;
  rangeEnd: string;
  triggersScanned: number;
  proposalsCreated: number;
  skippedAlreadyBuffered: number;
  skippedConflict: number;
  proposals: ProposedChangeRow[];
}

// Differentiated buffer time (architecture-plan.md section 4c): travel
// buffer keyed off any trigger event's `location`, prep/follow-up buffer
// keyed off category:'meeting' specifically — two independent knobs rather
// than one flat rule, since a phone call doesn't need travel time and an
// errand doesn't need meeting prep. On-demand only, same as everything else
// built so far.
export async function planBufferTime(rangeStart: Date, rangeEnd: Date): Promise<BufferTimePlanSummary> {
  if (rangeEnd.getTime() <= rangeStart.getTime()) {
    throw new ValidationError('rangeEnd must be later than rangeStart');
  }

  const config = getSchedulingConfig();
  const bufferConfig = getBufferTimeConfig();
  if (bufferConfig.travelMinutes === 0 && bufferConfig.prepMinutes === 0 && bufferConfig.followupMinutes === 0) {
    throw new ValidationError(
      'At least one of BUFFER_TRAVEL_MINUTES, BUFFER_PREP_MINUTES, BUFFER_FOLLOWUP_MINUTES must be set above zero'
    );
  }

  const [{ triggers, existingBuffers }, pendingBuffers] = await Promise.all([
    fetchEventsInRange(rangeStart, rangeEnd, config),
    fetchPendingBuffers(),
  ]);
  const knownBuffers = [...existingBuffers, ...pendingBuffers];

  const result: BufferTimePlanSummary = {
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
    triggersScanned: triggers.length,
    proposalsCreated: 0,
    skippedAlreadyBuffered: 0,
    skippedConflict: 0,
    proposals: [],
  };

  for (const trigger of triggers) {
    const candidates = buildCandidates(trigger, bufferConfig);

    for (const candidate of candidates) {
      const alreadyBuffered = knownBuffers.some(
        (b) => b.sourceId === trigger.eventId && intervalsOverlap(b.interval, candidate.interval)
      );
      if (alreadyBuffered) {
        result.skippedAlreadyBuffered++;
        continue;
      }

      const { hasConflict } = await detectConflicts(
        new Date(candidate.interval.start),
        new Date(candidate.interval.end)
      );
      if (hasConflict) {
        result.skippedConflict++;
        continue;
      }

      const proposal = await createProposedChange({
        change_type: 'create',
        category: 'buffer',
        // Not flexible: a buffer block only means something immediately
        // adjacent to its trigger event — letting auto-reschedule float it
        // elsewhere on conflict would defeat its purpose. If something else
        // conflicts with it, the other (flexible) side moves instead;
        // low priority just governs display/consistency, not movement.
        flexible: 'false',
        priority: 'low',
        source_system: 'ai-engine',
        source_id: trigger.eventId,
        proposed_summary: candidate.summary,
        proposed_start: new Date(candidate.interval.start).toISOString(),
        proposed_end: new Date(candidate.interval.end).toISOString(),
        reason: `${candidate.kind} buffer for "${trigger.summary ?? trigger.eventId}"`,
      });

      result.proposalsCreated++;
      result.proposals.push(proposal);
    }
  }

  return result;
}
