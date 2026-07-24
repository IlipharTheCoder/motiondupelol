import { calendar } from './googleCalendar';
import { supabase } from './supabase';
import { encodeEventMetadata, decodeEventMetadata, PRIORITY_RANK, type EventPriority } from './eventMetadata';
import {
  createProposedChange,
  ValidationError,
  ConflictError,
  NotFoundError,
  type ProposedChangeRow,
} from './proposedChanges';

const BURNER_CALENDAR_ID = process.env.GOOGLE_BURNER_CALENDAR_ID!;
const DEFAULT_TASK_DURATION_MINUTES = 30;

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  deadline: string | null;
  priority: EventPriority | null;
  tags: string[] | null;
  duration_minutes: number | null;
  source_system: string;
  source_id: string | null;
  status: 'unscheduled' | 'scheduled' | 'completed' | 'discarded';
  scheduled_event_id: string | null;
  created_at: string;
  updated_at: string;
}

async function getTask(taskId: string): Promise<TaskRow> {
  const { data, error } = await supabase.from('tasks').select('*').eq('id', taskId).maybeSingle();
  if (error) throw new Error(`tasks read failed: ${error.message}`);
  if (!data) throw new NotFoundError(`No task with id "${taskId}"`);
  return data as TaskRow;
}

// Mechanism knob, not a personal target — unlike Focus Time's weekly goal,
// there's a sane universal fallback ("assume half an hour if we truly don't
// know"), so this defaults rather than throwing on unset.
export function getDefaultTaskDurationMinutes(): number {
  const raw = process.env.TASK_DEFAULT_DURATION_MINUTES?.trim();
  const value = raw ? Number(raw) : DEFAULT_TASK_DURATION_MINUTES;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`TASK_DEFAULT_DURATION_MINUTES must be a positive number (got "${raw}")`);
  }
  return value;
}

// task.duration_minutes is deliberately left null in storage when unknown
// (see architecture-plan.md section 4e) rather than backfilled at intake
// time — resolving the fallback only here means changing the env var later
// doesn't require a data migration.
export function resolveTaskDurationMinutes(task: TaskRow): number {
  return task.duration_minutes ?? getDefaultTaskDurationMinutes();
}

// Hours until a task's deadline, clamped to 0 if already overdue (overdue is
// maximally urgent, not "negative urgency"); Infinity for no deadline at all
// (least urgent within whatever priority tier it's in).
export function taskDeadlineUrgencyHours(deadline: string | null, now: Date): number {
  if (!deadline) return Infinity;
  return Math.max(0, (Date.parse(deadline) - now.getTime()) / 3_600_000);
}

// Priority tier always wins (lower PRIORITY_RANK number = more important),
// full stop — deadline urgency only breaks ties within the same tier. An
// overdue "low" task never jumps ahead of a "high" task with no deadline.
// Confirmed as the deliberate choice for now; a deadline-driven
// reprioritization method that lets urgency override tier is a distinct,
// explicitly-deferred future item (backend-build-order.md).
export function compareTasksByPriorityScore(a: TaskRow, b: TaskRow, now: Date): number {
  const rankDiff = PRIORITY_RANK[a.priority ?? 'medium'] - PRIORITY_RANK[b.priority ?? 'medium'];
  if (rankDiff !== 0) return rankDiff;
  const urgencyDiff = taskDeadlineUrgencyHours(a.deadline, now) - taskDeadlineUrgencyHours(b.deadline, now);
  if (urgencyDiff !== 0) return urgencyDiff;
  return a.id.localeCompare(b.id);
}

export function sortTasksByPriorityScore(tasks: TaskRow[], now: Date = new Date()): TaskRow[] {
  return [...tasks].sort((a, b) => compareTasksByPriorityScore(a, b, now));
}

// A single display-only number for GET /api/tasks/next — not used for
// ordering (compareTasksByPriorityScore's lexicographic tier-then-urgency
// comparison is the actual ranking logic), just a human-readable stat that
// happens to sort consistently with it: each priority tier occupies its own
// span, wide enough that urgency alone can never cross a tier boundary.
const TIER_SPAN_HOURS = 24 * 365; // 1 year — comfortably wider than any real deadline urgency
export function taskPriorityScore(task: TaskRow, now: Date = new Date()): number {
  const tierBase = (Object.keys(PRIORITY_RANK).length - PRIORITY_RANK[task.priority ?? 'medium']) * TIER_SPAN_HOURS;
  const urgencyHours = taskDeadlineUrgencyHours(task.deadline, now);
  const urgencyBonus = Number.isFinite(urgencyHours) ? TIER_SPAN_HOURS - urgencyHours : 0;
  return tierBase + urgencyBonus;
}

export interface NextTaskRow extends TaskRow {
  priority_score: number;
}

// "What should I work on next" — read-only, no side effects. Separate from
// GET /api/tasks (which stays a raw, unsorted listing).
export async function getNextTasks(limit: number, now: Date = new Date()): Promise<NextTaskRow[]> {
  const { data, error } = await supabase.from('tasks').select('*').eq('status', 'unscheduled');
  if (error) throw new Error(`tasks read failed: ${error.message}`);

  const sorted = sortTasksByPriorityScore((data ?? []) as TaskRow[], now).slice(0, limit);
  return sorted.map((task) => ({ ...task, priority_score: taskPriorityScore(task, now) }));
}

