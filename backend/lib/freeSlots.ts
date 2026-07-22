import { getSchedulingConfig, type SchedulingConfig } from './schedulingConfig';
import { generateWorkingWindows } from './workingHours';
import { fetchBusyIntervals, type BusyInterval } from './busyIntervals';
import { mergeIntervals, subtractIntervals, filterByMinDuration, intervalsOverlap, type Interval } from './intervals';

export interface FindFreeSlotsOptions {
  minDurationMinutes?: number;
  paddingMinutes?: number;
  config?: SchedulingConfig;
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
  const windows = generateWorkingWindows(rangeStart, rangeEnd, config);

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
