import { getSchedulingConfig, type SchedulingConfig } from './schedulingConfig';
import { generateWorkingWindows } from './workingHours';
import { fetchBusyIntervals, type BusyInterval } from './busyIntervals';
import { mergeIntervals, subtractIntervals, filterByMinDuration, intervalsOverlap, type Interval } from './intervals';
import { fetchApplicableSchedulingRules } from './schedulingRulesQuery';
import type { BurnerEventType } from './eventMetadata';

export interface FindFreeSlotsOptions {
  minDurationMinutes?: number;
  paddingMinutes?: number;
  config?: SchedulingConfig;
  // Phase 3.5 item 30 — what's being placed, so standing scheduling_rules
  // scoped to a category/tag can narrow the search. Omitting both still
  // applies any *global* (no category/tag) active rule — only
  // category/tag-scoped rules need these to match.
  category?: BurnerEventType;
  tags?: string[];
  // NL chat's find_free_time only (2026-07-25) — skips working-hours windows
  // and scheduling_rules entirely, treating the whole requested range as one
  // open window before subtracting real busy time. The user explicitly
  // wants chat's free-time search unrestricted ("everything is fair game")
  // and trusts the model's own judgment for what's a reasonable time to
  // suggest, rather than a hard algorithmic filter. Every other caller
  // (habits, Focus Time, auto-reschedule, day-rebalance, bump-relocation,
  // GET /api/calendar/free-slots) never sets this — they keep placing things
  // only in rule-compliant windows.
  ignoreWorkingHoursAndRules?: boolean;
}

export interface FindFreeSlotsResult {
  slots: Interval[];
  rangeStart: string;
  rangeEnd: string;
}

export async function findFreeSlots(
  rangeStart: Date,
  rangeEnd: Date,
  options: FindFreeSlotsOptions = {}
): Promise<FindFreeSlotsResult> {
  if (rangeEnd.getTime() <= rangeStart.getTime()) {
    throw new Error('rangeEnd must be later than rangeStart');
  }

  const config = options.config ?? getSchedulingConfig();
  const windows = options.ignoreWorkingHoursAndRules
    ? [{ start: rangeStart.getTime(), end: rangeEnd.getTime() }]
    : generateWorkingWindows(
        rangeStart,
        rangeEnd,
        config,
        await fetchApplicableSchedulingRules(options.category, options.tags ?? [])
      );

  if (windows.length === 0) {
    return { slots: [], rangeStart: rangeStart.toISOString(), rangeEnd: rangeEnd.toISOString() };
  }

  const busy = await fetchBusyIntervals(rangeStart, rangeEnd, { paddingMinutes: options.paddingMinutes }, config);
  const mergedBusy = mergeIntervals(busy);
  const free = subtractIntervals(windows, mergedBusy);
  const filtered = options.minDurationMinutes ? filterByMinDuration(free, options.minDurationMinutes) : free;

  return {
    slots: filtered,
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
  };
}

export interface DetectConflictsOptions {
  excludeEventId?: string;
  paddingMinutes?: number;
  config?: SchedulingConfig;
}

export interface DetectConflictsResult {
  hasConflict: boolean;
  conflicts: BusyInterval[];
}

// Deliberately does not consult working hours at all — conflict detection
// is pure calendar-overlap, not a business-hours policy question.
export async function detectConflicts(
  candidateStart: Date,
  candidateEnd: Date,
  options: DetectConflictsOptions = {}
): Promise<DetectConflictsResult> {
  if (candidateEnd.getTime() <= candidateStart.getTime()) {
    throw new Error('candidateEnd must be later than candidateStart');
  }

  const config = options.config ?? getSchedulingConfig();
  const busy = await fetchBusyIntervals(
    candidateStart,
    candidateEnd,
    { paddingMinutes: options.paddingMinutes },
    config
  );

  const candidate: Interval = { start: candidateStart.getTime(), end: candidateEnd.getTime() };
  const conflicts = busy.filter(
    (interval) => interval.eventId !== options.excludeEventId && intervalsOverlap(interval, candidate)
  );

  return { hasConflict: conflicts.length > 0, conflicts };
}
