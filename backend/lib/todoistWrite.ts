// The reverse direction of lib/todoistSync.ts (2026-07-25, two-way sync) —
// pushes a task that changed here out to Todoist, in real time (same
// request as the triggering action), rather than waiting for the next sync
// cycle. Every export here is meant to be called best-effort by its caller
// (wrapped in try/catch, swallowed on failure) — a Todoist outage or API
// error should never block the primary action (creating/completing/editing
// a task in our own system), which remains the thing that actually
// succeeded first. This file itself doesn't swallow anything; it throws
// plain Errors and lets the caller decide.
//
// Scoped deliberately: only lib/tasksWrite.ts's createTask/updateTask and
// lib/aiTasks.ts's completeTask call into this — i.e. only tasks that
// originate as `source_system: 'manual'` (direct API or chat's create_task,
// which calls the same createTask). Canvas-sourced tasks and any future
// chat-driven task-list-intake via propose_calendar_change are NOT pushed
// here — bouncing external-origin data (Canvas assignments) back out to a
// different external system (Todoist) doesn't obviously make sense, and
// wasn't asked for.
import { supabase } from './supabase';
import type { TaskRow } from './aiTasks';

// Independently defined, not imported from lib/todoistSync.ts — see that
// file's own comment on this same constant for why (breaks a genuine
// runtime circular value-import between this file, lib/tasksWrite.ts, and
// lib/todoistSync.ts).
const TODOIST_API_BASE = 'https://api.todoist.com/api/v1';

// Todoist's well-established API convention: priority is 1-4, where 4 is
// the highest ("P1" in the UI, urgent/red) and 1 is the lowest ("P4",
// default). NOT independently live-verified against a real token the way
// this codebase's read-side Todoist integration was (see todoistSync.ts's
// migration comment) — creating throwaway test tasks in the user's real
// Todoist account to confirm felt like the wrong tradeoff. If a pushed
// task's priority shows up inverted in Todoist's UI, this mapping is why —
// flip it here.
const PRIORITY_TO_TODOIST: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function todoistHeaders(): Record<string, string> {
  const token = process.env.TODOIST_API_TOKEN;
  if (!token) throw new Error('TODOIST_API_TOKEN is not set');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Shared by create and edit — Todoist's create/update endpoints accept the
// same field set (POST /tasks and POST /tasks/{id} respectively).
function buildTodoistTaskBody(task: TaskRow): Record<string, unknown> {
  const body: Record<string, unknown> = { content: task.title };
  if (task.description) body.description = task.description;
  // Our stored `deadline` is always a full ISO datetime (todoistDeadline in
  // todoistSync.ts coerces even an originally-all-day Todoist due date to
  // end-of-day), so due_datetime is always the right field here — pushing a
  // task back to Todoist after we've touched it always carries an explicit
  // time, even if it started as a bare due-date. A known, accepted fidelity
  // loss, not a bug — matches this codebase's existing "not worth the
  // complexity" stance on Todoist due-date/timezone edge cases.
  if (task.deadline) body.due_datetime = task.deadline;
  if (task.duration_minutes) body.duration = { amount: task.duration_minutes, unit: 'minute' };
  if (task.priority && PRIORITY_TO_TODOIST[task.priority] !== undefined) {
    body.priority = PRIORITY_TO_TODOIST[task.priority];
  }
  return body;
}

interface TodoistTaskResponse {
  id: string;
}

// Creates a new task in Todoist for a task that originated here — the
// reverse of todoistSync.ts's intake. Records the mapping in synced_tasks
// immediately (task_id already known, unlike the Todoist-origin case where
// it starts null and only gets linked once the intake proposal is
// approved) so the next runTodoistSync() diff recognizes this task as
// already-tracked rather than re-proposing it as "new," and so later
// completions/edits know where to push.
export async function pushNewTaskToTodoist(task: TaskRow): Promise<void> {
  const res = await fetch(`${TODOIST_API_BASE}/tasks`, {
    method: 'POST',
    headers: todoistHeaders(),
    body: JSON.stringify(buildTodoistTaskBody(task)),
  });
  if (!res.ok) {
    throw new Error(`Todoist create failed (${res.status}): ${await res.text()}`);
  }
  const created = (await res.json()) as TodoistTaskResponse;

  const { error } = await supabase.from('synced_tasks').upsert(
    {
      source_system: 'todoist',
      source_id: created.id,
      proposed_change_id: null,
      task_id: task.id,
      source_updated_at: new Date().toISOString(),
    },
    { onConflict: 'source_system,source_id' }
  );
  if (error) throw new Error(`synced_tasks upsert failed: ${error.message}`);
}

async function findTodoistId(taskId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('synced_tasks')
    .select('source_id')
    .eq('source_system', 'todoist')
    .eq('task_id', taskId)
    .maybeSingle();
  if (error) throw new Error(`synced_tasks read failed: ${error.message}`);
  return (data as { source_id: string } | null)?.source_id ?? null;
}

// No-op (not an error) if this task was never pushed/synced to Todoist in
// the first place — most tasks won't be.
export async function pushTaskCompletionToTodoist(task: TaskRow): Promise<void> {
  const todoistId = await findTodoistId(task.id);
  if (!todoistId) return;

  const res = await fetch(`${TODOIST_API_BASE}/tasks/${todoistId}/close`, {
    method: 'POST',
    headers: todoistHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Todoist close failed (${res.status}): ${await res.text()}`);
  }
}

// Same no-op-if-unsynced rule as pushTaskCompletionToTodoist.
//
// Known, disclosed risk: if this push fails (silently, since every call
// site treats it as best-effort), Todoist's copy stays stale relative to
// ours. The next runTodoistSync() run compares Todoist's (now-stale) title
// against ours and — per "Todoist is master" — overwrites our edit right
// back to the old value, effectively silently reverting it. Not solved
// here (would need a retry queue or a way to distinguish "we just pushed
// this" from "Todoist genuinely changed it," neither of which was asked
// for); flagged so it's a known tradeoff, not a hidden one.
export async function pushTaskEditToTodoist(task: TaskRow): Promise<void> {
  const todoistId = await findTodoistId(task.id);
  if (!todoistId) return;

  const res = await fetch(`${TODOIST_API_BASE}/tasks/${todoistId}`, {
    method: 'POST',
    headers: todoistHeaders(),
    body: JSON.stringify(buildTodoistTaskBody(task)),
  });
  if (!res.ok) {
    throw new Error(`Todoist update failed (${res.status}): ${await res.text()}`);
  }
}
