import { DateTime } from 'luxon';
import type { SchedulingConfig } from './schedulingConfig';

// Sanity ceiling on a single request — not a product limit, just a guard
// against a runaway generation (e.g. an "until" decades out). Weekly for 5
// years is comfortably beyond any real use case this feature targets.
export const MAX_OCCURRENCES = 260;

export interface RecurringOccurrence {
  start: string;
  end: string;
}

// Weekly (or every-N-weeks) recurrence, anchored to firstStart's own weekday
// and time-of-day. Interval math happens in HOME_TIMEZONE via Luxon's
// zone-aware plus(), not raw millisecond arithmetic, so "7pm every Thursday"
// stays 7pm local across a DST transition between occurrences — same
// DST-correctness requirement lib/workingHours.ts already meets for working
// hours. `firstStart`/`firstEnd` are parsed with their own embedded
// offset/zone (same as every other proposed_start/proposed_end in this
// backend) and represented in HOME_TIMEZONE for that arithmetic.
//
// Kept in its own file with no side-effecting imports (mirrors
// lib/habitSpacing.ts vs. lib/habitPlacement.ts) so it's unit-testable
// without pulling in lib/proposedChanges.ts's Supabase client.
export function generateWeeklyOccurrences(
  firstStart: string,
  firstEnd: string,
  intervalWeeks: number,
  config: SchedulingConfig,
  count?: number,
  until?: string
): { occurrences: RecurringOccurrence[]; truncated: boolean } {
  const start = DateTime.fromISO(firstStart, { zone: config.homeTimezone });
  const end = DateTime.fromISO(firstEnd, { zone: config.homeTimezone });
  if (!start.isValid || !end.isValid) {
    throw new Error('"first_start"/"first_end" must be valid ISO datetimes');
  }
  if (end.toMillis() <= start.toMillis()) {
    throw new Error('"first_end" must be later than "first_start"');
  }
  const durationMs = end.toMillis() - start.toMillis();

  let untilDT: DateTime | null = null;
  if (until !== undefined) {
    untilDT = DateTime.fromISO(until, { zone: config.homeTimezone });
    if (!untilDT.isValid) {
      throw new Error('"until" must be a valid ISO datetime');
    }
  }

  const occurrences: RecurringOccurrence[] = [];
  let current = start;
  let truncated = false;

  while (true) {
    if (count !== undefined && occurrences.length >= count) break;
    if (untilDT && current > untilDT) break;
    if (occurrences.length >= MAX_OCCURRENCES) {
      truncated = true;
      break;
    }

    occurrences.push({
      start: current.toISO()!,
      end: current.plus({ milliseconds: durationMs }).toISO()!,
    });
    current = current.plus({ weeks: intervalWeeks });
  }

  return { occurrences, truncated };
}
