import { calendar } from './googleCalendar';
import { supabase } from './supabase';
import {
  encodeEventMetadata,
  decodeEventMetadata,
  encodeEventTags,
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

const BURNER_CALENDAR_ID = process.env.GOOGLE_BURNER_CALENDAR_ID!;
const BUMP_SEARCH_HORIZON_DAYS = 14;

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
}

export interface ProposedChangeRow extends ProposedChangeInput {
  id: string;
  color_tag: string;
  status: ProposalStatus;
  decided_by: DecidedBy | null;
  decided_at: string | null;
  applied_at: string | null;
  error_message: string | null;
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
        !input.proposed_start &&
        !input.proposed_end &&
        !input.proposed_summary &&
        !input.proposed_description &&
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

  const occupants: { eventId: string; summary: string | null; category: BurnerEventType; durationMs: number }[] = [];
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
    const { slots } = await findFreeSlots(searchStart, searchEnd, { minDurationMinutes: durationMinutes, config });
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
          ...(row.proposed_summary ? { summary: row.proposed_summary } : {}),
          ...(row.proposed_description ? { description: row.proposed_description } : {}),
          ...(row.proposed_start ? { start: { dateTime: row.proposed_start } } : {}),
          ...(row.proposed_end ? { end: { dateTime: row.proposed_end } } : {}),
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
  options: { skipAutoApply?: boolean } = {}
): Promise<ProposedChangeRow> {
  validateProposalInput(input);

  const { data, error } = await supabase
    .from('proposed_changes')
    .insert({
      ...input,
      tags: normalizeTags(input.tags),
      color_tag: CATEGORY_COLORS[input.category],
      status: 'pending',
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

export async function listProposedChanges(status?: ProposalStatus): Promise<ProposedChangeRow[]> {
  let query = supabase.from('proposed_changes').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new Error(`proposed_changes read failed: ${error.message}`);
  return data as ProposedChangeRow[];
}
