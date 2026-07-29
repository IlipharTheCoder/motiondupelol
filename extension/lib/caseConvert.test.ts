import { describe, expect, it } from 'vitest';
import { camelizeKeys } from './caseConvert';

describe('camelizeKeys', () => {
  it('converts top-level snake_case keys', () => {
    expect(camelizeKeys({ change_type: 'create', proposed_summary: 'Buy milk' })).toEqual({
      changeType: 'create',
      proposedSummary: 'Buy milk',
    });
  });

  it('recurses into nested objects, e.g. a chat response containing proposed_changes rows', () => {
    const raw = {
      conversation_id: 'abc',
      proposals: [{ change_type: 'create', target_event_id: null }],
      usage: { input_tokens: 10, cache_read_tokens: 0 },
    };
    expect(camelizeKeys(raw)).toEqual({
      conversationId: 'abc',
      proposals: [{ changeType: 'create', targetEventId: null }],
      usage: { inputTokens: 10, cacheReadTokens: 0 },
    });
  });

  it('leaves already-camelCase keys unchanged (no underscore to convert)', () => {
    expect(camelizeKeys({ inputTokens: 5 })).toEqual({ inputTokens: 5 });
  });

  it('maps over arrays element-wise without treating them as objects', () => {
    expect(camelizeKeys({ tags: ['work', 'urgent_review'] })).toEqual({
      // array elements are primitives here — only object keys convert, string values never do
      tags: ['work', 'urgent_review'],
    });
  });

  it('passes null and undefined through unchanged', () => {
    expect(camelizeKeys(null)).toBeNull();
    expect(camelizeKeys(undefined)).toBeUndefined();
  });

  it('passes primitives through unchanged', () => {
    expect(camelizeKeys('hello_world')).toBe('hello_world');
    expect(camelizeKeys(42)).toBe(42);
    expect(camelizeKeys(true)).toBe(true);
  });
});
