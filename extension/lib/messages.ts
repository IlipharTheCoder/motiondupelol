// The content-script/panel <-> background-service-worker message contract —
// written before either side, per extension/CLAUDE.md's architecture
// principle 2. The background service worker is the ONLY place that ever
// calls fetch() or touches the API key (see background.ts) — this union is
// how every other part of the extension asks it to do so. Never call
// chrome.runtime.sendMessage directly outside panel/backgroundClient.ts;
// import BackgroundRequest/BackgroundResponse and go through that wrapper.
import type {
  TaskStatus,
  ProposalStatus,
  CreateTaskInput,
  UpdateTaskInput,
  PatchProposedChangeInput,
} from './types';

export type BackgroundRequest =
  | { type: 'getConfigStatus' }
  | { type: 'openOptionsPage' }
  | { type: 'listTasks'; status?: TaskStatus }
  | { type: 'createTask'; input: CreateTaskInput }
  | { type: 'updateTask'; id: string; input: UpdateTaskInput }
  | { type: 'completeTask'; id: string }
  | { type: 'listProposedChanges'; status?: ProposalStatus; groupId?: string }
  | { type: 'approveProposedChange'; id: string }
  | { type: 'rejectProposedChange'; id: string }
  | { type: 'patchProposedChange'; id: string; input: PatchProposedChangeInput }
  | { type: 'sendChatMessage'; message: string; conversationId?: string }
  | { type: 'refresh' }
  | { type: 'resyncCalendars' };

export type BackgroundResponse<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
