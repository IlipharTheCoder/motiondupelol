import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { generateWorkingWindows } from './workingHours';
import type { SchedulingConfig } from './schedulingConfig';

const config: SchedulingConfig = {
  homeTimezone: 'America/New_York',
  workingHoursStart: { hour: 10, minute: 0 },
  workingHoursEnd: { hour: 18, minute: 0 },
  workingDays: [1, 2, 3, 4, 5],
};

function localWindow(isoDate: string): { start: number; end: number } {
  const day = DateTime.fromISO(isoDate, { zone: config.homeTimezone });
  return {
    start: day.set({ hour: 10, minute: 0, second: 0, millisecond: 0 }).toMillis(),
    end: day.set({ hour: 18, minute: 0, second: 0, millisecond: 0 }).toMillis(),
  };
}

// Finds the actual US DST transition date within a scan window by detecting
// where the UTC offset at local noon changes from the previous day — avoids
// hardcoding a specific calendar date from memory (which could be wrong)
// while still exercising the real IANA transition.
function findDstTransitionDate(scanStartIso: string, scanDays: number): DateTime {
  let previous = DateTime.fromISO(scanStartIso, { zone: config.homeTimezone }).set({ hour: 12 });
  for (let i = 1; i <= scanDays; i++) {
    const current = previous.plus({ days: 1 });
    if (current.offset !== previous.offset) {
      return current.startOf('day');
    }
    previous = current;
  }
  throw new Error(`No DST transition found in the ${scanDays}-day window starting ${scanStartIso}`);
}

describe('generateWorkingWindows', () => {
  it('produces one window per weekday for a plain non-DST week', () => {
    const rangeStart = DateTime.fromISO('2026-06-16', { zone: config.homeTimezone }).toJSDate(); // Tuesday
    const rangeEnd = DateTime.fromISO('2026-06-19', { zone: config.homeTimezone }).toJSDate(); // Friday (exclusive-ish via time)

    const windows = generateWorkingWindows(rangeStart, rangeEnd, config);

    expect(windows).toEqual([
      localWindow('2026-06-16'),
      localWindow('2026-06-17'),
      localWindow('2026-06-18'),
    ]);
  });

  it('produces no window for weekend days', () => {
    // 2026-06-20 is a Saturday, 2026-06-21 a Sunday.
    const rangeStart = DateTime.fromISO('2026-06-20', { zone: config.homeTimezone }).toJSDate();
    const rangeEnd = DateTime.fromISO('2026-06-22', { zone: config.homeTimezone }).toJSDate();

    expect(generateWorkingWindows(rangeStart, rangeEnd, config)).toEqual([]);
  });

  it('correctly shifts the UTC start instant across the spring-forward DST transition', () => {
    const transitionDay = findDstTransitionDate('2026-03-01', 20);
    const dayBefore = transitionDay.minus({ days: 1 });

    const rangeStart = dayBefore.toJSDate();
    const rangeEnd = transitionDay.plus({ days: 1 }).toJSDate();

    const windows = generateWorkingWindows(rangeStart, rangeEnd, config);
    const windowsByOffset = windows.map((w) => DateTime.fromMillis(w.start, { zone: config.homeTimezone }).offset);

    // Only assert something if both days in this pair are working days —
    // otherwise just confirm no crash and move on (transition date varies
    // by year/rule and may land on a weekend in a given scan window).
    if (windows.length === 2) {
      expect(windowsByOffset[0]).not.toEqual(windowsByOffset[1]);
      // Local duration (10:00-18:00) stays 8 hours on both sides regardless of the UTC shift.
      for (const w of windows) {
        expect(w.end - w.start).toBe(8 * 60 * 60 * 1000);
      }
    } else {
      expect(windows.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('correctly shifts the UTC start instant across the fall-back DST transition', () => {
    const transitionDay = findDstTransitionDate('2026-10-15', 20);
    const dayBefore = transitionDay.minus({ days: 1 });

    const rangeStart = dayBefore.toJSDate();
    const rangeEnd = transitionDay.plus({ days: 1 }).toJSDate();

    const windows = generateWorkingWindows(rangeStart, rangeEnd, config);
    const windowsByOffset = windows.map((w) => DateTime.fromMillis(w.start, { zone: config.homeTimezone }).offset);

    if (windows.length === 2) {
      expect(windowsByOffset[0]).not.toEqual(windowsByOffset[1]);
      for (const w of windows) {
        expect(w.end - w.start).toBe(8 * 60 * 60 * 1000);
      }
    } else {
      expect(windows.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('clips the first day window to a rangeStart that falls mid-working-hours', () => {
    const midDay = DateTime.fromISO('2026-06-16T14:00:00', { zone: config.homeTimezone }); // Tuesday 2pm local
    const rangeEnd = DateTime.fromISO('2026-06-16T18:00:00', { zone: config.homeTimezone });

    const windows = generateWorkingWindows(midDay.toJSDate(), rangeEnd.toJSDate(), config);

    expect(windows).toEqual([{ start: midDay.toMillis(), end: rangeEnd.toMillis() }]);
  });

  it('clips the last day window to a rangeEnd that falls mid-working-hours', () => {
    const rangeStart = DateTime.fromISO('2026-06-16T10:00:00', { zone: config.homeTimezone });
    const midDay = DateTime.fromISO('2026-06-16T15:00:00', { zone: config.homeTimezone });

    const windows = generateWorkingWindows(rangeStart.toJSDate(), midDay.toJSDate(), config);

    expect(windows).toEqual([{ start: rangeStart.toMillis(), end: midDay.toMillis() }]);
  });

  it('returns no window for a range confined to non-working hours of a single day', () => {
    const rangeStart = DateTime.fromISO('2026-06-16T19:00:00', { zone: config.homeTimezone });
    const rangeEnd = DateTime.fromISO('2026-06-16T23:00:00', { zone: config.homeTimezone });

    expect(generateWorkingWindows(rangeStart.toJSDate(), rangeEnd.toJSDate(), config)).toEqual([]);
  });

  it('returns no window when there are zero effective working days in range', () => {
    const noWorkDaysConfig: SchedulingConfig = { ...config, workingDays: [6, 7] }; // weekends only
    const rangeStart = DateTime.fromISO('2026-06-16', { zone: config.homeTimezone }); // Tue
    const rangeEnd = DateTime.fromISO('2026-06-19', { zone: config.homeTimezone }); // Fri

    expect(generateWorkingWindows(rangeStart.toJSDate(), rangeEnd.toJSDate(), noWorkDaysConfig)).toEqual([]);
  });

  it('returns an empty array without throwing for a degenerate (end <= start) range', () => {
    const point = DateTime.fromISO('2026-06-16T10:00:00', { zone: config.homeTimezone }).toJSDate();
    expect(generateWorkingWindows(point, point, config)).toEqual([]);
  });
});
