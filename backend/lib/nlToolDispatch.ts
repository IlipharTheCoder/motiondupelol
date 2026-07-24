// Tool execution layer for the Phase 5 NL chat layer — maps a tool_use
// block's name+input onto the real lib/ function it represents. Every
// branch here touches Supabase/Google (via the lib functions it calls), so
// unlike lib/nlContext.ts there's no meaningful pure core to split out —
// this file is a dispatch table, not logic of its own.
//
// Every error is caught and returned as {error: string} rather than thrown
// — a tool_result can carry an error for the model to see and react to
// (retry with corrected input, explain to the user, fall back to
// log_capability_gap), which fits the agentic loop better than aborting the
// whole request on one bad call. lib/nlLoop.ts is the only caller.
import { readFileSync } from 'fs';
import { join } from 'path';
import { listCalendarEvents } from './calendarEvents';
import { findFreeSlots } from './freeSlots';
import {
  createProposedChange,
  createProposedChangesBatch,
  listProposedChanges,
  approveProposedChange,
  rejectProposedChange,
  revertProposedChange,
  approveProposalGroup,
  rejectProposalGroup,
  updateProposedChangeFields,
  ValidationError,
  NotFoundError,
  ConflictError,
  type ProposedChangeInput,
  type ProposedChangeRow,
  type ProposalStatus,
} from './proposedChanges';
import { planBulkEdit, type BulkEditInput } from './bulkEdit';
import { planRecurringSeries, type RecurringSeriesInput } from './recurringEvents';
import { relocateEvent } from './relocateEvent';
import { findAndProposeReschedules } from './autoReschedule';
import { rebalanceWorkload } from './dayRebalance';
import { planFocusTime } from './focusTime';
import { planBufferTime } from './bufferTime';
import { planTaskPlacement } from './taskPlacement';
import { planHabitPlacement } from './habitPlacement';
import { getNextTasks, linkTaskToExistingEvent, scheduleTaskToNewEvent } from './aiTasks';
import { listTasks } from './tasksQuery';
import { createTask } from './tasksWrite';
import { createHabit, updateHabit } from './habitsWrite';
import { createSchedulingRule, updateSchedulingRule } from './schedulingRulesQuery';
import { createCapabilityRequest } from './capabilityRequestsWrite';

export type ToolExecutionResult = { result: unknown } | { error: string };

// Every write this dispatcher makes is attributed to the NL layer itself,
// never trusted from model input — same reasoning lib/recurringEvents.ts's
// planRecurringSeries already documents for its own fixed source_system.
const SOURCE_SYSTEM = 'ai-engine' as const;

function parseRequiredDate(input: Record<string, unknown>, field: string): Date {
  const raw = input[field];
  if (typeof raw !== 'string') throw new ValidationError(`"${field}" is required and must be an ISO datetime`);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`"${field}" must be a valid ISO datetime`);
  return date;
}

function proposalInputFromToolArgs(input: Record<string, unknown>): ProposedChangeInput {
  return { ...(input as object), source_system: SOURCE_SYSTEM } as ProposedChangeInput;
}

function isProposedChangeRow(value: unknown): value is ProposedChangeRow {
  return (
    !!value &&
    typeof value === 'object' &&
    'id' in value &&
    'status' in value &&
    'change_type' in value
  );
}

