import { describe, expect, it } from 'vitest';
import { needsPriority, secondaryLine, approveButtonLabel } from './proposals';
import type { ProposedChange } from './types';

function change(overrides: Partial<ProposedChange>): ProposedChange {
  return {
    id: 'p1',
    status: 'pending',
    changeType: null,
    proposedSummary: null,
    proposedStart: null,
    proposedEnd: null,
    category: null,
    priority: null,
    reason: null,
    errorMessage: null,
    message: null,
    proposalGroupId: null,
    createdAt: null,
    ...overrides,
  };
}

describe('needsPriority — the exact 3-condition gate, must match the backend', () => {
  it('true: create + both dates present + priority null', () => {
    expect(
      needsPriority(
        change({ changeType: 'create', proposedStart: 'a', proposedEnd: 'b', priority: null })
      )
    ).toBe(true);
  });

  it('false: move with identical dates/null-priority (type gate)', () => {
    expect(
      needsPriority(change({ changeType: 'move', proposedStart: 'a', proposedEnd: 'b', priority: null }))
    ).toBe(false);
  });

  it('false: create with only proposedStart, no proposedEnd (both-required gate)', () => {
    expect(
      needsPriority(change({ changeType: 'create', proposedStart: 'a', proposedEnd: null, priority: null }))
    ).toBe(false);
  });

  it('false: create with dates present but a real priority already set', () => {
    expect(
      needsPriority(
        change({ changeType: 'create', proposedStart: 'a', proposedEnd: 'b', priority: 'high' })
      )
    ).toBe(false);
  });

  it('false: create with no dates at all (task-list-intake shape — tasks.priority, not this gate)', () => {
    expect(
      needsPriority(change({ changeType: 'create', proposedStart: null, proposedEnd: null, priority: null }))
    ).toBe(false);
  });
});

describe('secondaryLine', () => {
  it('a failed row with a non-empty errorMessage wins over time/reason entirely', () => {
    expect(
      secondaryLine(
        change({
          status: 'failed',
          errorMessage: 'Conflicts with existing event',
          proposedStart: '2026-07-28T14:00:00Z',
          reason: 'Weekly goal',
        })
      )
    ).toBe('Conflicts with existing event');
  });

  it('a pending row with both a time range and a reason joins with " · "', () => {
    const result = secondaryLine(
      change({ status: 'pending', proposedStart: '2026-07-28T14:00:00Z', reason: 'Weekly goal' })
    );
    expect(result).toContain(' · ');
    expect(result?.endsWith('Weekly goal')).toBe(true);
  });

  it('a row with neither a time nor a reason returns null', () => {
    expect(secondaryLine(change({}))).toBeNull();
  });

  it('a failed row with an empty errorMessage falls through to time/reason, not an empty string', () => {
    expect(
      secondaryLine(change({ status: 'failed', errorMessage: null, reason: 'Weekly goal' }))
    ).toBe('Weekly goal');
  });
});

describe('approveButtonLabel', () => {
  it('is Retry only for a failed row', () => {
    expect(approveButtonLabel(change({ status: 'failed' }))).toBe('Retry');
  });
  it('is Approve for pending/applied/rejected', () => {
    expect(approveButtonLabel(change({ status: 'pending' }))).toBe('Approve');
    expect(approveButtonLabel(change({ status: 'applied' }))).toBe('Approve');
    expect(approveButtonLabel(change({ status: 'rejected' }))).toBe('Approve');
  });
});
