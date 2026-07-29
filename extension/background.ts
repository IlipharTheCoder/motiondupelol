// The service worker — the ONLY place in this extension that calls fetch()
// or reads the API key (extension/CLAUDE.md, architecture principle 2).
// This is what lets the extension talk to a backend with zero CORS headers
// configured: a fetch() issued from here, with a matching host_permissions
// entry, is exempt from the CORS enforcement a content-script-context
// fetch() would be subject to. Content scripts and the panel UI must never
// fetch directly — everything comes through chrome.runtime.sendMessage and
// the BackgroundRequest/BackgroundResponse contract in lib/messages.ts.
import type { BackgroundRequest, BackgroundResponse } from './lib/messages';
import { parseCalendarResyncResult, parseChatResponse, parseProposedChange, parseTask } from './lib/parsers';
import { buildChatRequestBody } from './lib/chat';
import { buildCreateTaskBody, buildPatchProposedChangeBody, buildUpdateTaskBody } from './lib/requestBodies';

interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
}

async function getConfig(): Promise<StoredConfig> {
  return chrome.storage.local.get(['apiKey', 'baseUrl']);
}

class ApiError extends Error {}

// One shared fetch wrapper — every operation below goes through this, same
// x-api-key-header convention app/motiondupelol/CoreLogic/APIClient.swift
// uses. Throws ApiError on any non-2xx or network failure; callers don't
// need their own try/catch, handleRequest's own catch (below) covers it.
async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const { apiKey, baseUrl } = await getConfig();
  if (!apiKey || !baseUrl) {
    throw new ApiError('Not configured — open the extension options page and set an API key + backend URL.');
  }

  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'x-api-key': apiKey,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  if (res.status === 401) {
    throw new ApiError('Unauthorized — check the API key in the extension options page.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body && typeof body === 'object' && 'error' in body ? String(body.error) : `Request failed (${res.status})`;
    throw new ApiError(message);
  }
  if (res.status === 204) return null;
  return res.json();
}

function query(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined);
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries).toString()}`;
}

async function handleRequest(request: BackgroundRequest): Promise<BackgroundResponse> {
  try {
    switch (request.type) {
      case 'getConfigStatus': {
        const { apiKey, baseUrl } = await getConfig();
        return { ok: true, data: { configured: Boolean(apiKey && baseUrl) } };
      }

      case 'openOptionsPage': {
        chrome.runtime.openOptionsPage();
        return { ok: true, data: undefined };
      }

      case 'listTasks': {
        const raw = (await apiFetch(`/api/tasks${query({ status: request.status })}`)) as unknown[];
        return { ok: true, data: raw.map(parseTask) };
      }

      case 'createTask': {
        const raw = await apiFetch('/api/tasks', {
          method: 'POST',
          body: JSON.stringify(buildCreateTaskBody(request.input)),
        });
        return { ok: true, data: parseTask(raw) };
      }

      case 'updateTask': {
        const raw = await apiFetch(`/api/tasks/${request.id}`, {
          method: 'PATCH',
          body: JSON.stringify(buildUpdateTaskBody(request.input)),
        });
        return { ok: true, data: parseTask(raw) };
      }

      case 'completeTask': {
        const raw = await apiFetch(`/api/tasks/${request.id}/complete`, { method: 'POST' });
        return { ok: true, data: parseTask(raw) };
      }

      case 'listProposedChanges': {
        const raw = (await apiFetch(
          `/api/proposed-changes${query({ status: request.status, group_id: request.groupId })}`
        )) as unknown[];
        return { ok: true, data: raw.map(parseProposedChange) };
      }

      case 'approveProposedChange': {
        const raw = await apiFetch(`/api/proposed-changes/${request.id}/approve`, { method: 'POST' });
        return { ok: true, data: parseProposedChange(raw) };
      }

      case 'rejectProposedChange': {
        const raw = await apiFetch(`/api/proposed-changes/${request.id}/reject`, { method: 'POST' });
        return { ok: true, data: parseProposedChange(raw) };
      }

      case 'patchProposedChange': {
        const raw = await apiFetch(`/api/proposed-changes/${request.id}`, {
          method: 'PATCH',
          body: JSON.stringify(buildPatchProposedChangeBody(request.input)),
        });
        return { ok: true, data: parseProposedChange(raw) };
      }

      case 'sendChatMessage': {
        const raw = await apiFetch('/api/chat', {
          method: 'POST',
          body: JSON.stringify(buildChatRequestBody(request.message, request.conversationId)),
        });
        return { ok: true, data: parseChatResponse(raw) };
      }

      case 'refresh': {
        await apiFetch('/api/refresh', { method: 'POST' });
        return { ok: true, data: undefined };
      }

      case 'resyncCalendars': {
        // Backend allows up to ~60s (Vercel maxDuration) for this one —
        // no client-side timeout is set, the caller's UI should just show
        // a busy state for however long the real sync takes.
        const raw = await apiFetch('/api/calendar/resync', { method: 'POST' });
        return { ok: true, data: parseCalendarResyncResult(raw) };
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundRequest, _sender, sendResponse) => {
  handleRequest(message).then(sendResponse);
  return true; // keep the message channel open for the async response
});

// The toolbar icon has no popup (manifest.json omits action.default_popup)
// — its only job is to jump straight to setup.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});
