import { supabase } from './supabase';
import type { BurnerEventType } from './eventMetadata';
import { SCHEDULING_RULE_CATEGORIES, type SchedulingRuleRow } from './schedulingRules';
import { normalizeTags } from './normalizeTags';
import { parseTimeOfDay } from './schedulingConfig';
import { ValidationError, NotFoundError } from './proposedChanges';

// The IO half of lib/schedulingRules.ts's split (see that file's top
// comment) — the one function here that actually touches Supabase, kept
// separate so lib/workingHours.ts can import the pure narrowing logic
// without dragging in a Supabase client that isn't configured under vitest.
//
// Every active rule whose scope (category/tag/neither) matches this
// placement — a global rule (no category, no tag) always matches. This is
// "which rules are even in play," not the narrowing itself; a matching rule
// still only actually constrains a given day if its own `weekdays` includes
// that day (see lib/schedulingRules.ts's ruleAppliesToWeekday).
export async function fetchApplicableSchedulingRules(
  category: BurnerEventType | undefined,
  tags: string[]
): Promise<SchedulingRuleRow[]> {
  const { data, error } = await supabase.from('scheduling_rules').select('*').eq('active', true);
  if (error) throw new Error(`scheduling_rules read failed: ${error.message}`);
  const rows = (data ?? []) as SchedulingRuleRow[];
  return rows.filter((rule) => {
    if (rule.category) return rule.category === category;
    if (rule.tag) return tags.includes(rule.tag);
    return true; // global — applies to everything
  });
}

function parseWeekdaysField(raw: unknown): number[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw new ValidationError('"weekdays" must be an array of integers 1-7 (1=Monday..7=Sunday)');
  }
  return [...new Set(raw as number[])].sort((a, b) => a - b);
}

// Not exported, mirroring app/api/scheduling-rules/route.ts's own
// not-exported parseTimeField — this project's convention for direct-insert
// "declaration" resources validates inline rather than through a shared
// throwing validator, kept consistent here.
function parseTimeField(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new ValidationError(`"${field}" must be a string`);
  parseTimeOfDay(raw, field); // throws with a descriptive message if malformed
  return raw.trim();
}

export async function listSchedulingRules(active?: boolean): Promise<SchedulingRuleRow[]> {
  let query = supabase.from('scheduling_rules').select('*').order('created_at', { ascending: false });
  if (active !== undefined) query = query.eq('active', active);

  const { data, error } = await query;
  if (error) throw new Error(`scheduling_rules read failed: ${error.message}`);
  return data as SchedulingRuleRow[];
}

export interface CreateSchedulingRuleInput {
  name?: string | null;
  category?: BurnerEventType | null;
  tag?: string | null;
  starts_after?: string | null;
  starts_before?: string | null;
  weekdays?: number[] | null;
}

// Lifted verbatim from app/api/scheduling-rules/route.ts's POST handler —
// prerequisite refactor for the NL chat layer's create_scheduling_rule tool
// (see lib/tasksWrite.ts's comment for the shared rationale).
export async function createSchedulingRule(input: CreateSchedulingRuleInput): Promise<SchedulingRuleRow> {
  if (input.category !== undefined && input.category !== null && !SCHEDULING_RULE_CATEGORIES.includes(input.category)) {
    throw new ValidationError(`"category" must be one of ${SCHEDULING_RULE_CATEGORIES.join(', ')}, or null`);
  }
  const tag = input.tag !== undefined && input.tag !== null ? normalizeTags([input.tag])[0] : null;
  if (input.tag !== undefined && input.tag !== null && !tag) {
    throw new ValidationError('"tag" must be a non-empty string if provided');
  }
  if (input.category && tag) {
    throw new ValidationError('A rule can target "category" or "tag", not both — use two rules, or omit one');
  }

  const startsAfter = parseTimeField(input.starts_after, 'starts_after');
  const startsBefore = parseTimeField(input.starts_before, 'starts_before');
  if (!startsAfter && !startsBefore) {
    throw new ValidationError('At least one of "starts_after"/"starts_before" is required');
  }
  if (startsAfter && startsBefore && startsBefore <= startsAfter) {
    throw new ValidationError(
      '"starts_before" must be later than "starts_after" (overnight time-of-day windows are not supported)'
    );
  }

  const weekdays = parseWeekdaysField(input.weekdays);
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : null;

  const { data, error } = await supabase
    .from('scheduling_rules')
    .insert({
      name,
      category: input.category ?? null,
      tag,
      starts_after: startsAfter,
      starts_before: startsBefore,
      weekdays,
      active: true,
    })
    .select('*')
    .single();

  if (error) throw new Error(`scheduling_rules insert failed: ${error.message}`);
  return data as SchedulingRuleRow;
}

export interface UpdateSchedulingRuleInput {
  name?: string | null;
  category?: BurnerEventType | null;
  tag?: string | null;
  starts_after?: string | null;
  starts_before?: string | null;
  weekdays?: number[] | null;
  active?: boolean;
}

// Lifted verbatim from app/api/scheduling-rules/[id]/route.ts's PATCH
// handler — this is the pause mechanism (active:false) too; there is
// deliberately no delete.
export async function updateSchedulingRule(
  id: string,
  input: UpdateSchedulingRuleInput
): Promise<SchedulingRuleRow> {
  const patch: Record<string, unknown> = {};

  if (input.name !== undefined) {
    patch.name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : null;
  }

  if (input.category !== undefined) {
    if (input.category !== null && !SCHEDULING_RULE_CATEGORIES.includes(input.category)) {
      throw new ValidationError(`"category" must be one of ${SCHEDULING_RULE_CATEGORIES.join(', ')}, or null`);
    }
    patch.category = input.category;
  }

  if (input.tag !== undefined) {
    const tag = input.tag !== null ? normalizeTags([input.tag])[0] : null;
    if (input.tag !== null && !tag) {
      throw new ValidationError('"tag" must be a non-empty string if provided');
    }
    patch.tag = tag;
  }

  if (patch.category && patch.tag) {
    throw new ValidationError('A rule can target "category" or "tag", not both — use two rules, or omit one');
  }

  if (input.starts_after !== undefined) {
    patch.starts_after = input.starts_after === null ? null : parseTimeField(input.starts_after, 'starts_after');
  }
  if (input.starts_before !== undefined) {
    patch.starts_before = input.starts_before === null ? null : parseTimeField(input.starts_before, 'starts_before');
  }
  if (
    typeof patch.starts_after === 'string' &&
    typeof patch.starts_before === 'string' &&
    patch.starts_before <= patch.starts_after
  ) {
    throw new ValidationError(
      '"starts_before" must be later than "starts_after" (overnight time-of-day windows are not supported)'
    );
  }

  if (input.weekdays !== undefined) {
    patch.weekdays = input.weekdays === null ? null : parseWeekdaysField(input.weekdays);
  }

  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') {
      throw new ValidationError('"active" must be a boolean');
    }
    patch.active = input.active;
  }

  if (Object.keys(patch).length === 0) {
    throw new ValidationError(
      'At least one of name, category, tag, starts_after, starts_before, weekdays, active is required'
    );
  }

  const { data, error } = await supabase.from('scheduling_rules').update(patch).eq('id', id).select('*');
  if (error) throw new Error(`scheduling_rules update failed: ${error.message}`);
  if (!data || data.length === 0) throw new NotFoundError(`No scheduling rule with id "${id}"`);
  return data[0] as SchedulingRuleRow;
}
