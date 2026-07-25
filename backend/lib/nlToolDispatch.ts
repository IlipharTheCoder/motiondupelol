// Tool execution layer for the Phase 5 NL chat layer — maps a tool_use
// block's name+input onto the real lib/ function it represents.
//
// Complete rebuild (2026-07-25): only two tools existed at first (see
// lib/nlToolManifest.ts's top comment for why, and for the same-day growth
// to 5 tools). Every error is caught and returned as {error: string} rather
// than thrown — a tool_result can carry an error for the model to see and
// react to, rather than aborting the whole request on one bad call.
import {
  createProposedChange,
  ValidationError,
  NotFoundError,
  ConflictError,
  type ProposedChangeInput,
  type ProposedChangeRow,
} from './proposedChanges';
import { findFreeSlots } from './freeSlots';
import {
  getNextTasks,
  linkTaskToExistingEvent,
  scheduleTaskToNewEvent,
  unscheduleTask,
} from './aiTasks';

export type ToolExecutionResult = { result: unknown } | { error: string };

// Every write this dispatcher makes is attributed to the NL layer itself,
// never trusted from model input.
const SOURCE_SYSTEM = 'ai-engine' as const;

const ALLOWED_CHANGE_TYPES = new Set(['create', 'move', 'delete']);
const DEFAULT_LIST_TASKS_LIMIT = 20;

function parseRequiredDate(input: Record<string, unknown>, field: string): Date {
  const raw = input[field];
  if (typeof raw !== 'string') throw new ValidationError(`"${field}" is required and must be an ISO datetime`);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`"${field}" must be a valid ISO datetime`);
  return date;
}

function requiredString(input: Record<string, unknown>, field: string): string {
  const raw = input[field];
  if (typeof raw !== 'string' || raw.length === 0) throw new ValidationError(`"${field}" is required`);
  return raw;
}

function isProposedChangeRow(value: unknown): value is ProposedChangeRow {
  return !!value && typeof value === 'object' && 'id' in value && 'status' in value && 'change_type' in value;
}

// propose_calendar_change still returns a bare ProposedChangeRow directly.
// assign_task_to_event (added 2026-07-25) wraps lib/aiTasks.ts's own
// {mode, proposal} result shape instead, since it reuses those functions'
// existing return type rather than reinventing a flat one — so this also
// unwraps a `.proposal` field. app/api/chat/route.ts uses this to populate
// the response's `proposals` field.
export function collectProposals(value: unknown): ProposedChangeRow[] {
  if (isProposedChangeRow(value)) return [value];
  if (value && typeof value === 'object' && 'proposal' in value) {
    const proposal = (value as { proposal?: unknown }).proposal;
    if (isProposedChangeRow(proposal)) return [proposal];
  }
  return [];
}

export async function executeTool(name: string, rawInput: unknown): Promise<ToolExecutionResult> {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;

  try {
    switch (name) {
      case 'propose_calendar_change': {
        const changeType = input.change_type;
        if (typeof changeType !== 'string' || !ALLOWED_CHANGE_TYPES.has(changeType)) {
          throw new ValidationError(`"change_type" must be one of ${[...ALLOWED_CHANGE_TYPES].join(', ')}`);
        }
        // priority is deliberately omitted even if a stray value is present
        // in rawInput — the tool schema no longer offers it, and this is the
        // structural guarantee (not just a schema/prompt-level omission)
        // that a chat-created calendar event always lands with priority
        // unset, for you to decide at approval time (2026-07-25).
        const { priority: _ignoredPriority, ...rest } = input;
        const proposalInput = { ...rest, source_system: SOURCE_SYSTEM } as ProposedChangeInput;
        // skipAutoApply: true, always — structural guarantee that nothing
        // this layer proposes can ever apply without a manual approval tap,
        // independent of AUTO_APPLY_CATEGORIES (which this codebase's other
        // callers do still respect). This is the one non-negotiable
        // requirement behind the whole rebuild.
        return { result: await createProposedChange(proposalInput, { skipAutoApply: true }) };
      }

      case 'find_free_time':
        return {
          result: await findFreeSlots(parseRequiredDate(input, 'from'), parseRequiredDate(input, 'to'), {
            minDurationMinutes: input.min_duration_minutes as number | undefined,
            // Always unrestricted for chat — not model-controllable, same
            // "forced, not requested" pattern as skipAutoApply above (2026-07-25).
            ignoreWorkingHoursAndRules: true,
          }),
        };

      case 'list_tasks': {
        const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : DEFAULT_LIST_TASKS_LIMIT;
        return { result: await getNextTasks(limit) };
      }

      case 'assign_task_to_event': {
        const taskId = requiredString(input, 'task_id');
        const hasEventId = typeof input.event_id === 'string' && input.event_id.length > 0;
        const hasNewTimes = typeof input.proposed_start === 'string' && typeof input.proposed_end === 'string';
        if (hasEventId === hasNewTimes) {
          throw new ValidationError('Provide exactly one of "event_id" or ("proposed_start" and "proposed_end")');
        }

        if (hasEventId) {
          // actor is always 'ai-engine', never taken from model input — the
          // model can never take the 'user' actor's instant-apply path.
          return {
            result: await linkTaskToExistingEvent(taskId, input.event_id as string, 'ai-engine', {
              skipAutoApply: true,
            }),
          };
        }

        return {
          result: await scheduleTaskToNewEvent(
            taskId,
            input.proposed_start as string,
            input.proposed_end as string,
            false,
            false,
            { skipAutoApply: true, carryOverPriority: false }
          ),
        };
      }

      case 'unassign_task':
        return { result: await unscheduleTask(requiredString(input, 'task_id')) };

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
