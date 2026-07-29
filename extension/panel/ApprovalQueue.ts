// Feature parity with app/motiondupelol/Shared/ApprovalQueueView.swift —
// pending+failed shown together (a failed row is still actionable), the
// needsPriority gate/picker mirroring the backend's own isCalendarCreate
// enforcement, and a 25s poll.
//
// The poll deliberately lives here (content-script world), not in
// background.ts, despite extension/CLAUDE.md's proposed-structure comment
// suggesting otherwise — chrome.alarms' minimum period (1 minute for a
// packed extension) can't deliver the literal 25s cadence
// ProposedChangesViewModel.swift uses, and a plain setInterval here isn't
// subject to the service-worker idle-kill the way one in background.ts
// would be. background.ts still performs every actual fetch this interval
// triggers — principle 2 ("background owns every network call") holds
// exactly; only the timer's location differs.
import type { Priority, ProposedChange } from '../lib/types';
import { approveButtonLabel, needsPriority, secondaryLine } from '../lib/proposals';
import { callBackground } from './backgroundClient';

const PRIORITY_OPTIONS: Priority[] = ['critical', 'high', 'medium', 'low'];

export interface ApprovalQueueCallbacks {
  onApplied: () => void;
  onCountChange: (count: number) => void;
}

export interface ApprovalQueueHandle {
  element: HTMLElement;
  refresh(): Promise<void>;
  startPolling(intervalMs: number): void;
  destroy(): void;
}

