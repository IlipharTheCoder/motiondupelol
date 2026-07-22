import { supabase } from './supabase';
import { createProposedChange } from './proposedChanges';

const TODOIST_API_BASE = 'https://api.todoist.com/rest/v2';

interface TodoistDue {
  date: string;
  datetime?: string;
}

interface TodoistTask {
  id: string;
  content: string;
  description: string;
  due: TodoistDue | null;
  created_at: string;
}

interface SyncedTaskRow {
  source_system: string;
  source_id: string;
  proposed_change_id: string | null;
  task_id: string | null;
  source_updated_at: string | null;
}

export interface TodoistSyncResult {
  proposed: number;
  skippedExisting: number;
  withdrawnUnscheduled: number;
  proposedDeletes: number;
  errors: string[];
}

// A bare `due.date` (no `due.datetime`) is an all-day due date with no
// attached time — treated as "must be done by end of that day" since
// `deadline` is a constraint, not a scheduled slot (nothing reads it yet
// beyond store-and-round-trip — see backend-schema.md's proposed_changes).
function todoistDeadline(due: TodoistDue | null): string | undefined {
  if (!due) return undefined;
  if (due.datetime) return due.datetime;
  return `${due.date}T23:59:59Z`;
}

async function fetchActiveTasks(): Promise<TodoistTask[]> {
  const token = process.env.TODOIST_API_TOKEN;
  if (!token) throw new Error('TODOIST_API_TOKEN is not set');

  const res = await fetch(`${TODOIST_API_BASE}/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Todoist API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// Full-list diff against `synced_tasks`, not an incremental sync token — a
// personal Todoist list is small enough that this is simpler and cheap,
// unlike the calendar sync's larger event volumes (architecture-plan.md
// section 4a).
export async function runTodoistSync(): Promise<TodoistSyncResult> {
  const result: TodoistSyncResult = {
    proposed: 0,
    skippedExisting: 0,
    withdrawnUnscheduled: 0,
    proposedDeletes: 0,
    errors: [],
  };

  const activeTasks = await fetchActiveTasks();
  const activeIds = new Set(activeTasks.map((t) => t.id));

  const { data: existingRows, error: existingError } = await supabase
    .from('synced_tasks')
    .select('*')
    .eq('source_system', 'todoist');
  if (existingError) throw new Error(`synced_tasks read failed: ${existingError.message}`);

  const existingBySourceId = new Map<string, SyncedTaskRow>();
  for (const row of (existingRows ?? []) as SyncedTaskRow[]) {
    existingBySourceId.set(row.source_id, row);
  }

  // New tasks — propose a task-list intake (never write directly, same
  // review-queue principle as everywhere else). Priority/tags are
  // deliberately left unset here; you set them when you review the proposal.
  for (const task of activeTasks) {
    if (existingBySourceId.has(task.id)) {
      result.skippedExisting++;
      continue;
    }

    try {
      const proposal = await createProposedChange({
        change_type: 'create',
        category: 'task',
        source_system: 'todoist',
        source_id: task.id,
        proposed_summary: task.content,
        proposed_description: task.description || undefined,
        deadline: todoistDeadline(task.due),
      });

      const { error: upsertError } = await supabase.from('synced_tasks').upsert(
        {
          source_system: 'todoist',
          source_id: task.id,
          proposed_change_id: proposal.id,
          task_id: null,
          source_updated_at: task.created_at ?? null,
        },
        { onConflict: 'source_system,source_id' }
      );
      if (upsertError) throw new Error(`synced_tasks upsert failed: ${upsertError.message}`);

      result.proposed++;
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // Tasks that dropped out of Todoist's active list (completed or deleted —
  // the REST API doesn't distinguish, and per the design both get the same
  // handling here).
  for (const row of existingBySourceId.values()) {
    if (activeIds.has(row.source_id)) continue;

    try {
      if (!row.task_id) {
        // Never made it past the review queue (still pending/failed, or
        // already rejected) — nothing user-visible happened yet, so just
        // withdraw it rather than proposing a delete for something that was
        // never really "there."
        if (row.proposed_change_id) {
          await supabase
            .from('proposed_changes')
            .update({
              status: 'rejected',
              decided_by: 'auto-apply-policy',
              decided_at: new Date().toISOString(),
            })
            .eq('id', row.proposed_change_id)
            .in('status', ['pending', 'failed']);
        }
        await supabase
          .from('synced_tasks')
          .delete()
          .eq('source_system', 'todoist')
          .eq('source_id', row.source_id);
        result.withdrawnUnscheduled++;
        continue;
      }

      const { data: taskRow, error: taskError } = await supabase
        .from('tasks')
        .select('*')
        .eq('id', row.task_id)
        .maybeSingle();
      if (taskError) throw new Error(`tasks read failed: ${taskError.message}`);

      if (taskRow?.scheduled_event_id) {
        // Already a real calendar event — removing it deserves a tap, same
        // as everywhere else a change touches the calendar.
        await createProposedChange({
          change_type: 'delete',
          category: 'task',
          source_system: 'todoist',
          source_id: row.source_id,
          target_event_id: taskRow.scheduled_event_id,
        });
        result.proposedDeletes++;
      } else if (taskRow) {
        await supabase.from('tasks').update({ status: 'discarded' }).eq('id', row.task_id);
      }

      await supabase
        .from('synced_tasks')
        .delete()
        .eq('source_system', 'todoist')
        .eq('source_id', row.source_id);
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return result;
}
