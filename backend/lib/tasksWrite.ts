import { supabase } from './supabase';
import { normalizeTags } from './normalizeTags';
import { EVENT_PRIORITIES, type EventPriority } from './eventMetadata';
import { ValidationError, NotFoundError } from './proposedChanges';
import type { TaskRow } from './aiTasks';
import { pushNewTaskToTodoist, pushTaskEditToTodoist } from './todoistWrite';

export interface CreateTaskInput {
  title: string;
  description?: string | null;
  deadline?: string | null;
  priority?: EventPriority | null;
  duration_minutes?: number | null;
  tags?: string[];
}

// Lifted verbatim from app/api/tasks/route.ts's POST handler (prerequisite
// refactor for the Phase 5 NL chat layer's create_task tool, which needs an
// in-process function to call rather than duplicating this route's inline
// validation) — same "declaration" convention as lib/habitsWrite.ts,
// lib/schedulingRulesQuery.ts, lib/capabilityRequestsWrite.ts.
export async function createTask(input: CreateTaskInput): Promise<TaskRow> {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) {
    throw new ValidationError('title is required');
  }

  let deadline: string | null = null;
  if (input.deadline !== undefined && input.deadline !== null) {
    if (typeof input.deadline !== 'string' || Number.isNaN(Date.parse(input.deadline))) {
      throw new ValidationError('"deadline" must be a valid date string');
    }
    deadline = input.deadline;
  }

  if (input.priority !== undefined && input.priority !== null && !EVENT_PRIORITIES.includes(input.priority)) {
    throw new ValidationError(`"priority" must be one of ${EVENT_PRIORITIES.join(', ')}, or null`);
  }

  if (
    input.duration_minutes !== undefined &&
    input.duration_minutes !== null &&
    (!Number.isInteger(input.duration_minutes) || input.duration_minutes <= 0)
  ) {
    throw new ValidationError('"duration_minutes" must be a positive integer');
  }

  const description = typeof input.description === 'string' ? input.description : null;
  const tags = normalizeTags(input.tags);

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      title,
      description,
      deadline,
      priority: input.priority ?? null,
      tags,
      duration_minutes: input.duration_minutes ?? null,
      source_system: 'manual',
      status: 'unscheduled',
    })
    .select('*')
    .single();

  if (error) throw new Error(`tasks insert failed: ${error.message}`);
  const task = data as TaskRow;

  // Best-effort, real-time (2026-07-25, two-way Todoist sync) — a Todoist
  // API failure here must never fail task creation, which already
  // succeeded above.
  try {
    await pushNewTaskToTodoist(task);
  } catch {
    // Swallowed deliberately — see lib/todoistWrite.ts's top comment.
  }

  return task;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  deadline?: string | null;
  priority?: EventPriority | null;
  duration_minutes?: number | null;
  tags?: string[];
}

export interface UpdateTaskOptions {
  // Set by lib/todoistSync.ts's own Todoist→us edit-sync — an edit that
  // *came from* Todoist shouldn't be echoed straight back to Todoist (both
  // pointless, since Todoist already has it, and the one real added-risk
  // surface: an unnecessary extra API call that could fail for unrelated
  // reasons). Every other caller (the PATCH route, a future app edit UI)
  // leaves this unset, so the normal push-to-Todoist behavior applies.
  skipTodoistPush?: boolean;
}

// No app UI calls this yet (view/create/complete only, per app CLAUDE.md) —
// added 2026-07-25 specifically so two-way Todoist sync has something to
// push an edit *from*. Same field-by-field validation shape as
// lib/habitsWrite.ts's updateHabit.
export async function updateTask(
  id: string,
  input: UpdateTaskInput,
  options: UpdateTaskOptions = {}
): Promise<TaskRow> {
  const patch: Record<string, unknown> = {};

  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw new ValidationError('title cannot be empty');
    patch.title = title;
  }

  if (input.description !== undefined) {
    patch.description = typeof input.description === 'string' ? input.description : null;
  }

  if (input.deadline !== undefined) {
    if (input.deadline !== null && (typeof input.deadline !== 'string' || Number.isNaN(Date.parse(input.deadline)))) {
      throw new ValidationError('"deadline" must be a valid date string or null');
    }
    patch.deadline = input.deadline;
  }

  if (input.priority !== undefined) {
    if (input.priority !== null && !EVENT_PRIORITIES.includes(input.priority)) {
      throw new ValidationError(`"priority" must be one of ${EVENT_PRIORITIES.join(', ')}, or null`);
    }
    patch.priority = input.priority;
  }

  if (input.duration_minutes !== undefined) {
    if (
      input.duration_minutes !== null &&
      (!Number.isInteger(input.duration_minutes) || input.duration_minutes <= 0)
    ) {
      throw new ValidationError('"duration_minutes" must be a positive integer or null');
    }
    patch.duration_minutes = input.duration_minutes;
  }

  if (input.tags !== undefined) {
    patch.tags = normalizeTags(input.tags);
  }

  if (Object.keys(patch).length === 0) {
    throw new ValidationError(
      'At least one of title, description, deadline, priority, duration_minutes, tags is required'
    );
  }

  const { data, error } = await supabase.from('tasks').update(patch).eq('id', id).select('*');
  if (error) throw new Error(`tasks update failed: ${error.message}`);
  if (!data || data.length === 0) throw new NotFoundError(`No task with id "${id}"`);
  const task = data[0] as TaskRow;

  // Best-effort, real-time — same reasoning as createTask above.
  if (!options.skipTodoistPush) {
    try {
      await pushTaskEditToTodoist(task);
    } catch {
      // Swallowed deliberately — see lib/todoistWrite.ts's top comment.
    }
  }

  return task;
}
