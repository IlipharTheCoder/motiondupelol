import { supabase } from './supabase';
import { ValidationError } from './proposedChanges';
import type { TaskRow } from './aiTasks';

type TaskStatus = TaskRow['status'];
const VALID_STATUSES: TaskStatus[] = ['unscheduled', 'scheduled', 'completed', 'discarded'];

// Lifted verbatim from app/api/tasks/route.ts's GET handler — the read half
// of the tasksWrite.ts prerequisite refactor, for the NL chat layer's
// list_tasks tool.
export async function listTasks(status?: TaskStatus): Promise<TaskRow[]> {
  if (status && !VALID_STATUSES.includes(status)) {
    throw new ValidationError(`"status" must be one of ${VALID_STATUSES.join(', ')}`);
  }

  let query = supabase.from('tasks').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new Error(`tasks read failed: ${error.message}`);
  return data as TaskRow[];
}
