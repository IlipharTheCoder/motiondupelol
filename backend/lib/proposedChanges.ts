import { randomUUID } from 'crypto';
import { calendar } from './googleCalendar';
import { supabase } from './supabase';
import {
  encodeEventMetadata,
  decodeEventMetadata,
  encodeEventTags,
  decodeEventTags,
  CATEGORY_COLORS,
  EVENT_PRIORITIES,
  BURNER_EVENT_TYPES,
  PRIORITY_RANK,
  type BurnerEventType,
  type SourceSystem,
  type EventPriority,
} from './eventMetadata';
import { detectConflicts, findFreeSlots } from './freeSlots';
import { getSchedulingConfig } from './schedulingConfig';
import { mergeIntervals, subtractIntervals, filterByMinDuration, type Interval } from './intervals';
import type { BusyInterval } from './busyIntervals';
import { normalizeTags } from './normalizeTags';
import { checkCandidateAgainstRules } from './schedulingRules';
import { fetchApplicableSchedulingRules } from './schedulingRulesQuery';

const BURNER_CALENDAR_ID = process.env.GOOGLE_BURNER_CALENDAR_ID!;
const BUMP_SEARCH_HORIZON_DAYS = 14;
// Sanity ceiling on one batch request — not a product limit, just a guard
// against a single call fanning out into an unreasonable number of writes.
// Same "guard, not a real limit" framing as recurringOccurrences.ts's
// MAX_OCCURRENCES.
export const MAX_BATCH_SIZE = 50;

export type ChangeType = 'create' | 'move' | 'update' | 'delete';
export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'failed';
export type DecidedBy = 'user' | 'auto-apply-policy';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export interface ProposedChangeInput {
  change_type: ChangeType;
  category: BurnerEventType;
  flexible?: 'true' | 'false';
  source_system: SourceSystem;
  source_id?: string;
  target_event_id?: string;
  proposed_start?: string;
  proposed_end?: string;
  proposed_summary?: string;
  proposed_description?: string;
  priority?: EventPriority;
  tags?: string[];
  duration_minutes?: number;
  deadline?: string;
  reason?: string;
  bump_if_movable?: boolean;
  ignore_scheduling_rules?: boolean;
}

// Phase 3.5 item 28 ("undo") — a snapshot of only the fields a given
// change_type actually overwrites, taken immediately before the write. A
// `move` only ever touches start/end, so its snapshot leaves every other
// field null; `update`/`delete` capture the full revertible shape since any
// of those fields could have changed. Never client-settable — see the
// `previous_state: null` override in createProposedChange below.
export interface PreviousEventState {
  summary: string | null;
  description: string | null;
  start: string | null;
  end: string | null;
  category: BurnerEventType | null;
  priority: EventPriority | null;
  flexible: 'true' | 'false' | null;
  deadline: string | null;
  tags: string[];
}

export interface ProposedChangeRow extends ProposedChangeInput {
  id: string;
  color_tag: string;
  status: ProposalStatus;
  decided_by: DecidedBy | null;
  decided_at: string | null;
  applied_at: string | null;
  error_message: string | null;
  previous_state: PreviousEventState | null;
  proposal_group_id: string | null;
  created_at: string;
  updated_at: string;
}

// Guards the `tasks` link-back side effects below — `source_id` on a 'task'
// create/update isn't always a `tasks.id` (e.g. the Todoist intake shape
// uses it for Todoist's own external id), so only attempt the tasks-table
// update when it's actually UUID-shaped.
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

const CHANGE_TYPES: ChangeType[] = ['create', 'move', 'update', 'delete'];

