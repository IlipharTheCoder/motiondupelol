import { supabase } from './supabase';
import { getSchedulingConfig, type SchedulingConfig } from './schedulingConfig';
import { findFreeSlots } from './freeSlots';
import { mergeIntervals, subtractIntervals, filterByMinDuration, type Interval } from './intervals';
import { PRIORITY_RANK } from './eventMetadata';
import { createProposedChange, type ProposedChangeRow } from './proposedChanges';
import { fetchSchedulableEvents, type SchedulableEvent } from './autoReschedule';

export interface RebalanceSummary {
  rangeStart: string;
  rangeEnd: string;
  searchEnd: string;
  maxBusyMinutes: number;
  totalBusyMinutesBefore: number;
  totalBusyMinutesAfter: number;
  alreadyUnderTarget: boolean;
  eventsScanned: number;
  candidatesConsidered: number;
  proposalsCreated: number;
  skippedAlreadyPending: number;
  skippedNoSlot: number;
  unmetMinutes: number;
  proposals: ProposedChangeRow[];
}

function eventDurationMinutes(event: SchedulableEvent): number {
  return Math.max(1, Math.round((event.interval.end - event.interval.start) / 60_000));
}

// "Reduce today's workload" (item 23) — narrower than the full AI Planner
// (item 11): given a window that's carrying too much, propose moving some
// lower-priority flexible items elsewhere, rather than reacting to an actual
// overlap the way lib/autoReschedule.ts does. A relocated item only ever
// counts toward the target if it actually leaves [rangeStart, rangeEnd) —
// moving something to a different still-in-window slot wouldn't change the
// window's total busy minutes at all, so candidate slots are always searched
// starting at rangeEnd, through searchEnd.
export async function rebalanceWorkload(
  rangeStart: Date,
  rangeEnd: Date,
  maxBusyMinutes: number,
  searchEnd: Date,
  config: SchedulingConfig = getSchedulingConfig()
): Promise<RebalanceSummary> {
  if (rangeEnd.getTime() <= rangeStart.getTime()) {
    throw new Error('rangeEnd must be later than rangeStart');
  }
  if (searchEnd.getTime() <= rangeEnd.getTime()) {
    throw new Error('searchEnd must be later than rangeEnd');
  }

  // All-day events (e.g. a multi-day synced "Sunrise Bootcamp"-style entry)
  // are excluded entirely — their start/end span whole calendar days, not a
  // literal block of scheduled time, so summing their duration would wildly
  // overstate "workload." Excluded from both the total and from being a
  // movable candidate.
  const allEvents = await fetchSchedulableEvents(rangeStart, rangeEnd, config);
  const events = allEvents.filter((e) => !e.isAllDay);
  const totalBusyMinutesBefore = events.reduce((sum, e) => sum + eventDurationMinutes(e), 0);

  const result: RebalanceSummary = {
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
    searchEnd: searchEnd.toISOString(),
    maxBusyMinutes,
    totalBusyMinutesBefore,
    totalBusyMinutesAfter: totalBusyMinutesBefore,
    alreadyUnderTarget: totalBusyMinutesBefore <= maxBusyMinutes,
    eventsScanned: events.length,
    candidatesConsidered: 0,
    proposalsCreated: 0,
    skippedAlreadyPending: 0,
    skippedNoSlot: 0,
    unmetMinutes: 0,
    proposals: [],
  };

  if (result.alreadyUnderTarget) {
    return result;
  }

  let minutesToRemove = totalBusyMinutesBefore - maxBusyMinutes;

  // Lowest priority first (moves the least important things first); largest
  // duration first within a tier (fewer moves needed to hit the target);
  // eventId as a final deterministic tiebreak, same style as
  // lib/autoReschedule.ts's mover-selection.
  const candidates = events
    .filter((e) => e.flexible)
    .sort((a, b) => {
      // Higher PRIORITY_RANK number = lower priority = should move first, so
      // this is intentionally b-minus-a (descending rank), the opposite of
      // lib/aiTasks.ts's priority-score sort which puts the most important
      // (lowest rank number) first.
      const rankDiff = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
      if (rankDiff !== 0) return rankDiff;
      const durationDiff = eventDurationMinutes(b) - eventDurationMinutes(a);
      if (durationDiff !== 0) return durationDiff;
      return a.eventId > b.eventId ? 1 : -1;
    });

  const searchFloor = new Date(Math.max(rangeEnd.getTime(), Date.now()));

  // Slots claimed by this run's own earlier proposals — without this, two
  // candidates could each independently find the same "first free slot"
  // (still genuinely free on the real calendar, since neither proposal is
  // applied yet) and get proposed into the same overlapping time.
  let claimedIntervals: Interval[] = [];

  for (const candidate of candidates) {
    if (minutesToRemove <= 0) break;
    result.candidatesConsidered++;

    const { data: existingProposals, error } = await supabase
      .from('proposed_changes')
      .select('id')
      .eq('change_type', 'move')
      .eq('target_event_id', candidate.eventId)
      .in('status', ['pending', 'failed']);
    if (error) throw new Error(`proposed_changes read failed: ${error.message}`);
    if ((existingProposals ?? []).length > 0) {
      result.skippedAlreadyPending++;
      continue;
    }

    const durationMinutes = eventDurationMinutes(candidate);
    const durationMs = candidate.interval.end - candidate.interval.start;

    if (searchFloor.getTime() >= searchEnd.getTime()) {
      result.skippedNoSlot++;
      continue;
    }

    const { slots } = await findFreeSlots(searchFloor, searchEnd, { minDurationMinutes: durationMinutes, config });
    const fitting = filterByMinDuration(subtractIntervals(slots, claimedIntervals), durationMinutes);
    if (fitting.length === 0) {
      result.skippedNoSlot++;
      continue;
    }

    const chosenStart = fitting[0].start;
    const chosenEnd = chosenStart + durationMs;

    const proposal = await createProposedChange({
      change_type: 'move',
      category: candidate.category,
      source_system: 'ai-engine',
      target_event_id: candidate.eventId,
      proposed_start: new Date(chosenStart).toISOString(),
      proposed_end: new Date(chosenEnd).toISOString(),
      reason: `Rebalanced out of ${rangeStart.toISOString()}–${rangeEnd.toISOString()} to stay under a ${maxBusyMinutes}-minute workload target`,
    });

    result.proposalsCreated++;
    result.proposals.push(proposal);
    minutesToRemove -= durationMinutes;
    result.totalBusyMinutesAfter -= durationMinutes;
    claimedIntervals = mergeIntervals([...claimedIntervals, { start: chosenStart, end: chosenEnd }]);
  }

  result.unmetMinutes = Math.max(0, minutesToRemove);
  return result;
}
