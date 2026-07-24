import { supabase } from './supabase';
import { normalizeTags } from './normalizeTags';
import { EVENT_PRIORITIES, type EventPriority } from './eventMetadata';
import { ValidationError } from './proposedChanges';
import type { TaskRow } from './aiTasks';

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
  return data as TaskRow;
}
