import type { calendar_v3 } from 'googleapis';
import { calendar } from './googleCalendar';
import { supabase } from './supabase';
import { getSchedulingConfig, type SchedulingConfig } from './schedulingConfig';
import { intervalsOverlap, type Interval } from './intervals';
import { normalizeEventToInterval } from './busyIntervals';
import { findFreeSlots } from './freeSlots';
import {
  decodeEventMetadata,
  decodeEventTags,
  PRIORITY_RANK,
  type BurnerEventType,
  type EventPriority,
} from './eventMetadata';
import { createProposedChange, type ProposedChangeRow } from './proposedChanges';

const BURNER_CALENDAR_ID = process.env.GOOGLE_BURNER_CALENDAR_ID!;
const PAGE_SIZE = 2500;
const MAX_PAGES = 20;

export interface SchedulableEvent {
  eventId: string;
  summary: string | null;
  interval: Interval;
  isAllDay: boolean;
  flexible: boolean;
  priority: EventPriority;
  category: BurnerEventType;
  tags: string[];
}

export interface RescheduleSummary {
  eventsScanned: number;
  conflictingPairs: number;
  proposalsCreated: number;
  skippedAlreadyPending: number;
  unresolvedBothFixed: number;
  noSlotAvailable: number;
  proposals: ProposedChangeRow[];
}

// Exported for reuse by lib/dayRebalance.ts (POST /api/calendar/rebalance,
// item 23) — same "fetch every schedulable burner event with its
// flexible/priority metadata" need, just a different trigger than actual
// overlap.
export async function fetchSchedulableEvents(
  rangeStart: Date,
  rangeEnd: Date,
  config: SchedulingConfig
): Promise<SchedulableEvent[]> {
  const events: SchedulableEvent[] = [];
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
      events.push({
        eventId: interval.eventId,
        summary: interval.summary,
        interval: { start: interval.start, end: interval.end },
        isAllDay: interval.isAllDay,
        // Missing metadata (an event never touched by our system) defaults
        // to non-flexible — safest assumption for something we don't
        // recognize is "don't try to move it."
        flexible: meta.flexible === 'true',
        priority: meta.priority ?? 'medium',
        category: meta.type ?? 'meeting',
        tags: decodeEventTags(meta.tags),
      });
    }

    pageToken = data.nextPageToken ?? undefined;
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  return events;
}

export async function findAndProposeReschedules(
  rangeStart: Date,
  rangeEnd: Date,
  config: SchedulingConfig = getSchedulingConfig()
): Promise<RescheduleSummary> {
  if (rangeEnd.getTime() <= rangeStart.getTime()) {
    throw new Error('rangeEnd must be later than rangeStart');
  }

  const events = await fetchSchedulableEvents(rangeStart, rangeEnd, config);

  let conflictingPairs = 0;
  let unresolvedBothFixed = 0;
  const moverConflicts = new Map<string, string[]>();

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      if (!intervalsOverlap(a.interval, b.interval)) continue;
      conflictingPairs++;

      let mover: SchedulableEvent;
      if (a.flexible && !b.flexible) {
        mover = a;
      } else if (b.flexible && !a.flexible) {
        mover = b;
      } else if (a.flexible && b.flexible) {
        const rankA = PRIORITY_RANK[a.priority];
        const rankB = PRIORITY_RANK[b.priority];
        // Higher rank number = lower priority = moves. Exact ties break on
        // eventId comparison — arbitrary but deterministic, so re-running
        // this doesn't flip-flop which side moves.
        mover = rankA !== rankB ? (rankA > rankB ? a : b) : a.eventId > b.eventId ? a : b;
      } else {
        unresolvedBothFixed++;
        continue;
      }

      const other = mover === a ? b : a;
      const conflicts = moverConflicts.get(mover.eventId);
      if (conflicts) conflicts.push(other.summary ?? other.eventId);
      else moverConflicts.set(mover.eventId, [other.summary ?? other.eventId]);
    }
  }

  let proposalsCreated = 0;
  let skippedAlreadyPending = 0;
  let noSlotAvailable = 0;
  const proposals: ProposedChangeRow[] = [];

  for (const [eventId, conflictsWith] of moverConflicts) {
    const mover = events.find((e) => e.eventId === eventId)!;

    const { data: existingProposals, error } = await supabase
      .from('proposed_changes')
      .select('id')
      .eq('change_type', 'move')
      .eq('target_event_id', eventId)
      .in('status', ['pending', 'failed']);
    if (error) throw new Error(`proposed_changes read failed: ${error.message}`);
    if ((existingProposals ?? []).length > 0) {
      skippedAlreadyPending++;
      continue;
    }

    const durationMs = mover.interval.end - mover.interval.start;
    const durationMinutes = Math.max(1, Math.round(durationMs / 60000));
    const searchStart = new Date(Math.max(rangeStart.getTime(), Date.now()));

    if (searchStart.getTime() >= rangeEnd.getTime()) {
      noSlotAvailable++;
      continue;
    }

    const { slots } = await findFreeSlots(searchStart, rangeEnd, {
      minDurationMinutes: durationMinutes,
      config,
      category: mover.category,
      tags: mover.tags,
    });
    if (slots.length === 0) {
      noSlotAvailable++;
      continue;
    }

    const chosenStart = slots[0].start;
    const chosenEnd = chosenStart + durationMs;

    const proposal = await createProposedChange({
      change_type: 'move',
      category: mover.category,
      source_system: 'ai-engine',
      target_event_id: mover.eventId,
      proposed_start: new Date(chosenStart).toISOString(),
      proposed_end: new Date(chosenEnd).toISOString(),
      reason: `Conflicts with ${conflictsWith.join(', ')}`,
    });

    proposalsCreated++;
    proposals.push(proposal);
  }

  return {
    eventsScanned: events.length,
    conflictingPairs,
    proposalsCreated,
    skippedAlreadyPending,
    unresolvedBothFixed,
    noSlotAvailable,
    proposals,
  };
}
