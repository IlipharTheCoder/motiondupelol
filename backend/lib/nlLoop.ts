// The manual agentic loop for the Phase 5 NL chat layer — a plain loop over
// client.messages.create(), not the SDK's beta Tool Runner. Per this repo's
// CLAUDE.md ("prefer plain algorithmic code over an AI/LLM call wherever
// possible" / plain code over added abstraction generally), and because a
// hard iteration cap is simplest to enforce by hand.
//
// Complete rebuild (2026-07-25): with only two tools (find_free_time,
// propose_calendar_change — see lib/nlToolManifest.ts), there's no longer a
// dedicated ask_clarifying_question tool to special-case — the model just
// asks in plain text when it needs to, which naturally ends the loop with
// no tool_use blocks, the same path a normal final reply takes. This
// removed the loop's only real branch, so LoopResult is now a single shape.
//
// Model: claude-haiku-4-5, per an explicit standing project policy — never
// Opus or Fable; escalate to Sonnet only if a specific step proves too
// heavy for Haiku in practice. This overrides the claude-api skill's own
// default (Opus-4.8-unless-told-otherwise); the user told otherwise, by
// name. Keep this a one-line constant so an escalation is a deliberate,
// visible change, never a silent one.
import Anthropic from '@anthropic-ai/sdk';
import { executeTool, collectProposals } from './nlToolDispatch';
import { NL_TOOLS } from './nlToolManifest';
import type { ProposedChangeRow } from './proposedChanges';

export const NL_MODEL = 'claude-haiku-4-5';
export const MAX_ITERATIONS = 6;
const MAX_TOKENS = 4096;

interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

// $/million tokens, base (non-cached) rate. Sonnet's numbers here are its
// introductory rate (active through 2026-08-31 per the claude-api skill's
// model table current as of this writing) — revisit after that date if a
// step is ever actually escalated to it (NL_MODEL is Haiku by default, see
// this file's top comment; nothing in this codebase switches models
// per-call today).
const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-haiku-4-5': { inputPerMTok: 1.0, outputPerMTok: 5.0 },
  'claude-sonnet-5': { inputPerMTok: 2.0, outputPerMTok: 10.0 },
};

// Prompt-caching multipliers, relative to a model's own base input price —
// confirmed via Anthropic's current published pricing, not assumed: a cache
// read is 0.1x, a 5-minute cache write is 1.25x, a 1-hour write (what
// app/api/chat/route.ts's breakpoint actually uses) is 2x.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2.0;

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
}

function emptyUsage(): ChatUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    estimatedCostUsd: 0,
  };
}

// Summed across every messages.create() call this loop makes — a single
// /api/chat request can make up to MAX_ITERATIONS of them, and the caller
// needs the total for the whole turn, not just the final call.
function accumulateUsage(total: ChatUsage, usage: Anthropic.Usage, model: string): void {
  const create5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const create1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;

  total.inputTokens += usage.input_tokens;
  total.outputTokens += usage.output_tokens;
  total.cacheCreation5mTokens += create5m;
  total.cacheCreation1hTokens += create1h;
  total.cacheReadTokens += read;

  // A model with no pricing entry (e.g. a typo'd future escalation) degrades
  // to a $0 contribution rather than throwing — token counts above stay
  // accurate regardless; only the cost estimate would be incomplete.
  const pricing = MODEL_PRICING[model];
  if (pricing) {
    total.estimatedCostUsd +=
      (usage.input_tokens * pricing.inputPerMTok +
        usage.output_tokens * pricing.outputPerMTok +
        create5m * pricing.inputPerMTok * CACHE_WRITE_5M_MULTIPLIER +
        create1h * pricing.inputPerMTok * CACHE_WRITE_1H_MULTIPLIER +
        read * pricing.inputPerMTok * CACHE_READ_MULTIPLIER) /
      1_000_000;
  }
}

export interface LoopResult {
  text: string;
  proposals: ProposedChangeRow[];
  usage: ChatUsage;
  tasksChanged: boolean;
}

// Tools that mutate the tasks table directly, with no proposed_changes row
// to signal the change (unlike propose_calendar_change/assign_task_to_event,
// whose output already flows through `proposals`) — added 2026-07-25
// alongside create_task, when the same gap was noticed already existing for
// unassign_task: neither tool gave the client any way to know its task list
// just went stale. tasksChanged is the fix — a client refreshes its task
// list when this comes back true, the same way a non-empty `proposals`
// already signals "refresh the approval queue."
const TASK_MUTATING_TOOLS = new Set(['create_task', 'unassign_task', 'complete_task']);

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export async function runChatLoop(
  anthropic: Anthropic,
  systemBlocks: Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[]
): Promise<LoopResult> {
  const proposals: ProposedChangeRow[] = [];
  const usage = emptyUsage();
  let tasksChanged = false;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: NL_MODEL,
      max_tokens: MAX_TOKENS,
      system: systemBlocks,
      tools: NL_TOOLS,
      messages,
    });
    accumulateUsage(usage, response.usage, NL_MODEL);

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );

    if (toolUseBlocks.length === 0) {
      return { text: extractText(response.content), proposals, usage, tasksChanged };
    }

    const results = await Promise.all(
      toolUseBlocks.map((block) => executeTool(block.name, block.input))
    );

    toolUseBlocks.forEach((block, i) => {
      const outcome = results[i];
      if ('result' in outcome) {
        proposals.push(...collectProposals(outcome.result));
        if (TASK_MUTATING_TOOLS.has(block.name)) tasksChanged = true;
      }
    });

    // Every tool_use block in this assistant turn gets exactly one
    // tool_result, and all of them land in a single subsequent user message
    // — never split across multiple user messages, which silently trains
    // the model to stop batching future turns.
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: toolUseBlocks.map((block, i): Anthropic.ToolResultBlockParam => {
        const outcome = results[i];
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify('result' in outcome ? outcome.result : { error: outcome.error }),
          is_error: 'error' in outcome,
        };
      }),
    });
  }

  // Iteration cap hit — a graceful reply, not a crash. Whatever proposals
  // were actually created up to this point are still real and still
  // reported back.
  return {
    text: "I wasn't able to finish this within my step limit — here's what I did so far. You may need to ask again for the rest.",
    proposals,
    usage,
    tasksChanged,
  };
}