function assertUnscheduled(task: TaskRow): void {
  if (task.status !== 'unscheduled') {
    throw new ConflictError(`Task "${task.title}" is already "${task.status}", not "unscheduled"`);
  }
}

export type ScheduleTaskActor = 'user' | 'ai-engine';

export interface LinkTaskResult {
  mode: 'linked-directly' | 'linked-via-proposal';
  task?: TaskRow;
  proposal?: ProposedChangeRow;
}

// Ties a task to a calendar event that already exists (e.g. an existing
// Focus Time block) — this is bookkeeping (which block is this task for),
// not a scheduling decision: it doesn't create, move, or delete any
// calendar time. Whether that applies immediately or waits for approval
// depends on who's asking: you (actor: 'user') get it applied right away;
// the engine (actor: 'ai-engine') has to propose it through the normal
// review queue first, same as every other calendar write it makes.
export async function linkTaskToExistingEvent(
  taskId: string,
  eventId: string,
  actor: ScheduleTaskActor
): Promise<LinkTaskResult> {
  const task = await getTask(taskId);
  assertUnscheduled(task);

  if (actor === 'user') {
    let existing;
    try {
      ({ data: existing } = await calendar.events.get({ calendarId: BURNER_CALENDAR_ID, eventId }));
    } catch (err) {
      const status = (err as { code?: number; response?: { status?: number } }).code;
      if (status === 404 || status === 410) {
        throw new NotFoundError(`No calendar event with id "${eventId}"`);
      }
      throw err;
    }

    const existingMeta = decodeEventMetadata(existing.extendedProperties);
    await calendar.events.patch({
      calendarId: BURNER_CALENDAR_ID,
      eventId,
      requestBody: {
        extendedProperties: {
          private: encodeEventMetadata({
            schemaVersion: '1',
            type: existingMeta.type ?? 'task',
            flexible: existingMeta.flexible ?? 'true',
            sourceSystem: 'ai-engine',
            sourceId: taskId,
            sourceCalendarId: existingMeta.sourceCalendarId ?? '',
            sourceLabel: existingMeta.sourceLabel ?? '',
            priority: existingMeta.priority ?? 'medium',
            colorTag: existingMeta.colorTag ?? '',
            deadline: existingMeta.deadline ?? '',
            tags: existingMeta.tags ?? '',
          }),
        },
      },
    });

    const { data: updatedTask, error } = await supabase
      .from('tasks')
      .update({ status: 'scheduled', scheduled_event_id: eventId })
      .eq('id', taskId)
      .select('*')
      .single();
    if (error) throw new Error(`tasks update failed: ${error.message}`);

    return { mode: 'linked-directly', task: updatedTask as TaskRow };
  }

  // actor === 'ai-engine': propose it — 'category' is a required field but
  // effectively a placeholder here, since applyProposedChange's 'update'
  // branch always keeps the target event's own existing category
  // (existingMeta.type wins over row.category for anything already real).
  const proposal = await createProposedChange({
    change_type: 'update',
    category: 'task',
    source_system: 'ai-engine',
    source_id: taskId,
    target_event_id: eventId,
    reason: `Link task "${task.title}" to an existing calendar event`,
  });

  return { mode: 'linked-via-proposal', proposal };
}

export interface CreateTaskEventResult {
  mode: 'created-via-proposal';
  proposal: ProposedChangeRow;
}

// Gives a task a brand-new calendar block — this genuinely creates calendar
// time, so unlike linking to something that already exists, this always
// goes through the normal proposed_changes review queue regardless of who's
// asking (same as every other create in this backend).
export async function scheduleTaskToNewEvent(
  taskId: string,
  proposedStart: string,
  proposedEnd: string,
  bumpIfMovable = false,
  ignoreSchedulingRules = false
): Promise<CreateTaskEventResult> {
  const task = await getTask(taskId);
  assertUnscheduled(task);

  if (Number.isNaN(Date.parse(proposedStart)) || Number.isNaN(Date.parse(proposedEnd))) {
    throw new ValidationError('"proposed_start"/"proposed_end" must be valid ISO datetimes');
  }
  if (Date.parse(proposedEnd) <= Date.parse(proposedStart)) {
    throw new ValidationError('"proposed_end" must be later than "proposed_start"');
  }

  const proposal = await createProposedChange({
    change_type: 'create',
    category: 'task',
    flexible: 'true',
    priority: task.priority ?? 'medium',
    source_system: 'ai-engine',
    source_id: taskId,
    proposed_summary: task.title,
    proposed_description: task.description ?? undefined,
    deadline: task.deadline ?? undefined,
    duration_minutes: task.duration_minutes ?? undefined,
    proposed_start: proposedStart,
    proposed_end: proposedEnd,
    bump_if_movable: bumpIfMovable,
    ignore_scheduling_rules: ignoreSchedulingRules,
    reason: `Schedule task "${task.title}" onto the calendar`,
  });

  return { mode: 'created-via-proposal', proposal };
}
