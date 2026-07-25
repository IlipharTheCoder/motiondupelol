import { runSync, type SyncRunResult } from './calendarSync';
import { runTodoistSync, type TodoistSyncResult } from './todoistSync';

export interface RefreshResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  calendar: SyncRunResult | { error: string };
  todoist: TodoistSyncResult | { error: string };
}

// A single entry point for "get me fresh data" — fans out to the existing
// on-demand sync engines (external calendars, Todoist) in parallel rather
// than making a caller sequence two calls with two different response
// shapes. Extracted out of app/api/refresh/route.ts so the NL chat layer's
// refresh_data tool (lib/nlToolDispatch.ts) can call the exact same logic
// in-process rather than duplicating it or making an HTTP self-call.
// Canvas sync is deliberately not included — it's on hiatus pending API
// access (backend-api-reference.md) and would just always fail today; add
// it here once CANVAS_API_TOKEN/CANVAS_BASE_URL are real.
//
// Each source's failure is caught independently, same "one thing failing
// doesn't block the rest" principle as every other fan-out in this codebase
// (POST /api/calendar/sync's per-calendar isolation, batch proposals,
// bulk-edit) — a Todoist outage shouldn't prevent the calendar sync from
// running, or vice versa.
export async function runRefresh(): Promise<RefreshResult> {
  const startedAt = new Date().toISOString();

  const [calendar, todoist] = await Promise.all([
    runSync().then(
      (result): { ok: true; result: SyncRunResult } => ({ ok: true, result }),
      (error): { ok: false; error: string } => ({ ok: false, error: (error as Error).message })
    ),
    runTodoistSync().then(
      (result): { ok: true; result: TodoistSyncResult } => ({ ok: true, result }),
      (error): { ok: false; error: string } => ({ ok: false, error: (error as Error).message })
    ),
  ]);

  const finishedAt = new Date().toISOString();

  return {
    startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    calendar: calendar.ok ? calendar.result : { error: calendar.error },
    todoist: todoist.ok ? todoist.result : { error: todoist.error },
  };
}
