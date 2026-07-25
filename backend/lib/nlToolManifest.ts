// Tool schemas for the Phase 5 NL chat layer — this is the stable/cacheable
// half of app/api/chat/route.ts's system prompt (goes before the
// cache_control breakpoint, alongside the behavioral rules text).
//
// Complete rebuild (2026-07-25): trimmed from 33 tools down to exactly 2,
// per an explicit user decision — the prior surface was too large for
// claude-haiku-4-5 to reliably keep track of. This is deliberately not a
// "cut the least-used tools" trim; it's a hard reset to the smallest useful
// surface: propose a calendar change (create/move/delete), and find free
// time. Everything else (tasks, habits, scheduling rules, batch/group
// operations, bulk-edit, recurring series, relocate, reschedule/rebalance,
// focus/buffer/task/habit auto-placement, approve/reject/revert, capability
// logging, progressive-disclosure reference docs) is gone from chat
// entirely — still reachable through the direct API (`backend-api-reference.md`),
// just not from this conversation.
//
// No approve/reject/revert tool exists — this is structural, not a prompt
// instruction: the model cannot apply anything it proposes even if it tried.
// lib/nlToolDispatch.ts additionally forces `skipAutoApply: true` on every
// proposal this layer creates, so even a category later added to
// AUTO_APPLY_CATEGORIES can never bypass manual review through this path.
//
// Grown to 5 tools (2026-07-25, same day): added list_tasks (read-only),
// assign_task_to_event, and unassign_task — "assign a task to focus time/an
// event" needed the model to see task ids (list_tasks) and to write the
// link (assign_task_to_event, always a proposal — see nlToolDispatch.ts).
// unassign_task is instant/unproposed, matching the direct API's own
// unscheduleTask precedent (pure tasks-table bookkeeping, never touches the
// calendar). This is still a deliberate, narrow grow — not a return to the
// old 33-tool surface — each addition maps onto one already-built
// lib/aiTasks.ts function.
//
// Same day: propose_calendar_change dropped its `priority` field entirely,
// and find_free_time dropped `category`/`tags` and now ignores working
// hours/scheduling_rules — see nlToolDispatch.ts's dispatch cases for both.
//
// Grown to 6 tools (2026-07-25, same day): added create_task, wrapping
// lib/tasksWrite.ts's createTask — the same function POST /api/tasks calls,
// which was itself refactored out of that route specifically in
// anticipation of this tool (see that file's own top comment) but never
// actually got one until now. Instant/unproposed, matching that endpoint's
// existing behavior exactly (a task the user states directly isn't
// external unreviewed data, so it isn't gated behind review — same
// reasoning POST /api/tasks and unassign_task already rely on). Unlike a
// calendar-block's priority, task priority is a separate concern the user
// explicitly confirmed is fine for the model to set directly here, same as
// the direct API already allows at creation time.
import type Anthropic from '@anthropic-ai/sdk';
import { BURNER_EVENT_TYPES, EVENT_PRIORITIES } from './eventMetadata';

const CHANGE_TYPES = ['create', 'move', 'delete'];

export const NL_TOOLS: Anthropic.Tool[] = [
  {
    name: 'propose_calendar_change',
    description:
      'Propose creating, moving, or deleting a calendar event (a normal block, focus time, a meeting, a buffer — any category). This only ever creates a "pending" proposal in the review queue — it never applies anything to the real calendar. The user must approve it themselves through the app; you cannot approve it, and there is no way to make this apply automatically. Priority is deliberately not a parameter here — the user always decides priority themselves when they review a create, not you.',
    input_schema: {
      type: 'object',
      properties: {
        change_type: { type: 'string', enum: CHANGE_TYPES, description: 'What kind of change this is.' },
        category: { type: 'string', enum: BURNER_EVENT_TYPES, description: 'Always required, regardless of change_type.' },
        target_event_id: { type: 'string', description: 'Required for move/delete. Must be omitted for create. Get this from the calendar digest already in context — there is no separate lookup tool.' },
        proposed_start: { type: 'string', description: 'ISO datetime. Required for create and move.' },
        proposed_end: { type: 'string', description: 'ISO datetime. Required alongside proposed_start.' },
        proposed_summary: { type: 'string', description: 'Required for create — the event title.' },
        proposed_description: { type: 'string' },
        flexible: { type: 'string', enum: ['true', 'false'], description: 'Only meaningful for create.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Only meaningful for create.' },
        reason: { type: 'string', description: 'A short human-readable justification, shown in the review queue.' },
      },
      required: ['change_type', 'category'],
    },
  },
  {
    name: 'find_free_time',
    description:
      'Find genuinely open time windows in a range — only excludes real calendar conflicts, not working hours or standing scheduling rules (unlike every other free-time search in this backend, this one is unrestricted). Use your own judgment to suggest reasonable times from what comes back rather than assuming every slot is equally appropriate to propose. Read-only — does not create or change anything. Use this before propose_calendar_change when the user hasn\'t named an exact time themselves.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO datetime.' },
        to: { type: 'string', description: 'ISO datetime.' },
        min_duration_minutes: { type: 'number' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'list_tasks',
    description:
      'List your unscheduled tasks (id, title, deadline, priority, duration), ranked most-urgent first. Read-only. Use this to find a task\'s id before calling assign_task_to_event.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max tasks to return. Defaults to 20.' },
      },
    },
  },
  {
    name: 'assign_task_to_event',
    description:
      'Assign an unscheduled task to a calendar block — either linking it to a block that already exists (e.g. an existing Focus Time event) or proposing a brand-new event for it. Provide exactly one of event_id, or both proposed_start and proposed_end — never neither, never both. Always creates a "pending" proposal in the review queue, same guarantee as propose_calendar_change; it never applies directly, even though a human using the app directly can link to an existing event instantly.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task to assign. Get this from list_tasks.' },
        event_id: { type: 'string', description: 'Link to this already-existing event. Get it from the calendar digest already in context.' },
        proposed_start: { type: 'string', description: 'ISO datetime — create a new event for the task starting here. Provide together with proposed_end, and omit event_id.' },
        proposed_end: { type: 'string', description: 'ISO datetime. Required alongside proposed_start.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'unassign_task',
    description:
      'Detach a scheduled task from its calendar event — the event itself is untouched, only the task\'s own status/link is cleared. Applies immediately; this is task-list bookkeeping, not a calendar write, so unlike every other write tool here it does not go through the review queue (same as the direct API).',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task to unassign. Must currently be scheduled.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'create_task',
    description:
      'Add a new task to the task list, optionally with a deadline — for something to track, not necessarily to put on the calendar yet. Applies immediately, no approval needed; this only inserts into the task list, it never touches the calendar. Use assign_task_to_event separately afterward if the user also wants it placed onto the calendar right away.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Required.' },
        description: { type: 'string' },
        deadline: { type: 'string', description: 'ISO datetime — a "must be done by" constraint. Optional.' },
        priority: { type: 'string', enum: EVENT_PRIORITIES },
        duration_minutes: { type: 'number', description: 'Expected time to complete, in minutes.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
  },
];
