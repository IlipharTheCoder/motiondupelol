// Feature parity with app/motiondupelol/Shared/ChatInputView.swift +
// CoreLogic/ChatViewModel.swift — optimistic user-bubble-before-response,
// conversation_id persistence (see lib/chat.ts's buildChatRequestBody for
// the omit-when-absent contract), the two conditional usage-stat lines, and
// the cross-module onProposalsReceived/onTasksChanged callbacks.
import type { ChatResponse, ChatUsage } from '../lib/types';
import { accumulateSessionCost, cacheWriteTotal, shouldShowCacheHitLine, shouldShowCacheWriteLine } from '../lib/chat';
import { callBackground } from './backgroundClient';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatCallbacks {
  onProposalsReceived: () => void;
  onTasksChanged: () => void;
}

export interface ChatHandle {
  element: HTMLElement;
}

export function createChatPanel(container: HTMLElement, callbacks: ChatCallbacks): ChatHandle {
  const history: ChatMessage[] = [];
  let conversationId: string | undefined;
  let isSending = false;
  let lastUsage: ChatUsage | null = null;
  let sessionCostUsd = 0;

  const root = document.createElement('div');
  root.className = 'ai-cal-chat';

  const usageBox = document.createElement('div');
  usageBox.className = 'ai-cal-chat-usage';
  usageBox.style.display = 'none';

  const historyEl = document.createElement('div');
  historyEl.className = 'ai-cal-chat-history';
  historyEl.style.display = 'none';

  const inputRow = document.createElement('div');
  inputRow.className = 'ai-cal-chat-input-row';
  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Ask anything…';
  textarea.rows = 1;
  const sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.textContent = '↑';
  sendButton.disabled = true;
  inputRow.append(textarea, sendButton);

  root.append(usageBox, historyEl, inputRow);
  container.appendChild(root);

  function usageRow(label: string, value: string): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'ai-cal-chat-usage-row';
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    return row;
  }

  function renderUsage(): void {
    if (!lastUsage) {
      usageBox.style.display = 'none';
      return;
    }
    usageBox.style.display = '';
    usageBox.textContent = '';
    usageBox.appendChild(usageRow('In', `${lastUsage.inputTokens.toLocaleString()} tok`));
    usageBox.appendChild(usageRow('Out', `${lastUsage.outputTokens.toLocaleString()} tok`));
    if (shouldShowCacheHitLine(lastUsage)) {
      usageBox.appendChild(usageRow('Cache hit', `${lastUsage.cacheReadTokens.toLocaleString()} tok`));
    }
    if (shouldShowCacheWriteLine(lastUsage)) {
      usageBox.appendChild(usageRow('Cache write', `${cacheWriteTotal(lastUsage).toLocaleString()} tok`));
    }
    usageBox.appendChild(usageRow('Last call', `$${lastUsage.estimatedCostUsd.toFixed(5)}`));
    usageBox.appendChild(usageRow('Session', `$${sessionCostUsd.toFixed(5)}`));
  }

  function renderHistory(): void {
    if (history.length === 0) {
      historyEl.style.display = 'none';
      return;
    }
    historyEl.style.display = '';
    historyEl.textContent = '';
    for (const message of history) {
      const bubble = document.createElement('div');
      bubble.className = `ai-cal-chat-bubble ai-cal-chat-bubble-${message.role}`;
      bubble.textContent = message.text;
      historyEl.appendChild(bubble);
    }
    historyEl.scrollTop = historyEl.scrollHeight;
  }

  function updateSendEnabled(): void {
    sendButton.disabled = isSending || textarea.value.trim().length === 0;
    textarea.disabled = isSending;
  }

  async function send(): Promise<void> {
    const message = textarea.value.trim();
    if (!message || isSending) return;

    isSending = true;
    textarea.value = '';
    history.push({ role: 'user', text: message });
    renderHistory();
    updateSendEnabled();

    try {
      const response = await callBackground<ChatResponse>({
        type: 'sendChatMessage',
        message,
        conversationId,
      });
      conversationId = response.conversationId;
      history.push({ role: 'assistant', text: response.reply });
      lastUsage = response.usage;
      sessionCostUsd = accumulateSessionCost(sessionCostUsd, response.usage);
      renderUsage();
      if (response.proposals.length > 0) callbacks.onProposalsReceived();
      if (response.tasksChanged) callbacks.onTasksChanged();
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      history.push({ role: 'assistant', text: `Error: ${text}` });
    } finally {
      isSending = false;
      renderHistory();
      updateSendEnabled();
    }
  }

  textarea.addEventListener('input', updateSendEnabled);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
  sendButton.addEventListener('click', () => void send());

  return { element: root };
}
