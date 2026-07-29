import { describe, expect, it } from 'vitest';
import { parseTask, parseProposedChange, parseChatResponse, parseCalendarResyncResult } from './parsers';

describe('parseTask', () => {
  it('parses a realistic tasks row into camelCase', () => {
    const raw = {
      id: 't1',
      title: 'Buy milk',
      description: null,
      deadline: '2026-07-28T23:59:59Z',
      priority: 'high',
      tags: ['errands'],
      source_system: 'manual',
      status: 'unscheduled',
      scheduled_event_id: null,
      duration_minutes: 30,
      created_at: '2026-07-25T00:00:00Z',
    };
    expect(parseTask(raw)).toEqual({
      id: 't1',
      title: 'Buy milk',
      description: null,
      deadline: '2026-07-28T23:59:59Z',
      priority: 'high',
      tags: ['errands'],
      sourceSystem: 'manual',
      status: 'unscheduled',
      scheduledEventId: null,
      durationMinutes: 30,
      createdAt: '2026-07-25T00:00:00Z',
    });
  });

  it('throws when a required field is missing', () => {
    expect(() => parseTask({ title: 'no id here', status: 'unscheduled' })).toThrow(/id/);
  });
});

describe('parseProposedChange', () => {
  it('parses a realistic proposed_changes row into camelCase', () => {
    const raw = {
      id: 'p1',
      status: 'pending',
      change_type: 'create',
      proposed_summary: 'Focus block',
      proposed_start: '2026-07-28T14:00:00Z',
      proposed_end: '2026-07-28T15:00:00Z',
      category: 'focusTime',
      priority: null,
      reason: 'Weekly goal',
      error_message: null,
      message: 'Awaiting approval.',
      proposal_group_id: null,
      created_at: '2026-07-28T00:00:00Z',
    };
    const result = parseProposedChange(raw);
    expect(result.changeType).toBe('create');
    expect(result.proposedSummary).toBe('Focus block');
    expect(result.priority).toBeNull();
  });
});

describe('parseChatResponse', () => {
  it('parses a realistic POST /api/chat response, including nested proposals and tasks_changed', () => {
    const raw = {
      conversation_id: 'c1',
      reply: 'Done!',
      proposals: [
        {
          id: 'p1',
          status: 'pending',
          change_type: 'create',
          proposed_summary: null,
          proposed_start: null,
          proposed_end: null,
          category: 'task',
          priority: null,
          reason: null,
          error_message: null,
          message: null,
          proposal_group_id: null,
          created_at: null,
        },
      ],
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        estimatedCostUsd: 0.001,
      },
      tasks_changed: true,
    };
    const result = parseChatResponse(raw);
    expect(result.conversationId).toBe('c1');
    expect(result.tasksChanged).toBe(true);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].changeType).toBe('create');
    expect(result.usage.inputTokens).toBe(100);
  });

  it('throws when proposals is missing entirely', () => {
    expect(() => parseChatResponse({ conversation_id: 'c1', reply: 'hi' })).toThrow(/proposals/);
  });
});

describe('parseCalendarResyncResult', () => {
  it('parses a realistic POST /api/calendar/resync response', () => {
    const raw = {
      startedAt: '2026-07-28T00:00:00Z',
      finishedAt: '2026-07-28T00:00:10Z',
      durationMs: 10000,
      truncatedByTimeBudget: false,
      calendars: [
        { calendarId: 'a', calendarSummary: 'Kids', mode: 'backfill', status: 'complete', created: 5, updated: 0, deleted: 0, skipped: 0, pagesProcessed: 1, errorMessage: null },
      ],
    };
    const result = parseCalendarResyncResult(raw);
    expect(result.truncatedByTimeBudget).toBe(false);
    expect(result.calendars).toHaveLength(1);
    expect(result.calendars[0].calendarSummary).toBe('Kids');
  });

  it('throws on a malformed response', () => {
    expect(() => parseCalendarResyncResult({})).toThrow(/Malformed/);
  });
});
