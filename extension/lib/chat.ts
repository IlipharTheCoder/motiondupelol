// Mirrors app/motiondupelol/CoreLogic/ChatViewModel.swift exactly.
import type { ChatUsage } from './types';

// conversation_id is OMITTED entirely when starting fresh — never sent as
// `null`. Matches backend-api-reference.md's explicit "omit to start a new
// conversation" contract for POST /api/chat.
export function buildChatRequestBody(
  message: string,
  conversationId?: string
): { message: string; conversation_id?: string } {
  return conversationId === undefined ? { message } : { message, conversation_id: conversationId };
}

export function shouldShowCacheHitLine(usage: ChatUsage): boolean {
  return usage.cacheReadTokens > 0;
}

export function cacheWriteTotal(usage: ChatUsage): number {
  return usage.cacheCreation5mTokens + usage.cacheCreation1hTokens;
}

export function shouldShowCacheWriteLine(usage: ChatUsage): boolean {
  return cacheWriteTotal(usage) > 0;
}

// Accumulated client-side across every response in the session — the
// backend doesn't track a running total itself.
export function accumulateSessionCost(current: number, usage: ChatUsage): number {
  return current + usage.estimatedCostUsd;
}