export function validateProposalInput(input: ProposedChangeInput): void {
  if (!CHANGE_TYPES.includes(input.change_type)) {
    throw new ValidationError(`"change_type" must be one of ${CHANGE_TYPES.join(', ')}`);
  }
  if (!BURNER_EVENT_TYPES.includes(input.category)) {
    throw new ValidationError(`"category" must be one of ${BURNER_EVENT_TYPES.join(', ')}`);
  }
  if (input.priority && !EVENT_PRIORITIES.includes(input.priority)) {
    throw new ValidationError(`"priority" must be one of ${EVENT_PRIORITIES.join(', ')}`);
  }
  if (
    input.duration_minutes !== undefined &&
    (!Number.isFinite(input.duration_minutes) || input.duration_minutes <= 0)
  ) {
    throw new ValidationError('"duration_minutes" must be a positive number');
  }
  if (input.bump_if_movable !== undefined && typeof input.bump_if_movable !== 'boolean') {
    throw new ValidationError('"bump_if_movable" must be a boolean');
  }
  if (input.bump_if_movable && input.change_type !== 'create' && input.change_type !== 'move') {
    throw new ValidationError('"bump_if_movable" is only meaningful for "create" or "move"');
  }
  if (input.ignore_scheduling_rules !== undefined && typeof input.ignore_scheduling_rules !== 'boolean') {
    throw new ValidationError('"ignore_scheduling_rules" must be a boolean');
  }
  if (input.ignore_scheduling_rules && input.change_type !== 'create' && input.change_type !== 'move') {
    throw new ValidationError('"ignore_scheduling_rules" is only meaningful for "create" or "move"');
  }

  switch (input.change_type) {
    case 'create': {
      if (input.target_event_id) {
        throw new ValidationError('"target_event_id" must not be set for a "create" change_type');
      }
      if (!input.proposed_summary) {
        throw new ValidationError('"create" requires "proposed_summary"');
      }
      const hasStart = !!input.proposed_start;
      const hasEnd = !!input.proposed_end;
      if (hasStart !== hasEnd) {
        throw new ValidationError('"create" requires both "proposed_start" and "proposed_end", or neither');
      }
      // A task-list intake (no start/end yet, just a title + deadline — see
      // architecture-plan.md section 4a) is the one "create" shape allowed to
      // omit them, and only for category "task"; every other category always
      // means "put this on the calendar," which needs a time slot.
      if (!hasStart && input.category !== 'task') {
        throw new ValidationError(
          '"proposed_start" and "proposed_end" are required for "create" unless "category" is "task"'
        );
      }
      break;
    }
    case 'move':
      if (!input.target_event_id) {
        throw new ValidationError('"move" requires "target_event_id"');
      }
      if (!input.proposed_start || !input.proposed_end) {
        throw new ValidationError('"move" requires "proposed_start" and "proposed_end"');
      }
      break;
    case 'update':
      if (!input.target_event_id) {
        throw new ValidationError('"update" requires "target_event_id"');
      }
      if (
        input.proposed_start === undefined &&
        input.proposed_end === undefined &&
        input.proposed_summary === undefined &&
        input.proposed_description === undefined &&
        !input.priority &&
        !input.deadline &&
        !input.source_id &&
        input.tags === undefined
      ) {
        throw new ValidationError(
          '"update" requires at least one of "proposed_start", "proposed_end", "proposed_summary", "proposed_description", "priority", "deadline", "tags", or "source_id" (to link a task — see lib/aiTasks.ts)'
        );
      }
      break;
    case 'delete':
      if (!input.target_event_id) {
        throw new ValidationError('"delete" requires "target_event_id"');
      }
      break;
  }
}

// Empty/unset = nothing auto-applies — same "safe default on unset, throw on
// malformed" convention as lib/schedulingConfig.ts.
export function getAutoApplyCategories(): Set<BurnerEventType> {
  const raw = process.env.AUTO_APPLY_CATEGORIES ?? '';
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const result = new Set<BurnerEventType>();
  for (const entry of entries) {
    if (!BURNER_EVENT_TYPES.includes(entry as BurnerEventType)) {
      throw new Error(
        `AUTO_APPLY_CATEGORIES entry "${entry}" is not a valid category (${BURNER_EVENT_TYPES.join(', ')})`
      );
    }
    result.add(entry as BurnerEventType);
  }
  return result;
}

async function getProposedChange(id: string): Promise<ProposedChangeRow> {
  const { data, error } = await supabase.from('proposed_changes').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`proposed_changes read failed: ${error.message}`);
  if (!data) throw new NotFoundError(`No proposed change with id "${id}"`);
  return data as ProposedChangeRow;
}

async function updateProposedChange(
  id: string,
  patch: Partial<ProposedChangeRow>
): Promise<ProposedChangeRow> {
  const { data, error } = await supabase
    .from('proposed_changes')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`proposed_changes update failed: ${error.message}`);
  return data as ProposedChangeRow;
}

interface BumpOutcome {
  message: string;
}

