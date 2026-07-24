// Tool schemas for the Phase 5 NL chat layer — this is the stable/cacheable
// half of app/api/chat/route.ts's system prompt (goes before the
// cache_control breakpoint, alongside the behavioral rules text and enums).
// Kept as TS constants rather than a root-level .md file (unlike
// nl-reference/*.md's longer-form docs) because this content is functionally
// code: every field name here must exactly track a real function signature,
// and having them live next to lib/nlToolDispatch.ts's switch statement
// means a signature drift is easy to catch by inspection.
//
// Field-name casing is NOT uniform across tools — this is a real, confirmed
// gotcha (see nl-reference/casing.md, loaded via read_reference): rows from
// proposed_changes/scheduling_rules/tasks/habits are snake_case throughout,
// even in responses. Purpose-built summary objects (batch, bulk-edit,
// recurring, relocate, group-decision) are camelCase at the top level, but
// bulk_edit's result is camelCase on top (rangeStart, eventsMatched,
// proposalsCreated) while its nested `filters` echo object is snake_case
// (starts_after, priority_in, ...). Every schema below matches its target
// function's real parameter names exactly, not a uniform convention.
import type Anthropic from '@anthropic-ai/sdk';
import { BURNER_EVENT_TYPES, EVENT_PRIORITIES } from './eventMetadata';
import { HABIT_CADENCES, HABIT_STATUSES } from './habits';
import { SCHEDULING_RULE_CATEGORIES } from './schedulingRules';

const CHANGE_TYPES = ['create', 'move', 'update', 'delete'];
const PROPOSAL_STATUSES = ['pending', 'applied', 'rejected', 'failed'];
const BULK_EDIT_ACTIONS = ['update', 'delete', 'move'];
const TASK_STATUSES = ['unscheduled', 'scheduled', 'completed', 'discarded'];

// A single proposal's fields, reused inline by both propose_change and
// propose_batch — deliberately omits `source_system`: the dispatcher always
// forces this to 'ai-engine' (lib/nlToolDispatch.ts), never model-settable,
// same reasoning lib/recurringEvents.ts's planRecurringSeries already
// documents for its own source_system fixing.
const PROPOSAL_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    change_type: { type: 'string', enum: CHANGE_TYPES, description: 'What kind of change this is.' },
    category: { type: 'string', enum: BURNER_EVENT_TYPES },
    target_event_id: { type: 'string', description: 'Required for move/update/delete; must be omitted for create.' },
    proposed_start: { type: 'string', description: 'ISO datetime. Required for move; required for create unless category is "task".' },
    proposed_end: { type: 'string', description: 'ISO datetime. Required alongside proposed_start.' },
    proposed_summary: { type: 'string', description: 'Required for create.' },
    proposed_description: { type: 'string' },
    priority: { type: 'string', enum: EVENT_PRIORITIES },
    flexible: { type: 'string', enum: ['true', 'false'] },
    tags: { type: 'array', items: { type: 'string' } },
    duration_minutes: { type: 'number' },
    deadline: { type: 'string', description: 'ISO date/datetime.' },
    reason: { type: 'string' },
    bump_if_movable: {
      type: 'boolean',
      description: 'Only meaningful for create/move. If the slot conflicts with a lower-priority flexible event, propose relocating that event instead of failing outright.',
    },
    ignore_scheduling_rules: {
      type: 'boolean',
      description: 'Only meaningful for create/move. Bypasses standing scheduling_rules for this one write — use only when the user explicitly says to override a rule.',
    },
  },
  required: ['change_type', 'category'],
};