// Walks a tool result of unknown, per-tool-varying shape and pulls out every
// ProposedChangeRow it can find — covers every shape used across this
// backend's fan-out summaries: a bare row (createProposedChange,
// approve/reject/revert), a `.proposal` single (relocateEvent), a
// `.proposals` array (planFocusTime, rebalanceWorkload,
// findAndProposeReschedules, planBufferTime), and a `.results[].proposal`
// array (createProposedChangesBatch, planBulkEdit, planRecurringSeries,
// planTaskPlacement, planHabitPlacement, approve/rejectProposalGroup).
// app/api/chat/route.ts uses this to populate the response's `proposals`
// field with whatever this turn's tool calls actually created.
export function collectProposals(value: unknown): ProposedChangeRow[] {
  if (isProposedChangeRow(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(collectProposals);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: ProposedChangeRow[] = [];
    if ('proposal' in obj) out.push(...collectProposals(obj.proposal));
    if ('proposals' in obj) out.push(...collectProposals(obj.proposals));
    if ('results' in obj) out.push(...collectProposals(obj.results));
    return out;
  }
  return [];
}

const NL_REFERENCE_DIR = join(process.cwd(), 'nl-reference');
const VALID_REFERENCE_TOPICS = ['casing', 'limitations', 'scheduling-rules'];

function readReference(topic: unknown): string {
  if (typeof topic !== 'string' || !VALID_REFERENCE_TOPICS.includes(topic)) {
    throw new ValidationError(`"topic" must be one of ${VALID_REFERENCE_TOPICS.join(', ')}`);
  }
  return readFileSync(join(NL_REFERENCE_DIR, `${topic}.md`), 'utf-8');
}

export async function executeTool(name: string, rawInput: unknown): Promise<ToolExecutionResult> {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;

  try {
    switch (name) {
      // ---------- Read ----------
      case 'get_calendar_events':
        return {
          result: await listCalendarEvents({
            from: input.from as string | undefined,
            to: input.to as string | undefined,
            q: input.q as string | undefined,
            maxResults: input.maxResults as number | undefined,
          }),
        };
      case 'get_free_slots':
        return {
          result: await findFreeSlots(parseRequiredDate(input, 'from'), parseRequiredDate(input, 'to'), {
            minDurationMinutes: input.min_duration_minutes as number | undefined,
            category: input.category as never,
            tags: input.tags as string[] | undefined,
          }),
        };
      case 'list_proposed_changes':
        return {
          result: await listProposedChanges(
            input.status as ProposalStatus | undefined,
            input.group_id as string | undefined
          ),
        };
      case 'get_next_tasks':
        return { result: await getNextTasks((input.limit as number) ?? 5) };
      case 'list_tasks':
        return { result: await listTasks(input.status as never) };

      // ---------- Propose ----------
      case 'propose_change':
        return { result: await createProposedChange(proposalInputFromToolArgs(input)) };
      case 'propose_batch': {
        const proposals = Array.isArray(input.proposals) ? input.proposals : [];
        return {
          result: await createProposedChangesBatch(
            proposals.map((p) => proposalInputFromToolArgs(p as Record<string, unknown>)),
            input.reason as string | undefined
          ),
        };
      }
      case 'bulk_edit':
        return { result: await planBulkEdit(input as unknown as BulkEditInput) };
      case 'create_recurring_series':
        return { result: await planRecurringSeries(input as unknown as RecurringSeriesInput) };
      case 'relocate_event':
        return {
          result: await relocateEvent(
            input.event_id as string,
            input.search_from as string | undefined,
            input.search_to as string | undefined,
            (input.bump_if_movable as boolean) ?? false
          ),
        };
      case 'reschedule_conflicts':
        return {
          result: await findAndProposeReschedules(parseRequiredDate(input, 'from'), parseRequiredDate(input, 'to')),
        };
      case 'rebalance_day':
        return {
          result: await rebalanceWorkload(
            parseRequiredDate(input, 'from'),
            parseRequiredDate(input, 'to'),
            input.max_busy_minutes as number,
            parseRequiredDate(input, 'search_end')
          ),
        };
      case 'plan_focus_time':
        return { result: await planFocusTime() };
      case 'plan_buffer_time':
        return { result: await planBufferTime(parseRequiredDate(input, 'from'), parseRequiredDate(input, 'to')) };
      case 'plan_tasks':
        return { result: await planTaskPlacement(parseRequiredDate(input, 'from'), parseRequiredDate(input, 'to')) };
      case 'plan_habits':
        return { result: await planHabitPlacement() };
      case 'schedule_task': {
        const taskId = input.task_id as string;
        const hasEvent = input.event_id !== undefined;
        const hasNew = input.proposed_start !== undefined || input.proposed_end !== undefined;
        if (hasEvent === hasNew) {
          throw new ValidationError('Provide exactly one of "event_id" or "proposed_start"+"proposed_end"');
        }
        if (hasEvent) {
          // Deliberate dispatch-layer restriction, not a schema-level block:
          // actor is always 'ai-engine' here, never 'user' — 'user' is the
          // direct-apply path meant for the Mac/iOS client's own explicit
          // "link this" action, not something the NL layer should choose on
          // your behalf even though linkTaskToExistingEvent's signature
          // technically allows it.
          return { result: await linkTaskToExistingEvent(taskId, input.event_id as string, 'ai-engine') };
        }
        return {
          result: await scheduleTaskToNewEvent(
            taskId,
            input.proposed_start as string,
            input.proposed_end as string,
            (input.bump_if_movable as boolean) ?? false,
            (input.ignore_scheduling_rules as boolean) ?? false
          ),
        };
      }

      // ---------- Decision / meta over proposals ----------
      case 'approve_proposal':
        return { result: await approveProposedChange(input.id as string) };
      case 'reject_proposal':
        return { result: await rejectProposedChange(input.id as string) };
      case 'revert_proposal':
        return { result: await revertProposedChange(input.id as string) };
      case 'approve_proposal_group':
        return { result: await approveProposalGroup(input.group_id as string) };
      case 'reject_proposal_group':
        return { result: await rejectProposalGroup(input.group_id as string) };
      case 'edit_pending_proposal':
        return {
          result: await updateProposedChangeFields(input.id as string, {
            priority: input.priority as never,
            tags: input.tags as string[] | undefined,
            duration_minutes: input.duration_minutes as number | undefined,
          }),
        };

      // ---------- Direct-write ----------
      case 'create_task':
        return { result: await createTask(input as never) };
      case 'create_habit':
        return { result: await createHabit(input as never) };
      case 'update_habit':
        return { result: await updateHabit(input.id as string, input as never) };
      case 'create_scheduling_rule':
        return { result: await createSchedulingRule(input as never) };
      case 'update_scheduling_rule':
        return { result: await updateSchedulingRule(input.id as string, input as never) };

      // ---------- Meta ----------
      case 'log_capability_gap':
        return {
          result: await createCapabilityRequest({
            requested_capability: input.requested_capability as string,
            example_phrase: input.example_phrase as string | undefined,
            context: input.context as string | undefined,
          }),
        };
      case 'read_reference':
        return { result: readReference(input.topic) };

      default:
        return { error: `Unknown tool "${name}"` };
    }
  } catch (err) {
    if (err instanceof ValidationError || err instanceof NotFoundError || err instanceof ConflictError) {
      return { error: err.message };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

