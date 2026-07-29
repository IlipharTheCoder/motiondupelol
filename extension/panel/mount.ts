// The composition root — mounts the panel's DOM into the Shadow DOM root
// content-script.ts creates. Shadow DOM keeps Notion's global
// styled-components CSS from bleeding into the panel and vice versa.
//
// Panel instances (and their in-memory state — tasks, pending changes, the
// approval-queue poll) are built ONCE and reused across every
// unmount/remount cycle, not recreated per mount. Notion re-renders the
// whole sidebar region on every route change, so the *host* element and its
// shadow root genuinely can't survive a navigation — but the panel's own
// DOM subtree (a plain node) can simply be re-appended into a fresh shadow
// root each time, since appendChild moves rather than clones. This is what
// makes "state survives unmount/remount; only the DOM and timers don't"
// (extension/CLAUDE.md) literally true: chat history, the task list, and
// the approval queue's 25s poll all keep running across a trip into an
// event's detail view and back — deliberately not paused on unmount, the
// same way the Swift app only pauses its poll on true app backgrounding
// (scenePhase), not on switching to a different in-app screen. Viewing an
// event's detail view is the closer analogy to the latter, not the former.
import panelCss from './panel.css?inline';
import { createTabs } from './tabs';
import { createTaskListPanel } from './TaskList';
import { createApprovalQueuePanel } from './ApprovalQueue';
import { createChatPanel } from './ChatInput';
import { callBackground } from './backgroundClient';
import type { BackgroundRequest } from '../lib/messages';

const APPROVAL_POLL_INTERVAL_MS = 25_000; // matches ProposedChangesViewModel.swift's default

interface PanelInstances {
  root: HTMLElement;
}

let instances: PanelInstances | null = null;
let buildFailed = false;

function renderSetupPrompt(shadow: ShadowRoot): void {
  const el = document.createElement('div');
  el.className = 'ai-cal-setup-prompt';
  const text = document.createElement('div');
  text.textContent = 'AI Calendar Manager isn’t configured yet.';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Open setup';
  button.addEventListener('click', () =>
    chrome.runtime.sendMessage({ type: 'openOptionsPage' } satisfies BackgroundRequest)
  );
  el.append(text, button);
  shadow.appendChild(el);
}

function buildInstances(): PanelInstances {
  const root = document.createElement('div');
  root.className = 'ai-cal-panel-root';

  const tasksEl = document.createElement('div');
  tasksEl.className = 'ai-cal-tab-content';
  const approvalsEl = document.createElement('div');
  approvalsEl.className = 'ai-cal-tab-content';

  const taskList = createTaskListPanel(tasksEl);

  const tabs = createTabs(root, [
    { id: 'tasks', label: 'Tasks', element: tasksEl },
    { id: 'approvals', label: 'Approvals', element: approvalsEl },
  ]);
  root.append(tasksEl, approvalsEl);

  const approvalQueue = createApprovalQueuePanel(approvalsEl, {
    // An applied change can affect tasks (e.g. a task-linking update) —
    // cheap and harmless to reload even when it wasn't task-related,
    // matching ApprovalQueueView.swift's own onApplied wiring.
    onApplied: () => void taskList.refresh(),
    onCountChange: (count) => tabs.setBadge('approvals', count),
  });
  void approvalQueue.refresh();
  approvalQueue.startPolling(APPROVAL_POLL_INTERVAL_MS);

  // Chat is always visible regardless of which tab is active — a sibling
  // of the tab bar, not inside either tab's content.
  const chatEl = document.createElement('div');
  createChatPanel(chatEl, {
    onProposalsReceived: () => void approvalQueue.refresh(),
    onTasksChanged: () => void taskList.refresh(),
  });
  root.appendChild(chatEl);

  return { root };
}

export async function mountPanel(shadow: ShadowRoot): Promise<void> {
  const style = document.createElement('style');
  style.textContent = panelCss;
  shadow.appendChild(style);

  if (!instances && !buildFailed) {
    const { configured } = await callBackground<{ configured: boolean }>({ type: 'getConfigStatus' });
    if (!configured) {
      buildFailed = true; // re-checked on the next full page load, not on every remount within one page load
      renderSetupPrompt(shadow);
      return;
    }
    instances = buildInstances();
  }

  if (instances) {
    shadow.appendChild(instances.root);
  } else {
    renderSetupPrompt(shadow);
  }
}

// Deliberately a no-op — see this file's top comment. content-script.ts
// removes the host <div data-ai-cal-panel="root"> itself, which detaches
// `instances.root` from the document; mounting again just re-appends the
// same node (and its live state) into a fresh shadow root.
export function unmountPanel(): void {}
