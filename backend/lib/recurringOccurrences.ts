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

// Weekly (or every-N-weeks) recurrence, anchored to firstStart's own
// time-of-day (and, absent `weekdays`, its own weekday too). Interval math
// happens in HOME_TIMEZONE via Luxon's zone-aware plus(), not raw
// millisecond arithmetic, so "7pm every Thursday" stays 7pm local across a
// DST transition between occurrences — same DST-correctness requirement
// lib/workingHours.ts already meets for working hours. `firstStart`/
// `firstEnd` are parsed with their own embedded offset/zone (same as every
// other proposed_start/proposed_end in this backend) and represented in
// HOME_TIMEZONE for that arithmetic.
//
// `weekdays` (Phase 3.5 item 32, 1=Monday..7=Sunday, same convention as
// lib/schedulingRules.ts's SchedulingRuleRow.weekdays and WORKING_DAYS) —
// omitted/empty defaults to `[firstStart's own weekday]`, which reduces to
// exactly the original single-weekday behavior (every existing caller/test
// is unaffected). Given explicitly (e.g. [1,3,5] for "MWF"), every listed
// weekday gets an occurrence each active week, all at firstStart's own
// time-of-day; `intervalWeeks` skips whole weeks, not individual weekdays —
// "every other week, MWF" means 3 occurrences in each active week, none in
// the week between. `count` counts real (non-skipped) occurrences across
// every weekday combined, not per-weekday.
//
// `skipDates` (item 32, "skip the last week of the month") — an occurrence
// whose local calendar date matches an entry is dropped and does NOT count
// toward `count`; generation keeps going to find enough *real* occurrences,
// bounded by `MAX_OCCURRENCES` counted against candidates *scanned* (not
// just kept), so an absurd skip list can't spin this into an infinite loop.
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
  until?: string,
  weekdays?: number[],
  skipDates?: string[]
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

  for (const d of skipDates ?? []) {
    if (!DateTime.fromISO(d).isValid) {
      throw new Error(`"skip_dates" entry "${d}" is not a valid ISO date`);
    }
  }
  const skipSet = new Set(skipDates ?? []);

  const activeWeekdays =
    weekdays && weekdays.length > 0 ? [...new Set(weekdays)].sort((a, b) => a - b) : [start.weekday];

  const occurrences: RecurringOccurrence[] = [];
  let truncated = false;
  let candidatesScanned = 0;
  let weekStart = start.startOf('week');

  outer: while (true) {
    for (const weekday of activeWeekdays) {
      if (count !== undefined && occurrences.length >= count) break outer;
      if (candidatesScanned >= MAX_OCCURRENCES) {
        truncated = true;
        break outer;
      }

      const candidate = weekStart.plus({ days: weekday - 1 }).set({
        hour: start.hour,
        minute: start.minute,
        second: start.second,
        millisecond: start.millisecond,
      });

      if (candidate.toMillis() < start.toMillis()) continue; // before the series' own start
      if (untilDT && candidate > untilDT) break outer;

      candidatesScanned++;
      if (skipSet.has(candidate.toISODate()!)) continue; // doesn't count toward `count`

      occurrences.push({
        start: candidate.toISO()!,
        end: candidate.plus({ milliseconds: durationMs }).toISO()!,
      });
    }
    weekStart = weekStart.plus({ weeks: intervalWeeks });
  }

  return { occurrences, truncated };
}
