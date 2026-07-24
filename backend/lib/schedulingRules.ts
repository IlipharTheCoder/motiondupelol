// Side-effect-free by design (mirrors lib/recurringOccurrences.ts's split
// from lib/recurringEvents.ts, and lib/habitSpacing.ts's split from
// lib/habitPlacement.ts) — this file must never import lib/supabase.ts.
// lib/workingHours.ts (a pure module with its own unit tests, no Supabase
// env vars available under vitest) imports narrowDayWindowByRules directly;
// the first version of this split put fetchApplicableSchedulingRules here
// too and broke lib/workingHours.test.ts with "supabaseUrl is required" —
// see lib/schedulingRulesQuery.ts for the IO half.
import { DateTime } from 'luxon';
import { parseTimeOfDay } from './schedulingConfig';
import { BURNER_EVENT_TYPES, type BurnerEventType } from './eventMetadata';
import type { Interval } from './intervals';

export interface SchedulingRuleRow {
  id: string;
  name: string | null;
  category: BurnerEventType | null;
  tag: string | null;
  starts_after: string | null; // "HH:mm", local to HOME_TIMEZONE
  starts_before: string | null; // "HH:mm", local to HOME_TIMEZONE, exclusive
  weekdays: number[] | null; // Luxon weekday numbers, 1=Monday..7=Sunday; null/empty = every day
  active: boolean;
  created_at: string;
  updated_at: string;
}

export const SCHEDULING_RULE_CATEGORIES: BurnerEventType[] = BURNER_EVENT_TYPES;

export function ruleAppliesToWeekday(rule: SchedulingRuleRow, weekday: number): boolean {
  return !rule.weekdays || rule.weekdays.length === 0 || rule.weekdays.includes(weekday);
}

// Narrows one calendar day's already-computed working-hours window by every
// rule that applies to that weekday — an AND-intersection (confirmed
// combination semantics), never a widening: every matching rule only ever
// pulls `start` later or `end` earlier. A rule missing one bound only
// constrains the side it has (e.g. `starts_after` alone never touches the
// day's own end). Returns null if the intersection collapses to empty —
// the whole day contributes no free time once narrowed.
//
// `dayLocal` must be the local midnight of the same calendar day `dayWindow`
// falls on (`generateWorkingWindows`'s own `cursor`) — HH:mm bounds are
// resolved against it exactly like `workingHoursStart`/`End` already are,
// same DST-safe per-day resolution, no independent timezone math here.
export function narrowDayWindowByRules(
  dayWindow: Interval,
  weekday: number,
  rules: SchedulingRuleRow[],
  dayLocal: DateTime
): Interval | null {
  let start = dayWindow.start;
  let end = dayWindow.end;

  for (const rule of rules) {
    if (!ruleAppliesToWeekday(rule, weekday)) continue;
    if (rule.starts_after) {
      const t = parseTimeOfDay(rule.starts_after, `scheduling_rules.starts_after (rule "${rule.id}")`);
      const boundMs = dayLocal.set({ hour: t.hour, minute: t.minute, second: 0, millisecond: 0 }).toMillis();
      start = Math.max(start, boundMs);
    }
    if (rule.starts_before) {
      const t = parseTimeOfDay(rule.starts_before, `scheduling_rules.starts_before (rule "${rule.id}")`);
      const boundMs = dayLocal.set({ hour: t.hour, minute: t.minute, second: 0, millisecond: 0 }).toMillis();
      end = Math.min(end, boundMs);
    }
  }

  if (end <= start) return null;
  return { start, end };
}

export interface RuleViolation {
  rule: SchedulingRuleRow;
  message: string;
}

// The write-time gate (lib/proposedChanges.ts's applyProposedChange) checks
// a single explicit instant against each applicable rule directly, rather
// than reusing narrowDayWindowByRules's interval-narrowing — simpler, and
// gives a precise, attributable "which rule, why" message instead of just
// "somewhere outside the allowed window."
export function checkCandidateAgainstRules(
  candidateStart: Date,
  rules: SchedulingRuleRow[],
  homeTimezone: string
): RuleViolation | null {
  const startLocal = DateTime.fromJSDate(candidateStart, { zone: homeTimezone });
  const weekday = startLocal.weekday;
  const startMinutes = startLocal.hour * 60 + startLocal.minute;
  const scopeLabel = (rule: SchedulingRuleRow) =>
    rule.category ? ` (category "${rule.category}")` : rule.tag ? ` (tag "${rule.tag}")` : '';

  for (const rule of rules) {
    if (!ruleAppliesToWeekday(rule, weekday)) continue;

    if (rule.starts_after) {
      const t = parseTimeOfDay(rule.starts_after, `scheduling_rules.starts_after (rule "${rule.id}")`);
      if (startMinutes < t.hour * 60 + t.minute) {
        return {
          rule,
          message: `Violates scheduling rule${rule.name ? ` "${rule.name}"` : ` ${rule.id}`}${scopeLabel(rule)}: nothing may start before ${rule.starts_after} local time.`,
        };
      }
    }
    if (rule.starts_before) {
      const t = parseTimeOfDay(rule.starts_before, `scheduling_rules.starts_before (rule "${rule.id}")`);
      if (startMinutes >= t.hour * 60 + t.minute) {
        return {
          rule,
          message: `Violates scheduling rule${rule.name ? ` "${rule.name}"` : ` ${rule.id}`}${scopeLabel(rule)}: nothing may start at or after ${rule.starts_before} local time.`,
        };
      }
    }
  }

  return null;
}
