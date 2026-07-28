import { supabase } from './supabase';
import { createProposedChange } from './proposedChanges';
import { updateTask, type UpdateTaskInput } from './tasksWrite';

// Migrated 2026-07-24 — the old rest/v2 base this pointed at was deprecated
// (410, "endpoint is deprecated... use /api/v1/") and replaced by Todoist's
// unified API. Confirmed live against a real token rather than guessed from
// docs: responses are now `{ results: [...], next_cursor }` (paginated, not
// a flat array), `due.datetime` was folded into `due.date` (a bare
// "YYYY-MM-DD" for all-day, or "YYYY-MM-DDTHH:mm:ss" — no explicit UTC
// offset — when timed), and `created_at` was renamed `added_at`. Todoist's
// own migration notice also states every task/object ID changes under the
// new API — confirmed there were zero existing `synced_tasks` rows for
// `source_system: 'todoist'` at migration time, so there was nothing stale
// to reconcile; if this ever needs re-running against a populated table,
// the old rows' `source_id`s are guaranteed not to match anything the new
// API returns and should be treated as orphaned, not diffed against.
// Also independently defined in lib/todoistWrite.ts (2026-07-25) rather than
// exported/imported from here — todoistSync.ts now imports updateTask from
// lib/tasksWrite.ts (for the Todoist→us edit-sync path below), which itself
// imports lib/todoistWrite.ts (for the push direction), which would create
// a genuine runtime circular value-import (todoistSync → tasksWrite →
// todoistWrite → todoistSync) if this constant were shared that way. A
// duplicated one-line string constant is cheaper than untangling that,
// same tradeoff this codebase already accepts for BURNER_CALENDAR_ID.
const TODOIST_API_BASE = 'https://api.todoist.com/api/v1';

interface TodoistDue {
  date: string; // "YYYY-MM-DD" (all-day) or "YYYY-MM-DDTHH:mm:ss" (timed, no offset) — see todoistDeadline
  timezone: string | null;
}

interface TodoistDuration {
  amount: number;
  unit: 'minute' | 'day';
}

interface TodoistTask {
  id: string;
  content: string;
  description: string;
  due: TodoistDue | null;
  duration: TodoistDuration | null;
  added_at: string;
  checked: boolean;
  is_deleted: boolean;
}

