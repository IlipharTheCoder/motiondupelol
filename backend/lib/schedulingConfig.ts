import { DateTime } from 'luxon';

export interface TimeOfDay {
  hour: number;
  minute: number;
}

export interface SchedulingConfig {
  homeTimezone: string;
  workingHoursStart: TimeOfDay;
  workingHoursEnd: TimeOfDay;
  workingDays: number[]; // Luxon weekday numbers, 1=Monday..7=Sunday
}

const DEFAULT_HOME_TIMEZONE = 'America/New_York';
const DEFAULT_WORKING_HOURS_START: TimeOfDay = { hour: 10, minute: 0 };
const DEFAULT_WORKING_HOURS_END: TimeOfDay = { hour: 18, minute: 0 };
const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];

export function parseTimeOfDay(raw: string, envVarName: string): TimeOfDay {
  const match = /^([0-9]{1,2}):([0-9]{2})$/.exec(raw.trim());
  if (!match) {
    throw new Error(`${envVarName}="${raw}" is not a valid HH:mm time string`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`${envVarName}="${raw}" is out of range (expected 00:00-23:59)`);
  }

  return { hour, minute };
}

function parseWorkingDays(raw: string, envVarName: string): number[] {
  const days = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const day = Number(entry);
      if (!Number.isInteger(day) || day < 1 || day > 7) {
        throw new Error(`${envVarName}="${raw}" contains an invalid weekday "${entry}" (expected 1-7)`);
      }
      return day;
    });

  return [...new Set(days)].sort((a, b) => a - b);
}

function timeOfDayToMinutes(time: TimeOfDay): number {
  return time.hour * 60 + time.minute;
}

export function getSchedulingConfig(): SchedulingConfig {
  const rawTimezone = process.env.HOME_TIMEZONE?.trim();
  const homeTimezone = rawTimezone || DEFAULT_HOME_TIMEZONE;
  if (!DateTime.now().setZone(homeTimezone).isValid) {
    throw new Error(`HOME_TIMEZONE="${rawTimezone}" is not a valid IANA timezone name`);
  }

  const rawStart = process.env.WORKING_HOURS_START?.trim();
  const workingHoursStart = rawStart
    ? parseTimeOfDay(rawStart, 'WORKING_HOURS_START')
    : DEFAULT_WORKING_HOURS_START;

  const rawEnd = process.env.WORKING_HOURS_END?.trim();
  const workingHoursEnd = rawEnd ? parseTimeOfDay(rawEnd, 'WORKING_HOURS_END') : DEFAULT_WORKING_HOURS_END;

  if (timeOfDayToMinutes(workingHoursEnd) <= timeOfDayToMinutes(workingHoursStart)) {
    throw new Error(
      `WORKING_HOURS_END must be later than WORKING_HOURS_START (got ${rawStart ?? '(default)'}-${rawEnd ?? '(default)'}); overnight working windows are not supported`
    );
  }

  const rawWorkingDays = process.env.WORKING_DAYS?.trim();
  const workingDays = rawWorkingDays
    ? parseWorkingDays(rawWorkingDays, 'WORKING_DAYS')
    : DEFAULT_WORKING_DAYS;
  const effectiveWorkingDays = workingDays.length > 0 ? workingDays : DEFAULT_WORKING_DAYS;

  return {
    homeTimezone,
    workingHoursStart,
    workingHoursEnd,
    workingDays: effectiveWorkingDays,
  };
}
