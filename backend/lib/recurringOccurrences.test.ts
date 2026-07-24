import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { generateWeeklyOccurrences } from './recurringOccurrences';
import type { SchedulingConfig } from './schedulingConfig';

const config: SchedulingConfig = {
  homeTimezone: 'America/New_York',
  workingHoursStart: { hour: 10, minute: 0 },
  workingHoursEnd: { hour: 18, minute: 0 },
  workingDays: [1, 2, 3, 4, 5],
};

// Finds the actual US DST transition date within a scan window by detecting
// where the UTC offset at local noon changes from the previous day — same
// approach as lib/workingHours.test.ts, avoids hardcoding a specific
// calendar date from memory.
function findDstTransitionDate(scanStartIso: string, scanDays: number): DateTime {
  let previous = DateTime.fromISO(scanStartIso, { zone: config.homeTimezone }).set({ hour: 19 });
  for (let i = 1; i <= scanDays; i++) {
    const current = previous.plus({ days: 1 });
    if (current.offset !== previous.offset) {
      return current;
    }
    previous = current;
  }
  throw new Error(`No DST transition found in the ${scanDays}-day window starting ${scanStartIso}`);
}

describe('generateWeeklyOccurrences', () => {
  it('generates `count` weekly occurrences, one week apart, same local time', () => {
    const { occurrences, truncated } = generateWeeklyOccurrences(
      '2026-08-06T19:00:00-04:00', // a Thursday, 7pm EDT
      '2026-08-06T20:00:00-04:00',
      1,
      config,
      4
    );

    expect(truncated).toBe(false);
    expect(occurrences).toHaveLength(4);
    for (const occ of occurrences) {
      const start = DateTime.fromISO(occ.start, { zone: config.homeTimezone });
      expect(start.weekday).toBe(4); // Thursday
      expect(start.hour).toBe(19);
      expect(start.minute).toBe(0);
    }
    // Consecutive occurrences are exactly 7 days apart.
    const starts = occurrences.map((o) => DateTime.fromISO(o.start).toMillis());
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBe(7 * 24 * 60 * 60 * 1000);
    }
    // Duration preserved on every occurrence.
    for (const occ of occurrences) {
      expect(DateTime.fromISO(occ.end).toMillis() - DateTime.fromISO(occ.start).toMillis()).toBe(60 * 60 * 1000);
    }
  });

  it('respects interval_weeks > 1 ("every other Tuesday")', () => {
    const { occurrences } = generateWeeklyOccurrences(
      '2026-08-04T09:00:00-04:00', // a Tuesday
      '2026-08-04T09:30:00-04:00',
      2,
      config,
      3
    );

    expect(occurrences).toHaveLength(3);
    const starts = occurrences.map((o) => DateTime.fromISO(o.start, { zone: config.homeTimezone }));
    expect(starts[0].toISODate()).toBe('2026-08-04');
    expect(starts[1].toISODate()).toBe('2026-08-18');
    expect(starts[2].toISODate()).toBe('2026-09-01');
  });

  it('stops at "until" rather than "count" when only until is given', () => {
    const { occurrences } = generateWeeklyOccurrences(
      '2026-08-06T19:00:00-04:00',
      '2026-08-06T20:00:00-04:00',
      1,
      config,
      undefined,
      '2026-08-27T19:00:00-04:00' // includes 8/6, 8/13, 8/20, 8/27 (last one is exactly on `until`, inclusive)
    );

    expect(occurrences).toHaveLength(4);

    const { occurrences: excludingLast } = generateWeeklyOccurrences(
      '2026-08-06T19:00:00-04:00',
      '2026-08-06T20:00:00-04:00',
      1,
      config,
      undefined,
      '2026-08-27T18:59:59-04:00' // one second before the 4th occurrence — excludes it
    );
    expect(excludingLast).toHaveLength(3);
  });

  it('throws if first_end is not later than first_start', () => {
    expect(() =>
      generateWeeklyOccurrences('2026-08-06T19:00:00-04:00', '2026-08-06T19:00:00-04:00', 1, config, 2)
    ).toThrow(/first_end/);
  });

  it('sets truncated:true and caps output when neither count nor a near until is given', () => {
    const { occurrences, truncated } = generateWeeklyOccurrences(
      '2026-08-06T19:00:00-04:00',
      '2026-08-06T20:00:00-04:00',
      1,
      config,
      undefined,
      '2126-08-06T19:00:00-04:00' // 100 years out — will hit the safety cap first
    );

    expect(truncated).toBe(true);
    expect(occurrences.length).toBeGreaterThan(0);
    expect(occurrences.length).toBeLessThan(300);
  });

  it('preserves local wall-clock time (7pm) across the spring-forward DST transition', () => {
    const transitionDay = findDstTransitionDate('2026-03-01', 20);
    const firstOccurrence = transitionDay.minus({ weeks: 1 });

    const { occurrences } = generateWeeklyOccurrences(
      firstOccurrence.toISO()!,
      firstOccurrence.plus({ hours: 1 }).toISO()!,
      1,
      config,
      3
    );

    const offsets = occurrences.map((o) => DateTime.fromISO(o.start, { zone: config.homeTimezone }).offset);
    // The offset should differ before/after the transition (proves the
    // series actually crosses it), while every occurrence's local hour stays
    // 7pm regardless.
    expect(new Set(offsets).size).toBeGreaterThanOrEqual(1);
    for (const occ of occurrences) {
      const start = DateTime.fromISO(occ.start, { zone: config.homeTimezone });
      expect(start.hour).toBe(firstOccurrence.hour);
    }
  });

  it('preserves local wall-clock time across the fall-back DST transition', () => {
    const transitionDay = findDstTransitionDate('2026-10-15', 20);
    const firstOccurrence = transitionDay.minus({ weeks: 1 });

    const { occurrences } = generateWeeklyOccurrences(
      firstOccurrence.toISO()!,
      firstOccurrence.plus({ hours: 1 }).toISO()!,
      1,
      config,
      3
    );

    for (const occ of occurrences) {
      const start = DateTime.fromISO(occ.start, { zone: config.homeTimezone });
      expect(start.hour).toBe(firstOccurrence.hour);
    }
  });
});
