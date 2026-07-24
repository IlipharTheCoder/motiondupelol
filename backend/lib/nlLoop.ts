// The manual agentic loop for the Phase 5 NL chat layer — a plain loop over
// client.messages.create(), not the SDK's beta Tool Runner. Two reasons,
// per the approved Phase 5 plan: this repo's CLAUDE.md explicitly prefers
// plain code over added abstraction, and this loop has two behaviors a
// generic runner's iteration protocol doesn't fit cleanly — a hard
// iteration cap, and a specific tool (ask_clarifying_question) that must
// short-circuit the whole loop with a distinct response shape rather than
// feed a tool_result back in.
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

export type LoopResult =
  | { kind: 'reply'; text: string; proposals: ProposedChangeRow[]; groupId?: string }
  | { kind: 'clarification'; question: string };

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function extractGroupId(result: unknown): string | undefined {
  if (result && typeof result === 'object' && 'groupId' in result) {
    const groupId = (result as { groupId: unknown }).groupId;
    return typeof groupId === 'string' ? groupId : undefined;
  }
  return undefined;
}

export async function runChatLoop(
  anthropic: Anthropic,
  systemBlocks: Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[]
): Promise<LoopResult> {
  const proposals: ProposedChangeRow[] = [];
  let groupId: string | undefined;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: NL_MODEL,
      max_tokens: MAX_TOKENS,
      system: systemBlocks,
      tools: NL_TOOLS,
      messages,
    });

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );

    if (toolUseBlocks.length === 0) {
      return { kind: 'reply', text: extractText(response.content), proposals, groupId };
    }

    // Checked before dispatching anything else in this turn, and wins
    // outright if present — if the model ever emits it alongside other tool
    // calls, we exit without executing the others rather than partially
    // executing a mixed turn.
    const clarify = toolUseBlocks.find((block) => block.name === 'ask_clarifying_question');
    if (clarify) {
      const question = (clarify.input as { question?: string })?.question;
      return { kind: 'clarification', question: question ?? 'Could you clarify what you mean?' };
    }

    const results = await Promise.all(
      toolUseBlocks.map((block) => executeTool(block.name, block.input))
    );

    for (const outcome of results) {
      if ('result' in outcome) {
        proposals.push(...collectProposals(outcome.result));
        groupId = groupId ?? extractGroupId(outcome.result);
      }
    }

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
    kind: 'reply',
    text: "I wasn't able to finish this within my step limit — here's what I did so far. You may need to ask again for the rest.",
    proposals,
    groupId,
  };
}
