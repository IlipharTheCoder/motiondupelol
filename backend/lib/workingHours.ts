import { DateTime } from 'luxon';
import type { Interval } from './intervals';
import { getSchedulingConfig, type SchedulingConfig } from './schedulingConfig';

// Iterates calendar days *in the home timezone* (via `.plus({ days: 1 })`,
// never raw 24h-ms increments) so DST days — which are 23 or 25 hours long
// in UTC terms — never desync the loop. For each working day, the same
// local `10:00`/`18:00` (or whatever's configured) wall-clock spec is
// resolved to a UTC instant independently per day; this is what makes the
// window correctly shift by an hour across a DST transition with zero
// special-casing.
export function generateWorkingWindows(
  rangeStart: Date,
  rangeEnd: Date,
  config: SchedulingConfig = getSchedulingConfig()
): Interval[] {
  const rangeStartMs = rangeStart.getTime();
  const rangeEndMs = rangeEnd.getTime();
  if (rangeEndMs <= rangeStartMs) return [];

  const windows: Interval[] = [];
  const lastDay = DateTime.fromJSDate(rangeEnd, { zone: config.homeTimezone }).startOf('day');
  let cursor = DateTime.fromJSDate(rangeStart, { zone: config.homeTimezone }).startOf('day');

  while (cursor.toMillis() <= lastDay.toMillis()) {
    if (config.workingDays.includes(cursor.weekday)) {
      const windowStart = cursor.set({
        hour: config.workingHoursStart.hour,
        minute: config.workingHoursStart.minute,
        second: 0,
        millisecond: 0,
      });
      const windowEnd = cursor.set({
        hour: config.workingHoursEnd.hour,
        minute: config.workingHoursEnd.minute,
        second: 0,
        millisecond: 0,
      });

      const clippedStart = Math.max(windowStart.toMillis(), rangeStartMs);
      const clippedEnd = Math.min(windowEnd.toMillis(), rangeEndMs);

      if (clippedEnd > clippedStart) {
        windows.push({ start: clippedStart, end: clippedEnd });
      }
    }

    cursor = cursor.plus({ days: 1 });
  }

  return windows;
}
