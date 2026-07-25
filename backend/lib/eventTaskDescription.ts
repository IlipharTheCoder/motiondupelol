// Keeps a calendar event's description in sync with whichever tasks are
// currently linked to it (2026-07-25) — "focus times can hold multiple
// tasks" is a deliberate key feature (backend-build-order.md), so a block's
// description needs to reflect the *current* full set, not just whichever
// task linked most recently (the same reason GET /api/tasks's
// scheduled_event_id filter exists instead of trusting the event's own
// metadata, which can only ever hold one task id).
//
// The generated block lives inside delimited markers (lib/eventTaskDescriptionFormat.ts)
// so any other text in the description (a note you wrote, or
// propose_calendar_change's own proposed_description) survives being
// regenerated — this only ever replaces what's between the markers.
import { calendar } from './googleCalendar';
import { supabase } from './supabase';
import { getSchedulingConfig } from './schedulingConfig';
import { buildTasksSection, withTasksSection } from './eventTaskDescriptionFormat';
import type { TaskRow } from './aiTasks';

const BURNER_CALENDAR_ID = process.env.GOOGLE_BURNER_CALENDAR_ID!;

// Best-effort by convention at every call site (never lets a description
// write failure undo an already-successful task link/unlink) — throws here,
// callers decide how to handle it.
export async function syncEventTaskDescription(eventId: string): Promise<void> {
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('scheduled_event_id', eventId)
    .eq('status', 'scheduled')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`tasks read failed: ${error.message}`);
  const tasks = (data ?? []) as TaskRow[];

  const { homeTimezone } = getSchedulingConfig();
  const { data: event } = await calendar.events.get({ calendarId: BURNER_CALENDAR_ID, eventId });
  const newDescription = withTasksSection(
    event.description ?? '',
    tasks.length > 0 ? buildTasksSection(tasks, homeTimezone) : null
  );

  await calendar.events.patch({
    calendarId: BURNER_CALENDAR_ID,
    eventId,
    requestBody: { description: newDescription },
  });
}
