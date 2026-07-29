import { describe, expect, it } from 'vitest';
import {
  accumulateSessionCost,
  buildChatRequestBody,
  cacheWriteTotal,
  shouldShowCacheHitLine,
  shouldShowCacheWriteLine,
} from './chat';
import type { ChatUsage } from './types';

function usage(overrides: Partial<ChatUsage>): ChatUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadTokens: 0,
    estimatedCostUsd: 0,
    ...overrides,
  };
}

describe('buildChatRequestBody', () => {
  it('omits conversation_id entirely (no key at all) when starting fresh', () => {
    const body = buildChatRequestBody('hello');
    expect('conversation_id' in body).toBe(false);
    expect(body).toEqual({ message: 'hello' });
  });

  it('includes conversation_id when continuing a session', () => {
    expect(buildChatRequestBody('hello', 'conv-1')).toEqual({
      message: 'hello',
      conversation_id: 'conv-1',
    });
  });
});

describe('shouldShowCacheHitLine', () => {
  it('true only when cacheReadTokens > 0', () => {
    expect(shouldShowCacheHitLine(usage({ cacheReadTokens: 0 }))).toBe(false);
    expect(shouldShowCacheHitLine(usage({ cacheReadTokens: 5 }))).toBe(true);
  });
});

describe('shouldShowCacheWriteLine / cacheWriteTotal', () => {
  it('true only when the sum of both cache-creation fields is > 0', () => {
    expect(shouldShowCacheWriteLine(usage({ cacheCreation5mTokens: 0, cacheCreation1hTokens: 0 }))).toBe(false);
    expect(shouldShowCacheWriteLine(usage({ cacheCreation5mTokens: 3, cacheCreation1hTokens: 0 }))).toBe(true);
    expect(shouldShowCacheWriteLine(usage({ cacheCreation5mTokens: 0, cacheCreation1hTokens: 7 }))).toBe(true);
  });

  it('cacheWriteTotal sums both fields', () => {
    expect(cacheWriteTotal(usage({ cacheCreation5mTokens: 3, cacheCreation1hTokens: 7 }))).toBe(10);
  });
});

describe('accumulateSessionCost', () => {
  it('sums correctly across repeated calls', () => {
    let total = 0;
    total = accumulateSessionCost(total, usage({ estimatedCostUsd: 0.001 }));
    total = accumulateSessionCost(total, usage({ estimatedCostUsd: 0.002 }));
    expect(total).toBeCloseTo(0.003);
  });
});
