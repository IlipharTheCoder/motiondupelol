import { PRIORITY_RANK, type EventPriority } from './eventMetadata';
import type { Cadence } from './periodRanges';

// 'interval' (every-N-days) is a superset addition over the fixed-calendar-
// period cadences in lib/periodRanges.ts — see habits_interval_requires_days
// in backend-schema.md and lib/habitPlacement.ts's rolling-anchor logic.
export type HabitCadence = Cadence | 'interval';
export const HABIT_CADENCES: HabitCadence[] = ['weekly', 'monthly', 'daily', 'interval'];

export type HabitStatus = 'active' | 'paused';
export const HABIT_STATUSES: HabitStatus[] = ['active', 'paused'];

// Yielding-stance default, per the user — opposite of Focus Time's 'high'
// auto-defend. Resolved only at use-time (proposal creation, ranking), never
// backfilled into the column at insert time, same reasoning as
// tasks.duration_minutes's resolve-not-backfill pattern (lib/aiTasks.ts).
export const DEFAULT_HABIT_PRIORITY: EventPriority = 'low';

const DEFAULT_HABIT_OCCURRENCE_DURATION_MINUTES = 30;

// Same "sane universal fallback, resolved lazily rather than backfilled"
// pattern as lib/aiTasks.ts's getDefaultTaskDurationMinutes — added per
// backend-build-order.md item 21, so a habit declared without a duration
// (e.g. from a future NL layer that never stated one) still has somewhere to
// fall back to instead of being required at creation time.
export function getDefaultHabitOccurrenceDurationMinutes(): number {
  const raw = process.env.HABIT_DEFAULT_OCCURRENCE_DURATION_MINUTES?.trim();
  const value = raw ? Number(raw) : DEFAULT_HABIT_OCCURRENCE_DURATION_MINUTES;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `HABIT_DEFAULT_OCCURRENCE_DURATION_MINUTES must be a positive number (got "${raw}")`
    );
  }
  return value;
}

export function resolveHabitOccurrenceDurationMinutes(habit: HabitRow): number {
  return habit.occurrence_duration_minutes ?? getDefaultHabitOccurrenceDurationMinutes();
}

export interface HabitRow {
  id: string;
  title: string;
  description: string | null;
  cadence: HabitCadence;
  interval_days: number | null;
  target_count: number;
  occurrence_duration_minutes: number | null;
  priority: EventPriority | null;
  tags: string[] | null;
  status: HabitStatus;
  created_at: string;
  updated_at: string;
}

export function resolveHabitPriority(habit: HabitRow): EventPriority {
  return habit.priority ?? DEFAULT_HABIT_PRIORITY;
}

// Hours of period remaining per still-needed occurrence — confirmed formula:
// a habit needing 3 more sessions with 2 days left is more urgent than one
// needing 1 more with 2 days left, not just "however soon the period ends."
// Already-satisfied (0 remaining) is Infinity — least urgent, nothing left
// to place.
export function habitUrgencyHoursPerOccurrence(
  periodEnd: Date,
  occurrencesRemaining: number,
  now: Date
): number {
  if (occurrencesRemaining <= 0) return Infinity;
  const hoursLeft = Math.max(0, (periodEnd.getTime() - now.getTime()) / 3_600_000);
  return hoursLeft / occurrencesRemaining;
}

export interface HabitPlacementContext {
  habit: HabitRow;
  periodStart: Date;
  periodEnd: Date;
  occurrencesSatisfied: number;
  occurrencesRemaining: number;
}

// Priority tier always wins (lower PRIORITY_RANK number = more important),
// full stop — urgency only breaks ties within the same tier. Same
// lexicographic shape as lib/aiTasks.ts's compareTasksByPriorityScore, and
// same deliberate choice: a future method that lets urgency override tier is
// a distinct, explicitly-deferred item, not built here.
export function compareHabitsByUrgency(
  a: HabitPlacementContext,
  b: HabitPlacementContext,
  now: Date
): number {
  const rankDiff = PRIORITY_RANK[resolveHabitPriority(a.habit)] - PRIORITY_RANK[resolveHabitPriority(b.habit)];
  if (rankDiff !== 0) return rankDiff;
  const urgencyDiff =
    habitUrgencyHoursPerOccurrence(a.periodEnd, a.occurrencesRemaining, now) -
    habitUrgencyHoursPerOccurrence(b.periodEnd, b.occurrencesRemaining, now);
  if (urgencyDiff !== 0) return urgencyDiff;
  return a.habit.id.localeCompare(b.habit.id);
}