// Phase 3.5 item 24, "bump if movable" — opt-in per-proposal (bump_if_movable),
// deliberately not the new default: today's "conflict = fail" behavior is
// already shipped and relied on elsewhere. Only ever attempted for a real
// calendar create/move (see the call site below).
//
// All-or-nothing: every single conflicting event must be flexible and
// strictly lower priority than `row` itself, or nothing gets bumped — a
// partial bump wouldn't actually free the slot for `row` anyway. Each
// resolvable conflict gets its own ordinary `move` proposal (reusing
// lib/autoReschedule.ts-style relocation), but `row` itself is never applied
// here even when every conflict resolves — the occupant(s) haven't actually
// vacated the slot yet, only proposed to. `row` is left `failed` with a
// message pointing at what to approve first, reusing the existing
// failed-proposal retry flow rather than inventing a new status.
//
// The occupant moves are created with skipAutoApply — deliberately bypassing
// AUTO_APPLY_CATEGORIES regardless of its configuration, so a bump can never
// silently cascade onto the real calendar without a manual approve. This is
// the "hard manual option ... to override" the user explicitly asked for.
async function attemptBump(row: ProposedChangeRow, conflicts: BusyInterval[]): Promise<BumpOutcome> {
  const fallbackMessage = `Conflicts with existing event(s): ${conflicts
    .map((c) => c.summary ?? c.eventId)
    .join(', ')}`;
  const newItemRank = PRIORITY_RANK[row.priority ?? 'medium'];

  const occupants: {
    eventId: string;
    summary: string | null;
    category: BurnerEventType;
    tags: string[];
    durationMs: number;
  }[] = [];
  for (const conflict of conflicts) {
    const { data: event } = await calendar.events.get({
      calendarId: BURNER_CALENDAR_ID,
      eventId: conflict.eventId,
    });
    const meta = decodeEventMetadata(event.extendedProperties);
    const occupantRank = PRIORITY_RANK[meta.priority ?? 'medium'];
    if (meta.flexible !== 'true' || occupantRank <= newItemRank) {
      return { message: fallbackMessage };
    }
    occupants.push({
      eventId: conflict.eventId,
      summary: conflict.summary,
      category: meta.type ?? 'meeting',
      tags: decodeEventTags(meta.tags),
      durationMs: conflict.end - conflict.start,
    });
  }

  const config = getSchedulingConfig();
  const searchStart = new Date();
  const searchEnd = new Date(searchStart.getTime() + BUMP_SEARCH_HORIZON_DAYS * 24 * 60 * 60 * 1000);

  // Claimed-interval tracking across occupants being bumped in the same
  // attempt, so two occupants never get proposed into the same newly-free
  // slot (same fix already applied in lib/dayRebalance.ts after this exact
  // bug was caught live there).
  let claimedIntervals: Interval[] = [];
  const relocations: { occupant: (typeof occupants)[number]; start: number; end: number }[] = [];

  for (const occupant of occupants) {
    const durationMinutes = Math.max(1, Math.round(occupant.durationMs / 60_000));
    const { slots } = await findFreeSlots(searchStart, searchEnd, {
      minDurationMinutes: durationMinutes,
      config,
      category: occupant.category,
      tags: occupant.tags,
    });
    const fitting = filterByMinDuration(subtractIntervals(slots, claimedIntervals), durationMinutes);
    if (fitting.length === 0) {
      return { message: fallbackMessage };
    }
    const chosenStart = fitting[0].start;
    const chosenEnd = chosenStart + occupant.durationMs;
    relocations.push({ occupant, start: chosenStart, end: chosenEnd });
    claimedIntervals = mergeIntervals([...claimedIntervals, { start: chosenStart, end: chosenEnd }]);
  }

  const proposalIds: string[] = [];
  for (const { occupant, start, end } of relocations) {
    const proposal = await createProposedChange(
      {
        change_type: 'move',
        category: occupant.category,
        source_system: 'ai-engine',
        target_event_id: occupant.eventId,
        proposed_start: new Date(start).toISOString(),
        proposed_end: new Date(end).toISOString(),
        reason: `Bumped to make room for "${row.proposed_summary ?? row.id}"`,
      },
      { skipAutoApply: true }
    );
    proposalIds.push(proposal.id);
  }

  const plural = proposalIds.length > 1;
  const summaries = occupants.map((o) => o.summary ?? o.eventId).join(', ');
  return {
    message: `Blocked pending approval of relocating ${summaries} (proposal id${plural ? 's' : ''} ${proposalIds.join(', ')}) — approve ${plural ? 'those' : 'that'} first, then retry this one.`,
  };
}

