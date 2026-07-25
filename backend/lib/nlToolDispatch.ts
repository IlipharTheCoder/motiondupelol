// Tool execution layer for the Phase 5 NL chat layer — maps a tool_use
// block's name+input onto the real lib/ function it represents.
//
// Complete rebuild (2026-07-25): only two tools exist now (see
// lib/nlToolManifest.ts's top comment for why). Every error is caught and
// returned as {error: string} rather than thrown — a tool_result can carry
// an error for the model to see and react to, rather than aborting the
// whole request on one bad call.
import {
  createProposedChange,
  ValidationError,
  NotFoundError,
  ConflictError,
  type ProposedChangeInput,
  type ProposedChangeRow,
} from './proposedChanges';
import { findFreeSlots } from './freeSlots';

export type ToolExecutionResult = { result: unknown } | { error: string };

// Every write this dispatcher makes is attributed to the NL layer itself,
// never trusted from model input.
const SOURCE_SYSTEM = 'ai-engine' as const;

const ALLOWED_CHANGE_TYPES = new Set(['create', 'move', 'delete']);

function parseRequiredDate(input: Record<string, unknown>, field: string): Date {
  const raw = input[field];
  if (typeof raw !== 'string') throw new ValidationError(`"${field}" is required and must be an ISO datetime`);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`"${field}" must be a valid ISO datetime`);
  return date;
}

function isProposedChangeRow(value: unknown): value is ProposedChangeRow {
  return !!value && typeof value === 'object' && 'id' in value && 'status' in value && 'change_type' in value;
}

// The only tool that can ever produce a proposal now always returns a bare
// ProposedChangeRow directly — no nested .proposal/.proposals/.results
// shapes to walk anymore, unlike the prior 33-tool surface's fan-out
// engines. app/api/chat/route.ts uses this to populate the response's
// `proposals` field.
export function collectProposals(value: unknown): ProposedChangeRow[] {
  return isProposedChangeRow(value) ? [value] : [];
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
        const proposalInput = { ...input, source_system: SOURCE_SYSTEM } as ProposedChangeInput;
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
            category: input.category as never,
            tags: input.tags as string[] | undefined,
          }),
        };

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