export const NL_TOOLS: Anthropic.Tool[] = [
  // ---------- Read ----------
  {
    name: 'get_calendar_events',
    description: 'List real calendar events in a time range, with an optional free-text search. Use for anything wider than what the always-injected calendar digest already covers.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO datetime, inclusive. Defaults to now if omitted.' },
        to: { type: 'string', description: 'ISO datetime, exclusive.' },
        q: { type: 'string', description: 'Free-text search over summary/description.' },
        maxResults: { type: 'number' },
      },
    },
  },
  {
    name: 'get_free_slots',
    description: 'Find open time windows in a range, honoring working hours and any active scheduling_rules scoped to the given category/tags.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO datetime.' },
        to: { type: 'string', description: 'ISO datetime.' },
        min_duration_minutes: { type: 'number' },
        category: { type: 'string', enum: BURNER_EVENT_TYPES, description: 'Narrows which scheduling_rules apply.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'list_proposed_changes',
    description: 'List proposals from the review queue, optionally filtered by status or by a proposal group id. The always-injected open-state context already includes pending ones — use this for a different status (e.g. "applied", "rejected") or a specific group.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: PROPOSAL_STATUSES },
        group_id: { type: 'string' },
      },
    },
  },
  {
    name: 'get_next_tasks',
    description: 'The top N unscheduled tasks ranked by priority and deadline urgency — "what should I work on next."',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number' } },
      required: ['limit'],
    },
  },
  {
    name: 'list_tasks',
    description: 'Raw, unsorted listing of tasks, optionally filtered by status.',
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: TASK_STATUSES } },
    },
  },

  // ---------- Propose (writes into proposed_changes; never bypass review) ----------
  {
    name: 'propose_change',
    description: 'Create a single proposed change (create/move/update/delete a calendar event, or a task-list intake). Lands "pending" and needs a manual approval tap — nothing here applies automatically. For more than one proposal from the same request, prefer propose_batch instead.',
    input_schema: PROPOSAL_INPUT_SCHEMA,
  },
  {
    name: 'propose_batch',
    description: 'Create several proposed changes as one group, approvable/rejectable together. Use this whenever a single request naturally produces more than one proposal (e.g. "move everything after 3pm").',
    input_schema: {
      type: 'object',
      properties: {
        proposals: { type: 'array', items: PROPOSAL_INPUT_SCHEMA, description: 'Non-empty, at most 50 items.' },
        reason: { type: 'string', description: 'Shared fallback reason for items that omit their own.' },
      },
      required: ['proposals'],
    },
  },
  {
    name: 'bulk_edit',
    description: 'Find events matching filters within a range and propose the same update/delete/move for all of them, as one group. Note: the result is camelCase at the top level (rangeStart, eventsMatched, proposalsCreated) but its nested "filters" echo object is snake_case (starts_after, priority_in, ...) — see read_reference("casing") for details.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO datetime.' },
        to: { type: 'string', description: 'ISO datetime.' },
        action: { type: 'string', enum: BULK_EDIT_ACTIONS },
        tag: { type: 'string', description: 'Match filter.' },
        category: { type: 'array', items: { type: 'string', enum: BURNER_EVENT_TYPES }, description: 'Match filter.' },
        priority_in: { type: 'array', items: { type: 'string', enum: EVENT_PRIORITIES }, description: 'Match filter — events whose CURRENT priority is one of these. Not the same as "priority" below.' },
        starts_after: { type: 'string', description: 'Match filter, "HH:mm" local time-of-day, inclusive.' },
        starts_before: { type: 'string', description: 'Match filter, "HH:mm" local time-of-day, exclusive.' },
        summary_contains: { type: 'string', description: 'Match filter, case-insensitive substring.' },
        exclude_event_ids: { type: 'array', items: { type: 'string' }, description: 'Event ids to exclude even if they otherwise match — e.g. "cancel my meetings except the manager one".' },
        proposed_summary: { type: 'string', description: 'For action "update": new summary to set.' },
        proposed_description: { type: 'string' },
        priority: { type: 'string', enum: EVENT_PRIORITIES, description: 'For action "update": priority to SET on matches — distinct from priority_in above.' },
        deadline: { type: 'string' },
        tags_add: { type: 'array', items: { type: 'string' } },
        tags_remove: { type: 'array', items: { type: 'string' } },
        time_delta_minutes: { type: 'number', description: 'For action "move": shift by this many minutes (negative = earlier).' },
        reason: { type: 'string' },
      },
      required: ['from', 'to', 'action'],
    },
  },
  {
    name: 'create_recurring_series',
    description: 'Propose a weekly-recurring series as N individual create proposals sharing one system-generated series:<uuid> tag — "cancel/move the whole series" later is just a bulk_edit by that tag.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: BURNER_EVENT_TYPES },
        proposed_summary: { type: 'string' },
        proposed_description: { type: 'string' },
        priority: { type: 'string', enum: EVENT_PRIORITIES },
        flexible: { type: 'string', enum: ['true', 'false'] },
        first_start: { type: 'string', description: 'ISO datetime of the first occurrence.' },
        first_end: { type: 'string' },
        interval_weeks: { type: 'number', description: 'Defaults to 1 (every week).' },
        count: { type: 'number', description: 'Exactly one of count/until is required.' },
        until: { type: 'string', description: 'ISO datetime. Exactly one of count/until is required.' },
        weekdays: { type: 'array', items: { type: 'number' }, description: '1=Monday..7=Sunday. Omit for the same weekday as first_start every interval.' },
        skip_dates: { type: 'array', items: { type: 'string' }, description: 'ISO dates to skip (e.g. holidays).' },
        tags: { type: 'array', items: { type: 'string' } },
        bump_if_movable: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['category', 'proposed_summary', 'first_start', 'first_end'],
    },
  },
  {
    name: 'relocate_event',
    description: 'Find a new slot for one specific existing timed event and propose moving it there. Rejects all-day events. Does not gate on the event\'s own "flexible" tag.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        search_from: { type: 'string', description: 'ISO datetime. Defaults to now.' },
        search_to: { type: 'string', description: 'ISO datetime. Defaults to a 14-day horizon from search_from.' },
        bump_if_movable: { type: 'boolean' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'reschedule_conflicts',
    description: 'Scan a range for calendar conflicts and propose moves to resolve them.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO datetime.' },
        to: { type: 'string', description: 'ISO datetime.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'rebalance_day',
    description: 'If a range is overloaded past a busy-minutes threshold, propose moving lower-priority flexible items later within a search window, to flatten the load.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO datetime — the range to check for overload.' },
        to: { type: 'string', description: 'ISO datetime.' },
        max_busy_minutes: { type: 'number', description: 'Threshold above which the range is considered overloaded.' },
        search_end: { type: 'string', description: 'ISO datetime, later than "to" — how far out to search for new slots for anything moved.' },
      },
      required: ['from', 'to', 'max_busy_minutes', 'search_end'],
    },
  },
  {
    name: 'plan_focus_time',
    description: 'Auto-schedule focusTime blocks toward this week\'s Deep Work goal, for the current week.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'plan_buffer_time',
    description: 'Propose buffer blocks around existing events in a range.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO datetime.' },
        to: { type: 'string', description: 'ISO datetime.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'plan_tasks',
    description: 'Auto-place unscheduled tasks onto the calendar within a range, ranked by priority/deadline urgency.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO datetime.' },
        to: { type: 'string', description: 'ISO datetime.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'plan_habits',
    description: 'Auto-place this period\'s remaining habit occurrences onto the calendar.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'schedule_task',
    description: 'Attach an unscheduled task to the calendar — provide exactly one of "event_id" (link to an already-existing event) or "proposed_start"+"proposed_end" (create a new event for it). Providing both or neither is an error.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        event_id: { type: 'string', description: 'Link to this already-existing event instead of creating one.' },
        proposed_start: { type: 'string', description: 'ISO datetime — creates a new event instead of linking.' },
        proposed_end: { type: 'string' },
        bump_if_movable: { type: 'boolean', description: 'Only used with proposed_start/proposed_end.' },
        ignore_scheduling_rules: { type: 'boolean', description: 'Only used with proposed_start/proposed_end.' },
      },
      required: ['task_id'],
    },
  },

  // ---------- Decision / meta over existing proposals ----------
  {
    name: 'approve_proposal',
    description: 'Approve and apply a single pending/failed proposal.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'reject_proposal',
    description: 'Reject a single pending/failed proposal without applying it.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'revert_proposal',
    description: 'Create a compensating proposal that undoes an already-applied change ("undo that"). This only CREATES the undo proposal — it lands pending. To actually finish undoing, call approve_proposal on the id this returns; do not tell the user it is undone until that second step succeeds.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'approve_proposal_group',
    description: 'Approve every still-open proposal in a group (e.g. from propose_batch or bulk_edit) as one unit.',
    input_schema: { type: 'object', properties: { group_id: { type: 'string' } }, required: ['group_id'] },
  },
  {
    name: 'reject_proposal_group',
    description: 'Reject every still-open proposal in a group as one unit.',
    input_schema: { type: 'object', properties: { group_id: { type: 'string' } }, required: ['group_id'] },
  },
  {
    name: 'edit_pending_proposal',
    description: 'Adjust priority/tags/duration_minutes on a still-pending proposal before it gets approved.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        priority: { type: 'string', enum: EVENT_PRIORITIES },
        tags: { type: 'array', items: { type: 'string' } },
        duration_minutes: { type: 'number' },
      },
      required: ['id'],
    },
  },

  // ---------- Direct-write (bypass the review queue — declarations, not calendar writes) ----------
  {
    name: 'create_task',
    description: 'Create a task record directly (not a calendar write — tasks are a "declaration", scheduled later via schedule_task/plan_tasks).',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        deadline: { type: 'string', description: 'ISO date/datetime.' },
        priority: { type: 'string', enum: EVENT_PRIORITIES },
        duration_minutes: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
  },
  {
    name: 'create_habit',
    description: 'Create a habit record directly.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        cadence: { type: 'string', enum: HABIT_CADENCES },
        interval_days: { type: 'number', description: 'Required if cadence is "interval".' },
        target_count: { type: 'number' },
        occurrence_duration_minutes: { type: 'number' },
        priority: { type: 'string', enum: EVENT_PRIORITIES },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'cadence', 'target_count'],
    },
  },
  {
    name: 'update_habit',
    description: 'Update an existing habit — also used to pause/resume it via "status".',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        cadence: { type: 'string', enum: HABIT_CADENCES },
        interval_days: { type: 'number' },
        target_count: { type: 'number' },
        occurrence_duration_minutes: { type: 'number' },
        priority: { type: 'string', enum: EVENT_PRIORITIES },
        tags: { type: 'array', items: { type: 'string' } },
        status: { type: 'string', enum: HABIT_STATUSES },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_scheduling_rule',
    description: 'Create a standing scheduling rule ("never before 9am on weekdays"). Scoped to a category XOR a tag XOR neither (global) — never both. At least one of starts_after/starts_before is required. Every write goes through this rule automatically once active; it is not itself a calendar write.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        category: { type: 'string', enum: SCHEDULING_RULE_CATEGORIES },
        tag: { type: 'string' },
        starts_after: { type: 'string', description: '"HH:mm" local time, inclusive lower bound.' },
        starts_before: { type: 'string', description: '"HH:mm" local time, exclusive upper bound.' },
        weekdays: { type: 'array', items: { type: 'number' }, description: '1=Monday..7=Sunday. Omit for every day.' },
      },
    },
  },
  {
    name: 'update_scheduling_rule',
    description: 'Update a scheduling rule. There is no delete — use active:false to pause it instead.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        category: { type: 'string', enum: SCHEDULING_RULE_CATEGORIES },
        tag: { type: 'string' },
        starts_after: { type: 'string' },
        starts_before: { type: 'string' },
        weekdays: { type: 'array', items: { type: 'number' } },
        active: { type: 'boolean' },
      },
      required: ['id'],
    },
  },

  // ---------- Meta ----------
  {
    name: 'ask_clarifying_question',
    description: 'Ask the user a clarifying question instead of guessing or acting. Calling this immediately ends the turn with the question shown to the user — do not call any other tool in the same turn as this one.',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
  },
  {
    name: 'log_capability_gap',
    description: 'Log a request that genuinely maps to nothing else in this tool surface (e.g. task dependencies), instead of hallucinating a workaround. This is the correct v1 fallback — use it rather than silently failing or inventing an unsupported action.',
    input_schema: {
      type: 'object',
      properties: {
        requested_capability: { type: 'string' },
        example_phrase: { type: 'string', description: 'The user\'s actual wording, if useful context.' },
        context: { type: 'string' },
      },
      required: ['requested_capability'],
    },
  },
  {
    name: 'read_reference',
    description: 'Fetch a longer-form reference chunk not already in the system prompt — worked examples, casing gotchas, and known limitations. Call this before guessing at a detail you are unsure of.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', enum: ['casing', 'limitations', 'scheduling-rules'] },
      },
      required: ['topic'],
    },
  },
];
