// Thin wrappers: camelizeKeys() + a minimal runtime assertion of required
// fields, so a backend shape mismatch fails loudly here (in background.ts,
// close to the fetch call) rather than silently propagating `undefined`
// into the panel UI. TS has no free Decodable-style throw-on-mismatch the
// way Swift's JSONDecoder does — this is the deliberate equivalent.
import { camelizeKeys } from './caseConvert';
import type { Task, ProposedChange, ChatResponse, CalendarResyncResult } from './types';

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`Expected "${field}" to be a string, got ${JSON.stringify(value)}`);
  }
}

export function parseTask(raw: unknown): Task {
  const camel = camelizeKeys(raw) as Record<string, unknown>;
  assertString(camel.id, 'id');
  assertString(camel.title, 'title');
  assertString(camel.status, 'status');
  return camel as unknown as Task;
}

export function parseProposedChange(raw: unknown): ProposedChange {
  const camel = camelizeKeys(raw) as Record<string, unknown>;
  assertString(camel.id, 'id');
  assertString(camel.status, 'status');
  return camel as unknown as ProposedChange;
}

// The backend's SyncRunResult is already camelCase in its own TS source
// (unlike most responses, which are hand-built snake_case) — camelizeKeys
// is a no-op on already-camelCase keys, so running every response through
// it uniformly is still correct, just not strictly necessary here.
export function parseCalendarResyncResult(raw: unknown): CalendarResyncResult {
  const camel = camelizeKeys(raw) as Record<string, unknown>;
  if (typeof camel.truncatedByTimeBudget !== 'boolean' || !Array.isArray(camel.calendars)) {
    throw new Error('Malformed calendar resync response');
  }
  return camel as unknown as CalendarResyncResult;
}

export function parseChatResponse(raw: unknown): ChatResponse {
  const camel = camelizeKeys(raw) as Record<string, unknown>;
  assertString(camel.conversationId, 'conversation_id');
  assertString(camel.reply, 'reply');
  if (!Array.isArray(camel.proposals)) {
    throw new Error('Expected "proposals" to be an array');
  }
  return {
    ...camel,
    proposals: (camel.proposals as unknown[]).map(parseProposedChange),
  } as unknown as ChatResponse;
}
