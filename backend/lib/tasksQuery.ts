import { supabase } from './supabase';
import { ValidationError } from './proposedChanges';
import type { TaskRow } from './aiTasks';

type TaskStatus = TaskRow['status'];
const VALID_STATUSES: TaskStatus[] = ['unscheduled', 'scheduled', 'completed', 'discarded'];

// Lifted verbatim from app/api/tasks/route.ts's GET handler — the read half
// of the tasksWrite.ts prerequisite refactor, for the NL chat layer's
// list_tasks tool.
//
// scheduledEventId (added for "multiple tasks per calendar block," see
// lib/aiTasks.ts's unscheduleTask) — this is the only reliable way to answer
// "what's attached to this block": tasks.scheduled_event_id is a plain
// many-to-one pointer (many tasks can share one event id; nothing enforces
// or ever enforced uniqueness here), while the event's own
// extendedProperties.private.sourceId can only ever hold one task id and
// reflects whichever task was linked most recently — not authoritative
// once more than one task shares a block.
export async function listTasks(status?: TaskStatus, scheduledEventId?: string): Promise<TaskRow[]> {
  if (status && !VALID_STATUSES.includes(status)) {
    throw new ValidationError(`"status" must be one of ${VALID_STATUSES.join(', ')}`);
  }

  let query = supabase.from('tasks').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  if (scheduledEventId) query = query.eq('scheduled_event_id', scheduledEventId);

  const { data, error } = await query;
  if (error) throw new Error(`tasks read failed: ${error.message}`);
  return data as TaskRow[];
}
