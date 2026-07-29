// Mirrors app/motiondupelol/Shared/ApprovalQueueView.swift exactly.
import type { ProposedChange } from './types';
import { formatTimeRange } from './dateFormat';

// The exact 3-condition gate — MUST match the backend's own isCalendarCreate
// check (backend/lib/proposedChanges.ts's applyProposedChange) precisely:
// approve genuinely fails server-side under this same condition, so this is
// UI-convenience mirroring a real enforcement, not an independent rule. A
// `move` never needs priority (preserves the target event's own); the
// task-list-intake `create` shape (no start/end) means tasks.priority, a
// separate concern this gate doesn't touch.
export function needsPriority(change: ProposedChange): boolean {
  return (
    change.changeType === 'create' &&
    change.proposedStart != null &&
    change.proposedEnd != null &&
    change.priority == null
  );
}

// Failed + a real error message wins outright over time/reason. Otherwise:
// time range (only if proposedStart present) and reason (only if non-empty),
// joined with " · "; null if neither is present (caller omits the line).
export function secondaryLine(change: ProposedChange): string | null {
  if (change.status === 'failed' && change.errorMessage) {
    return change.errorMessage;
  }
  const parts: string[] = [];
  if (change.proposedStart) {
    parts.push(formatTimeRange(change.proposedStart, change.proposedEnd));
  }
  if (change.reason) {
    parts.push(change.reason);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function approveButtonLabel(change: ProposedChange): 'Approve' | 'Retry' {
  return change.status === 'failed' ? 'Retry' : 'Approve';
}