export function createApprovalQueuePanel(container: HTMLElement, callbacks: ApprovalQueueCallbacks): ApprovalQueueHandle {
  let pendingChanges: ProposedChange[] = [];
  let pollId: number | null = null;
  const busyIds = new Set<string>();

  const root = document.createElement('div');
  root.className = 'ai-cal-approval-list';

  const header = document.createElement('div');
  header.className = 'ai-cal-approval-header';
  const headerLabel = document.createElement('span');
  headerLabel.textContent = 'Approval Queue';
  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.textContent = '⟳';
  refreshButton.className = 'ai-cal-refresh';
  refreshButton.style.marginLeft = 'auto';
  header.append(headerLabel, refreshButton);

  const gridEl = document.createElement('div');
  gridEl.className = 'ai-cal-approval-grid';

  root.append(header, gridEl);
  container.appendChild(root);

  function changeTypeBadge(change: ProposedChange): HTMLSpanElement {
    const badge = document.createElement('span');
    const type = change.changeType ?? 'update';
    badge.className = `ai-cal-change-type ai-cal-change-type-${type}`;
    badge.textContent = type.toUpperCase();
    return badge;
  }

  function renderRow(change: ProposedChange): HTMLElement {
    const isFailed = change.status === 'failed';
    const gated = needsPriority(change);
    const busy = busyIds.has(change.id);

    const row = document.createElement('div');
    row.className = 'ai-cal-change-row';
    if (busy) row.classList.add('ai-cal-busy');

    // column 1: type badge
    const typeCol = document.createElement('div');
    typeCol.appendChild(changeTypeBadge(change));

    // column 2: title + secondary line
    const titleCol = document.createElement('div');
    const titleRow = document.createElement('div');
    const titleText = document.createElement('span');
    titleText.className = 'ai-cal-change-title';
    titleText.textContent = change.proposedSummary ?? change.message ?? 'Proposed change';
    titleRow.appendChild(titleText);
    if (isFailed) {
      const failedBadge = document.createElement('span');
      failedBadge.className = 'ai-cal-change-failed-badge';
      failedBadge.textContent = 'FAILED';
      titleRow.appendChild(failedBadge);
    }
    titleCol.appendChild(titleRow);

    const secondary = secondaryLine(change);
    if (secondary) {
      const secondaryEl = document.createElement('div');
      secondaryEl.className = 'ai-cal-change-secondary';
      if (isFailed && change.errorMessage) secondaryEl.classList.add('ai-cal-error');
      secondaryEl.textContent = secondary;
      titleCol.appendChild(secondaryEl);
    }

    if (gated) {
      const hint = document.createElement('div');
      hint.className = 'ai-cal-priority-hint';
      hint.textContent = 'Set a priority before you can approve this.';
      titleCol.appendChild(hint);
    }

    // column 3: priority + actions
    const rightCol = document.createElement('div');

    if (change.priority) {
      const priorityLabel = document.createElement('div');
      priorityLabel.className = `ai-cal-chip ai-cal-priority-${change.priority}`;
      priorityLabel.textContent = change.priority.charAt(0).toUpperCase() + change.priority.slice(1);
      rightCol.appendChild(priorityLabel);
    } else if (gated) {
      const picker = document.createElement('select');
      picker.className = 'ai-cal-priority-picker';
      picker.disabled = busy;
      const placeholder = document.createElement('option');
      placeholder.textContent = 'Priority…';
      placeholder.value = '';
      picker.appendChild(placeholder);
      for (const priority of PRIORITY_OPTIONS) {
        const optionEl = document.createElement('option');
        optionEl.value = priority;
        optionEl.textContent = priority.charAt(0).toUpperCase() + priority.slice(1);
        picker.appendChild(optionEl);
      }
      picker.addEventListener('change', () => {
        if (picker.value) void setPriority(change.id, picker.value as Priority);
      });
      rightCol.appendChild(picker);
    }

    const actions = document.createElement('div');
    actions.className = 'ai-cal-change-actions';

    const approveButton = document.createElement('button');
    approveButton.type = 'button';
    approveButton.className = 'ai-cal-approve-button';
    approveButton.textContent = approveButtonLabel(change);
    approveButton.disabled = busy || gated;
    approveButton.title = gated ? 'Set a priority before approving' : approveButtonLabel(change);
    approveButton.addEventListener('click', () => void approve(change.id));

    const rejectButton = document.createElement('button');
    rejectButton.type = 'button';
    rejectButton.textContent = 'Reject';
    rejectButton.disabled = busy;
    rejectButton.addEventListener('click', () => void reject(change.id));

    actions.append(approveButton, rejectButton);
    rightCol.appendChild(actions);

    row.append(typeCol, titleCol, rightCol);
    return row;
  }

  function render(): void {
    gridEl.textContent = '';
    if (pendingChanges.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ai-cal-empty';
      empty.textContent = 'No pending changes';
      gridEl.appendChild(empty);
    } else {
      for (const change of pendingChanges) {
        gridEl.appendChild(renderRow(change));
      }
    }
    callbacks.onCountChange(pendingChanges.length);
  }

  // Fetches both "pending" and "failed" — a failed row is still actionable
  // (retry via approve, or reject to give up), so it stays in the same list.
  async function refresh(): Promise<void> {
    refreshButton.disabled = true;
    try {
      const [pending, failed] = await Promise.all([
        callBackground<ProposedChange[]>({ type: 'listProposedChanges', status: 'pending' }).catch(() => []),
        callBackground<ProposedChange[]>({ type: 'listProposedChanges', status: 'failed' }).catch(() => []),
      ]);
      pendingChanges = [...pending, ...failed];
      render();
    } finally {
      refreshButton.disabled = false;
    }
  }

  async function approve(id: string): Promise<void> {
    busyIds.add(id);
    render();
    try {
      const updated = await callBackground<ProposedChange>({ type: 'approveProposedChange', id });
      if (updated.status === 'applied') {
        pendingChanges = pendingChanges.filter((c) => c.id !== id);
        callbacks.onApplied();
      } else {
        // Still failed (e.g. a real conflict) — update in place so the new
        // error is visible, don't remove it.
        const index = pendingChanges.findIndex((c) => c.id === id);
        if (index !== -1) pendingChanges[index] = updated;
      }
    } finally {
      busyIds.delete(id);
      render();
    }
  }

  async function reject(id: string): Promise<void> {
    busyIds.add(id);
    render();
    try {
      await callBackground({ type: 'rejectProposedChange', id });
      pendingChanges = pendingChanges.filter((c) => c.id !== id);
    } finally {
      busyIds.delete(id);
      render();
    }
  }

  async function setPriority(id: string, priority: Priority): Promise<void> {
    busyIds.add(id);
    render();
    try {
      const updated = await callBackground<ProposedChange>({
        type: 'patchProposedChange',
        id,
        input: { priority },
      });
      const index = pendingChanges.findIndex((c) => c.id === id);
      if (index !== -1) pendingChanges[index] = updated;
    } finally {
      busyIds.delete(id);
      render();
    }
  }

  refreshButton.addEventListener('click', () => void refresh());

  function startPolling(intervalMs: number): void {
    stopPolling();
    pollId = window.setInterval(() => void refresh(), intervalMs);
  }

  function stopPolling(): void {
    if (pollId !== null) {
      window.clearInterval(pollId);
      pollId = null;
    }
  }

  render();

  return {
    element: root,
    refresh,
    startPolling,
    destroy: stopPolling,
  };
}