interface TodoistTasksPage {
  results: TodoistTask[];
  next_cursor: string | null;
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

// A bare `due.date` (just "YYYY-MM-DD", no "T") is an all-day due date with
// no attached time — treated as "must be done by end of that day" since
// `deadline` is a constraint, not a scheduled slot (nothing reads it yet
// beyond store-and-round-trip — see backend-schema.md's proposed_changes).
// The timed case ("YYYY-MM-DDTHH:mm:ss") carries no explicit UTC offset
// under the new API (unlike v2's `due.datetime`, which always had one) —
// `due.timezone` has the user's zone when set, but isn't reconciled here;
// not worth the complexity while deadline stays store-and-round-trip only.
function todoistDeadline(due: TodoistDue | null): string | undefined {
  if (!due) return undefined;
  if (due.date.includes('T')) return due.date;
  return `${due.date}T23:59:59Z`;
}

// Todoist's own duration is optional and most tasks won't have one — this is
// a best-effort carry-over, not something every task is expected to have.
// 'day'-unit durations are rare and only approximate once converted to
// minutes, but still more useful than discarding the signal entirely.
function todoistDurationMinutes(duration: TodoistDuration | null): number | undefined {
  if (!duration) return undefined;
  return duration.unit === 'day' ? duration.amount * 24 * 60 : duration.amount;
}

// Todoist → us edit propagation (2026-07-25, two-way sync — "Todoist is
// master," per the user's own framing). Closes a previously explicit,
// accepted gap: a title/deadline/description/duration change made in
// Todoist after intake used to be silently ignored forever (this file's
// git history called it a "create-once limitation"). Deliberately does NOT
// touch priority/tags — those stay reserved for your own judgment at
// review time, same reasoning intake itself already used to leave them
// unset in the first place ("Todoist can't tell us how you want to
// prioritize/organize your own work").
async function syncEditFromTodoist(existing: SyncedTaskRow, task: TodoistTask): Promise<void> {
  const newTitle = task.content;
  const newDescription = task.description || null;
  const newDeadline = todoistDeadline(task.due) ?? null;
  const newDurationMinutes = todoistDurationMinutes(task.duration) ?? null;

  if (existing.task_id) {
    const { data, error } = await supabase.from('tasks').select('*').eq('id', existing.task_id).maybeSingle();
    if (error) throw new Error(`tasks read failed: ${error.message}`);
    if (!data) return; // Row is gone (e.g. already resolved/cleaned up elsewhere) — nothing to sync into.

    const patch: UpdateTaskInput = {};
    if (data.title !== newTitle) patch.title = newTitle;
    if ((data.description ?? null) !== newDescription) patch.description = newDescription;
    if ((data.deadline ?? null) !== newDeadline) patch.deadline = newDeadline;
    if ((data.duration_minutes ?? null) !== newDurationMinutes) patch.duration_minutes = newDurationMinutes;
    if (Object.keys(patch).length === 0) return;

    // skipTodoistPush: true — this edit came FROM Todoist; echoing it
    // straight back would be pointless (Todoist already has it) and adds a
    // failure surface for nothing.
    await updateTask(existing.task_id, patch, { skipTodoistPush: true });
    return;
  }

  if (existing.proposed_change_id) {
    const { data, error } = await supabase
      .from('proposed_changes')
      .select('*')
      .eq('id', existing.proposed_change_id)
      .maybeSingle();
    if (error) throw new Error(`proposed_changes read failed: ${error.message}`);
    // Already decided (approved/rejected outside this sync's own withdrawal
    // path, e.g. a manual reject in the app) — leave it alone rather than
    // editing a resolved row.
    if (!data || (data.status !== 'pending' && data.status !== 'failed')) return;

    const patch: Record<string, unknown> = {};
    if (data.proposed_summary !== newTitle) patch.proposed_summary = newTitle;
    if ((data.proposed_description ?? null) !== newDescription) patch.proposed_description = newDescription;
    if ((data.deadline ?? null) !== newDeadline) patch.deadline = newDeadline;
    if ((data.duration_minutes ?? null) !== newDurationMinutes) patch.duration_minutes = newDurationMinutes;
    if (Object.keys(patch).length === 0) return;

    const { error: updateError } = await supabase
      .from('proposed_changes')
      .update(patch)
      .eq('id', existing.proposed_change_id);
    if (updateError) throw new Error(`proposed_changes update failed: ${updateError.message}`);
  }
}

async function fetchActiveTasks(): Promise<TodoistTask[]> {
  const token = process.env.TODOIST_API_TOKEN;
  if (!token) throw new Error('TODOIST_API_TOKEN is not set');

  const tasks: TodoistTask[] = [];
  let cursor: string | null = null;

  do {
    const url = new URL(`${TODOIST_API_BASE}/tasks`);
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Todoist API error ${res.status}: ${await res.text()}`);
    }
    const page = (await res.json()) as TodoistTasksPage;
    tasks.push(...page.results);
    cursor = page.next_cursor;
  } while (cursor);

  // Defensive: completed/deleted tasks weren't observed in the default
  // listing during migration testing, but filtering explicitly costs
  // nothing and doesn't depend on that default staying stable.
  return tasks.filter((t) => !t.checked && !t.is_deleted);
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
    const existing = existingBySourceId.get(task.id);
    if (existing) {
      result.skippedExisting++;
      try {
        await syncEditFromTodoist(existing, task);
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : String(err));
      }
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
        duration_minutes: todoistDurationMinutes(task.duration),
      });

      const { error: upsertError } = await supabase.from('synced_tasks').upsert(
        {
          source_system: 'todoist',
          source_id: task.id,
          proposed_change_id: proposal.id,
          task_id: null,
          source_updated_at: task.added_at ?? null,
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

      // Status-checked first (2026-07-25, two-way sync) — this task may
      // have vanished from Todoist *because* we pushed a completion there
      // ourselves (lib/aiTasks.ts's completeTask → lib/todoistWrite.ts's
      // pushTaskCompletionToTodoist), not because the user did something
      // directly in Todoist. If it's already resolved on our side, this
      // sync has nothing left to do to the task — just clean up the
      // mapping below. Without this check, a task you completed here (with
      // its calendar event correctly left alone, as a record of when the
      // work happened) would get a spurious calendar-delete proposal or a
      // hard delete on the very next sync, purely as an artifact of our own
      // completion having been pushed out.
      if (taskRow && (taskRow.status === 'completed' || taskRow.status === 'discarded')) {
        // Already resolved — nothing further to do.
      } else if (taskRow?.scheduled_event_id) {
        // Still active and scheduled — Todoist genuinely vanished while
        // this task was still open from our side. Already a real calendar
        // event, so removing it deserves a tap, same as everywhere else a
        // change touches the calendar. lib/proposedChanges.ts's
        // applyProposedChange delete branch hard-deletes the linked task
        // row once this is approved (source_system: 'todoist' there), per
        // "Todoist is master — if it's gone there, it can be safely removed
        // from the list."
        await createProposedChange({
          change_type: 'delete',
          category: 'task',
          source_system: 'todoist',
          source_id: row.source_id,
          target_event_id: taskRow.scheduled_event_id,
        });
        result.proposedDeletes++;
      } else if (taskRow) {
        // Still active, never scheduled — hard delete (changed 2026-07-25,
        // was `status: 'completed'` before). Todoist's API still can't
        // actually distinguish "you checked it off" from "you deleted it"
        // (`checked`/`is_deleted` both just mean "not in the active list" —
        // fetchActiveTasks filters both out identically), so this remains
        // an inference, not a certainty — but the user was explicit:
        // Todoist is the master task manager, and a task gone there can be
        // safely removed from our list too, not just marked done.
        await supabase.from('tasks').delete().eq('id', row.task_id);
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
