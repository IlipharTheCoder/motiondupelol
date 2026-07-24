import { DateTime } from 'luxon';
import type { SchedulingConfig } from './schedulingConfig';

export interface PeriodRange {
  periodStart: Date;
  periodEnd: Date;
}

// Monday 00:00 through the following Monday 00:00, in HOME_TIMEZONE.
export function getCurrentWeekRange(config: SchedulingConfig, now: Date = new Date()): PeriodRange {
  const start = DateTime.fromJSDate(now, { zone: config.homeTimezone }).startOf('week');
  return { periodStart: start.toJSDate(), periodEnd: start.plus({ weeks: 1 }).toJSDate() };
}

// The 1st of the month 00:00 through the 1st of the next month 00:00, in
// HOME_TIMEZONE.
export function getCurrentMonthRange(config: SchedulingConfig, now: Date = new Date()): PeriodRange {
  const start = DateTime.fromJSDate(now, { zone: config.homeTimezone }).startOf('month');
  return { periodStart: start.toJSDate(), periodEnd: start.plus({ months: 1 }).toJSDate() };
}

// Midnight through the following midnight, in HOME_TIMEZONE.
export function getCurrentDayRange(config: SchedulingConfig, now: Date = new Date()): PeriodRange {
  const start = DateTime.fromJSDate(now, { zone: config.homeTimezone }).startOf('day');
  return { periodStart: start.toJSDate(), periodEnd: start.plus({ days: 1 }).toJSDate() };
}

// 'interval' (every-N-days) cadence isn't a fixed calendar period — it rolls
// forward from a habit's own last occurrence, so it's computed separately in
// lib/habitPlacement.ts rather than through this function. See
// backend-build-order.md item 21.
export type Cadence = 'weekly' | 'monthly' | 'daily';

export function getCurrentPeriodRange(
  cadence: Cadence,
  config: SchedulingConfig,
  now: Date = new Date()
): PeriodRange {
  if (cadence === 'weekly') return getCurrentWeekRange(config, now);
  if (cadence === 'monthly') return getCurrentMonthRange(config, now);
  return getCurrentDayRange(config, now);
}