export async function applyProposedChange(
  row: ProposedChangeRow,
  decidedBy: DecidedBy
): Promise<ProposedChangeRow> {
  const now = new Date().toISOString();

  try {
    const isCalendarCreate = row.change_type === 'create' && !!row.proposed_start && !!row.proposed_end;
    if (isCalendarCreate || row.change_type === 'move') {
      // Phase 3.5 item 30 — standing scheduling rules, checked before
      // conflict detection and independent of bump_if_movable (a rule
      // violation isn't fixable by relocating whoever else is occupying the
      // slot — the time itself is disallowed regardless of what's there).
      // Only ignore_scheduling_rules bypasses this, never bump_if_movable.
      // Uses row.tags for both create and move — for 'move' this is the
      // proposal's own input tags, not necessarily the target event's real
      // current tags (see backend-schema.md's scheduling_rules entry for
      // the known v1 scoping limit this creates for tag-scoped rules).
      if (!row.ignore_scheduling_rules) {
        const rules = await fetchApplicableSchedulingRules(row.category, row.tags ?? []);
        if (rules.length > 0) {
          const violation = checkCandidateAgainstRules(
            new Date(row.proposed_start!),
            rules,
            getSchedulingConfig().homeTimezone
          );
          if (violation) {
            throw new Error(violation.message);
          }
        }
      }

      const { hasConflict, conflicts } = await detectConflicts(
        new Date(row.proposed_start!),
        new Date(row.proposed_end!),
        { excludeEventId: row.target_event_id ?? undefined }
      );
      if (hasConflict) {
        if (row.bump_if_movable) {
          const outcome = await attemptBump(row, conflicts);
          throw new Error(outcome.message);
        }
        const summaries = conflicts.map((c) => c.summary ?? c.eventId).join(', ');
        throw new Error(`Conflicts with existing event(s): ${summaries}`);
      }
    }

    let resultingEventId = row.target_event_id ?? null;
    // Populated below for move/update/delete — a create has nothing to
    // restore (revert of a create just deletes the resulting event).
    let previousState: PreviousEventState | null = null;

    if (row.change_type === 'create' && isCalendarCreate) {
      const { data } = await calendar.events.insert({
        calendarId: BURNER_CALENDAR_ID,
        requestBody: {
          summary: row.proposed_summary,
          description: row.proposed_description,
          start: { dateTime: row.proposed_start },
          end: { dateTime: row.proposed_end },
          extendedProperties: {
            private: encodeEventMetadata({
              schemaVersion: '1',
              type: row.category,
              flexible: row.flexible ?? 'true',
              sourceSystem: row.source_system,
              sourceId: row.source_id ?? row.id,
              sourceCalendarId: '',
              sourceLabel: '',
              priority: row.priority ?? 'medium',
              colorTag: CATEGORY_COLORS[row.category],
              deadline: row.deadline ?? '',
              tags: encodeEventTags(row.tags ?? []),
            }),
          },
        },
      });
      resultingEventId = data.id!;

      // If this create was "schedule this task onto the calendar" (lib/aiTasks.ts),
      // row.source_id is the tasks.id, not an external id — close the loop by
      // marking that task scheduled and pointing it at the new event.
      if (row.category === 'task' && row.source_id && isUuid(row.source_id)) {
        await supabase
          .from('tasks')
          .update({ status: 'scheduled', scheduled_event_id: resultingEventId })
          .eq('id', row.source_id);
      }
    } else if (row.change_type === 'create') {
      // No proposed_start/proposed_end: a task-list intake (architecture-plan.md
      // section 4a), not a calendar write — insert into `tasks` instead, and
      // link back to whichever synced_tasks row (if any) is waiting on this
      // proposal so the sync knows it's now resolved.
      const { data: taskRow, error: taskError } = await supabase
        .from('tasks')
        .insert({
          title: row.proposed_summary,
          description: row.proposed_description ?? null,
          deadline: row.deadline ?? null,
          priority: row.priority ?? null,
          tags: row.tags ?? [],
          duration_minutes: row.duration_minutes ?? null,
          source_system: row.source_system,
          source_id: row.source_id ?? null,
          status: 'unscheduled',
        })
        .select('*')
        .single();
      if (taskError) throw new Error(`tasks insert failed: ${taskError.message}`);

      const { error: syncedTasksError } = await supabase
        .from('synced_tasks')
        .update({ task_id: taskRow.id })
        .eq('proposed_change_id', row.id);
      if (syncedTasksError) throw new Error(`synced_tasks link failed: ${syncedTasksError.message}`);
    } else if (row.change_type === 'move') {
      // A move only ever changes start/end, so that's all the pre-write read
      // (added for item 28) needs to capture — everything else on the event
      // is untouched by this change_type.
      const { data: existingForMove } = await calendar.events.get({
        calendarId: BURNER_CALENDAR_ID,
        eventId: row.target_event_id!,
      });
      previousState = {
        summary: null,
        description: null,
        start: existingForMove.start?.dateTime ?? null,
        end: existingForMove.end?.dateTime ?? null,
        category: null,
        priority: null,
        flexible: null,
        deadline: null,
        tags: [],
      };

      await calendar.events.patch({
        calendarId: BURNER_CALENDAR_ID,
        eventId: row.target_event_id!,
        requestBody: {
          start: { dateTime: row.proposed_start },
          end: { dateTime: row.proposed_end },
        },
      });
    } else if (row.change_type === 'update') {
      const { data: existing } = await calendar.events.get({
        calendarId: BURNER_CALENDAR_ID,
        eventId: row.target_event_id!,
      });
      const existingMeta = decodeEventMetadata(existing.extendedProperties);
      // This read already has to happen for Google's patch (below) to resend
      // the full extendedProperties map — item 28 captures the pre-write
      // shape here rather than discarding it, at no extra API cost.
      previousState = {
        summary: existing.summary ?? null,
        description: existing.description ?? null,
        start: existing.start?.dateTime ?? null,
        end: existing.end?.dateTime ?? null,
        category: existingMeta.type ?? null,
        priority: existingMeta.priority ?? null,
        flexible: existingMeta.flexible ?? null,
        deadline: existingMeta.deadline || null,
        tags: decodeEventTags(existingMeta.tags),
      };

      // row.source_id is only ever explicitly set on an 'update' proposal for
      // one reason today: linking a task to this already-existing event
      // (lib/aiTasks.ts) — in which case the new value should win over
      // whatever origin metadata the event already had. Absent that, origin
      // metadata is preserved (existingMeta wins), same as before.
      const isTaskLink = !!row.source_id;

      await calendar.events.patch({
        calendarId: BURNER_CALENDAR_ID,
        eventId: row.target_event_id!,
        requestBody: {
          // != null (catches both undefined AND a real SQL null — a row
          // fetched back from Supabase reports an unset column as `null`,
          // never `undefined`), not truthy — a caller (item 28's revert, in
          // particular) needs to be able to explicitly restore a field to
          // "" (e.g. clearing a description back to none), which a
          // truthiness check would silently treat as "field not specified,
          // leave alone." A field genuinely absent (null/undefined) still
          // means "don't touch it" — sending Google a literal `null`
          // dateTime, which the earlier (buggy) `!== undefined` version of
          // this check did for every untouched proposed_start/proposed_end,
          // fails with a confusing Google-side "start/end must both be date
          // or both be dateTime" error caught live while testing this.
          ...(row.proposed_summary != null ? { summary: row.proposed_summary } : {}),
          ...(row.proposed_description != null ? { description: row.proposed_description } : {}),
          ...(row.proposed_start != null ? { start: { dateTime: row.proposed_start } } : {}),
          ...(row.proposed_end != null ? { end: { dateTime: row.proposed_end } } : {}),
          extendedProperties: {
            private: encodeEventMetadata({
              schemaVersion: '1',
              type: existingMeta.type ?? row.category,
              flexible: row.flexible ?? existingMeta.flexible ?? 'true',
              sourceSystem: isTaskLink ? row.source_system : existingMeta.sourceSystem ?? row.source_system,
              sourceId: isTaskLink ? row.source_id! : existingMeta.sourceId ?? row.source_id ?? row.id,
              sourceCalendarId: existingMeta.sourceCalendarId ?? '',
              sourceLabel: existingMeta.sourceLabel ?? '',
              priority: row.priority ?? existingMeta.priority ?? 'medium',
              colorTag: CATEGORY_COLORS[existingMeta.type ?? row.category],
              deadline: row.deadline ?? existingMeta.deadline ?? '',
              // Replace-if-provided, preserve-if-omitted — same fallback
              // style as every other field above. Bulk-edit's add/remove
              // semantics (lib/bulkEdit.ts) are a layer computed before
              // calling createProposedChange, not a change to this
              // single-event primitive's own replace behavior.
              tags:
                row.tags !== undefined && row.tags !== null
                  ? encodeEventTags(row.tags)
                  : existingMeta.tags ?? '',
            }),
          },
        },
      });

      if (isTaskLink && isUuid(row.source_id!)) {
        await supabase
          .from('tasks')
          .update({ status: 'scheduled', scheduled_event_id: row.target_event_id })
          .eq('id', row.source_id!);
      }
    } else if (row.change_type === 'delete') {
      // Unlike update/move, nothing else in this branch already reads the
      // event — added specifically for item 28, so a delete can be undone by
      // recreating it (as a new event; the original event id doesn't survive
      // a delete either way).
      const { data: existingForDelete } = await calendar.events.get({
        calendarId: BURNER_CALENDAR_ID,
        eventId: row.target_event_id!,
      });
      const deletedMeta = decodeEventMetadata(existingForDelete.extendedProperties);
      previousState = {
        summary: existingForDelete.summary ?? null,
        description: existingForDelete.description ?? null,
        start: existingForDelete.start?.dateTime ?? null,
        end: existingForDelete.end?.dateTime ?? null,
        category: deletedMeta.type ?? null,
        priority: deletedMeta.priority ?? null,
        flexible: deletedMeta.flexible ?? null,
        deadline: deletedMeta.deadline || null,
        tags: decodeEventTags(deletedMeta.tags),
      };

      await calendar.events.delete({
        calendarId: BURNER_CALENDAR_ID,
        eventId: row.target_event_id!,
      });
      // Best-effort: if this event was backed by a `tasks` row (todoist/canvas
      // sync completion/deletion flow, architecture-plan.md section 4a step
      // 7), close it out too. A miss here shouldn't turn an already-succeeded
      // calendar delete into a "failed" proposal.
      await supabase
        .from('tasks')
        .update({ status: 'completed' })
        .eq('scheduled_event_id', row.target_event_id!);
    }

    return await updateProposedChange(row.id, {
      status: 'applied',
      decided_by: decidedBy,
      decided_at: now,
      applied_at: now,
      error_message: null,
      target_event_id: resultingEventId ?? undefined,
      previous_state: previousState,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return await updateProposedChange(row.id, {
      status: 'failed',
      decided_by: decidedBy,
      decided_at: now,
      error_message: message,
    });
  }
}

export async function createProposedChange(
  input: ProposedChangeInput,
  options: { skipAutoApply?: boolean; groupId?: string } = {}
): Promise<ProposedChangeRow> {
  validateProposalInput(input);

  const { data, error } = await supabase
    .from('proposed_changes')
    .insert({
      ...input,
      tags: normalizeTags(input.tags),
      color_tag: CATEGORY_COLORS[input.category],
      status: 'pending',
      // previous_state is only ever written by applyProposedChange itself,
      // from a real pre-write calendar read — never trust a client-supplied
      // value (it isn't part of ProposedChangeInput, but an untyped JSON
      // body could still carry the key). This override always wins since it
      // comes after the spread above.
      previous_state: null,
      // Same reasoning — proposal_group_id is only ever set by
      // createProposedChangesBatch below (options.groupId), never trusted
      // from a client-supplied input field (ProposedChangeInput doesn't
      // even declare one).
      proposal_group_id: options.groupId ?? null,
    })
    .select('*')
    .single();
  if (error) throw new Error(`proposed_changes insert failed: ${error.message}`);

  const row = data as ProposedChangeRow;
  // skipAutoApply is internal-only (no public route exposes it) — used by
  // attemptBump above so a bump-created move can never silently cascade onto
  // the real calendar via AUTO_APPLY_CATEGORIES, regardless of its
  // configuration. Every other caller gets the normal auto-apply check.
  if (options.skipAutoApply) {
    return row;
  }
  const autoApplyCategories = getAutoApplyCategories();
  if (autoApplyCategories.has(row.category)) {
    return applyProposedChange(row, 'auto-apply-policy');
  }
  return row;
}

export interface BatchProposalResultEntry {
  index: number;
  outcome: 'proposed' | 'skipped-error';
  proposal?: ProposedChangeRow;
  reason?: string;
}

export interface BatchProposalSummary {
  groupId: string;
  proposalsRequested: number;
  proposalsCreated: number;
  skippedErrors: number;
  results: BatchProposalResultEntry[];
}

// Phase 3.5 item 27 ("batch proposals") — the efficiency case this exists
// for: a single NL sentence like "move everything after 3pm to tomorrow" or
// "cancel my meetings except the manager one" naturally produces N
// proposals, and reviewing/approving them one at a time is N round trips
// through a chat loop. Every row shares one server-generated
// proposal_group_id (never client-settable — see createProposedChange's own
// override), so the whole batch can be approved/rejected as one unit
// (approveProposalGroup/rejectProposalGroup below) instead.
//
// Each item goes through the exact same createProposedChange path
// (validation, tag normalization, AUTO_APPLY_CATEGORIES) as a standalone
// proposal — batching doesn't change per-item behavior, just gives the
// resulting rows a shared handle. One item's failure (bad validation, or an
// auto-applied item hitting a real conflict) doesn't abort the rest of the
// batch, same per-item try/catch shape as every other fan-out engine in
// this codebase (lib/bulkEdit.ts, lib/recurringEvents.ts, lib/habitPlacement.ts).
export async function createProposedChangesBatch(
  proposals: ProposedChangeInput[],
  reason?: string
): Promise<BatchProposalSummary> {
  if (!Array.isArray(proposals) || proposals.length === 0) {
    throw new ValidationError('"proposals" must be a non-empty array');
  }
  if (proposals.length > MAX_BATCH_SIZE) {
    throw new ValidationError(`"proposals" must contain at most ${MAX_BATCH_SIZE} items`);
  }

  const groupId = randomUUID();
  const summary: BatchProposalSummary = {
    groupId,
    proposalsRequested: proposals.length,
    proposalsCreated: 0,
    skippedErrors: 0,
    results: [],
  };

  for (let i = 0; i < proposals.length; i++) {
    const item = proposals[i];
    try {
      // Per-item reason wins if given; the batch-level reason is a shared
      // fallback default, not an override — same precedence bulk-edit's own
      // reason field has relative to per-match specifics.
      const proposal = await createProposedChange(
        { ...item, reason: item.reason ?? reason },
        { groupId }
      );
      summary.proposalsCreated++;
      summary.results.push({ index: i, outcome: 'proposed', proposal });
    } catch (err) {
      summary.skippedErrors++;
      summary.results.push({
        index: i,
        outcome: 'skipped-error',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

export interface GroupDecisionResultEntry {
  id: string;
  outcome: 'applied' | 'rejected' | 'failed' | 'skipped-already-decided';
  proposal: ProposedChangeRow;
}

export interface GroupDecisionSummary {
  groupId: string;
  rowsInGroup: number;
  results: GroupDecisionResultEntry[];
}

async function getProposalGroup(groupId: string): Promise<ProposedChangeRow[]> {
  const { data, error } = await supabase
    .from('proposed_changes')
    .select('*')
    .eq('proposal_group_id', groupId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`proposed_changes read failed: ${error.message}`);
  const rows = (data ?? []) as ProposedChangeRow[];
  if (rows.length === 0) throw new NotFoundError(`No proposal group with id "${groupId}"`);
  return rows;
}

// Approves every still-open (pending/failed) row in the group; a row
// that's already applied/rejected (e.g. it individually auto-applied via
// AUTO_APPLY_CATEGORIES at creation time) is reported as
// skipped-already-decided rather than erroring the whole group — same
// "one item's state doesn't block the rest" principle as every other
// batch/fan-out operation here.
export async function approveProposalGroup(groupId: string): Promise<GroupDecisionSummary> {
  const rows = await getProposalGroup(groupId);
  const results: GroupDecisionResultEntry[] = [];

  for (const row of rows) {
    if (row.status !== 'pending' && row.status !== 'failed') {
      results.push({ id: row.id, outcome: 'skipped-already-decided', proposal: row });
      continue;
    }
    const applied = await applyProposedChange(row, 'user');
    results.push({ id: row.id, outcome: applied.status === 'applied' ? 'applied' : 'failed', proposal: applied });
  }

  return { groupId, rowsInGroup: rows.length, results };
}

export async function rejectProposalGroup(groupId: string): Promise<GroupDecisionSummary> {
  const rows = await getProposalGroup(groupId);
  const results: GroupDecisionResultEntry[] = [];

  for (const row of rows) {
    if (row.status !== 'pending' && row.status !== 'failed') {
      results.push({ id: row.id, outcome: 'skipped-already-decided', proposal: row });
      continue;
    }
    const rejected = await updateProposedChange(row.id, {
      status: 'rejected',
      decided_by: 'user',
      decided_at: new Date().toISOString(),
    });
    results.push({ id: row.id, outcome: 'rejected', proposal: rejected });
  }

  return { groupId, rowsInGroup: rows.length, results };
}

export async function approveProposedChange(id: string): Promise<ProposedChangeRow> {
  const row = await getProposedChange(id);
  if (row.status !== 'pending' && row.status !== 'failed') {
    throw new ConflictError(`Cannot approve a proposed change with status "${row.status}"`);
  }
  return applyProposedChange(row, 'user');
}

export async function rejectProposedChange(id: string): Promise<ProposedChangeRow> {
  const row = await getProposedChange(id);
  if (row.status !== 'pending' && row.status !== 'failed') {
    throw new ConflictError(`Cannot reject a proposed change with status "${row.status}"`);
  }
  return updateProposedChange(id, {
    status: 'rejected',
    decided_by: 'user',
    decided_at: new Date().toISOString(),
  });
}

// Phase 3.5 item 28 ("undo") — turns an already-`applied` row into the
// opposite ProposedChangeInput, using the `previous_state` snapshot captured
// at apply time. Never mutates the calendar itself: like attemptBump above,
// it creates a brand-new compensating proposal (skipAutoApply: true, so it
// always lands `pending` regardless of AUTO_APPLY_CATEGORIES) rather than
// applying immediately — "undo" is exactly the kind of decision that
// shouldn't silently cascade. Approving that new proposal is a second,
// ordinary call, same two-step shape as approving any other proposal.
function buildRevertInput(row: ProposedChangeRow): ProposedChangeInput {
  const reasonSuffix = `revert of proposal ${row.id}`;

  switch (row.change_type) {
    case 'create': {
      // The task-list-intake shape (category 'task', no proposed_start/end)
      // never touches the calendar, so target_event_id stays null even after
      // applying — nothing here for a revert to undo.
      if (!row.target_event_id) {
        throw new ConflictError(
          'This proposal never wrote to the calendar (task-list intake) — nothing to revert'
        );
      }
      return {
        change_type: 'delete',
        category: row.category,
        source_system: 'ai-engine',
        target_event_id: row.target_event_id,
        reason: `Undo create — ${reasonSuffix}`,
      };
    }
    case 'move': {
      const ps = row.previous_state;
      if (!ps?.start || !ps?.end) {
        throw new ConflictError('No previous position was captured for this move — nothing to revert to');
      }
      return {
        change_type: 'move',
        category: row.category,
        source_system: 'ai-engine',
        target_event_id: row.target_event_id!,
        proposed_start: ps.start,
        proposed_end: ps.end,
        reason: `Undo move — ${reasonSuffix}`,
      };
    }
    case 'update': {
      const ps = row.previous_state;
      if (!ps) {
        throw new ConflictError('No previous state was captured for this update — nothing to revert to');
      }
      return {
        change_type: 'update',
        category: ps.category ?? row.category,
        source_system: 'ai-engine',
        target_event_id: row.target_event_id!,
        proposed_summary: ps.summary ?? undefined,
        // '', not undefined, when there was genuinely no description before
        // — undefined now means "don't touch" (see the !== undefined check
        // in applyProposedChange's update branch above), so a real full
        // restore has to explicitly send the empty value, not omit it.
        proposed_description: ps.description ?? '',
        proposed_start: ps.start ?? undefined,
        proposed_end: ps.end ?? undefined,
        priority: ps.priority ?? undefined,
        deadline: ps.deadline ?? undefined,
        tags: ps.tags,
        flexible: ps.flexible ?? undefined,
        reason: `Undo update — ${reasonSuffix}`,
      };
    }
    case 'delete': {
      const ps = row.previous_state;
      if (!ps?.start || !ps?.end) {
        throw new ConflictError('No previous state was captured for this delete — nothing to restore');
      }
      // The original event id is gone — this recreates it as a new event,
      // same "revert = compensating action, not time travel" tradeoff as the
      // rest of this system.
      return {
        change_type: 'create',
        category: ps.category ?? row.category,
        source_system: 'ai-engine',
        proposed_start: ps.start,
        proposed_end: ps.end,
        proposed_summary: ps.summary ?? '(untitled)',
        proposed_description: ps.description ?? undefined,
        priority: ps.priority ?? undefined,
        deadline: ps.deadline ?? undefined,
        tags: ps.tags,
        flexible: ps.flexible ?? undefined,
        reason: `Undo delete (restored as a new event) — ${reasonSuffix}`,
      };
    }
  }
}

export async function revertProposedChange(id: string): Promise<ProposedChangeRow> {
  const row = await getProposedChange(id);
  if (row.status !== 'applied') {
    throw new ConflictError(
      `Cannot revert a proposed change with status "${row.status}" — only "applied" changes can be reverted`
    );
  }
  const revertInput = buildRevertInput(row);
  return createProposedChange(revertInput, { skipAutoApply: true });
}

// Sets priority/tags on a still-open proposal — the review-time step
// architecture-plan.md section 4a describes for a Todoist task-intake
// proposal, whose sync deliberately leaves both unset (neither is something
// the source system can tell us). Not restricted to that source, though:
// any pending/failed proposal can be corrected the same way before approving.
export async function updateProposedChangeFields(
  id: string,
  patch: { priority?: EventPriority; tags?: string[]; duration_minutes?: number }
): Promise<ProposedChangeRow> {
  const row = await getProposedChange(id);
  if (row.status !== 'pending' && row.status !== 'failed') {
    throw new ConflictError(`Cannot edit a proposed change with status "${row.status}"`);
  }

  const update: Partial<ProposedChangeRow> = {};
  if (patch.priority !== undefined) {
    if (!EVENT_PRIORITIES.includes(patch.priority)) {
      throw new ValidationError(`"priority" must be one of ${EVENT_PRIORITIES.join(', ')}`);
    }
    update.priority = patch.priority;
  }
  if (patch.tags !== undefined) {
    update.tags = normalizeTags(patch.tags);
  }
  if (patch.duration_minutes !== undefined) {
    if (!Number.isFinite(patch.duration_minutes) || patch.duration_minutes <= 0) {
      throw new ValidationError('"duration_minutes" must be a positive number');
    }
    update.duration_minutes = patch.duration_minutes;
  }
  if (Object.keys(update).length === 0) {
    throw new ValidationError('At least one of "priority", "tags", or "duration_minutes" is required');
  }

  return updateProposedChange(id, update);
}

// A plain-language summary of a row's outcome, for a thin client to display
// directly rather than having to interpret status/error_message itself.
export function describeProposalOutcome(row: ProposedChangeRow): string {
  switch (row.status) {
    case 'pending':
      return 'Awaiting approval.';
    case 'applied':
      return 'Change applied to the calendar.';
    case 'rejected':
      return 'Change rejected.';
    case 'failed':
      return `Failed to apply: ${row.error_message}`;
  }
}

export async function listProposedChanges(
  status?: ProposalStatus,
  groupId?: string
): Promise<ProposedChangeRow[]> {
  let query = supabase.from('proposed_changes').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  if (groupId) query = query.eq('proposal_group_id', groupId);
  const { data, error } = await query;
  if (error) throw new Error(`proposed_changes read failed: ${error.message}`);
  return data as ProposedChangeRow[];
}
