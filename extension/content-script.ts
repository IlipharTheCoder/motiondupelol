// The content-script entry point — glue only. Every actual API call goes
// through chrome.runtime.sendMessage to background.ts (never a direct
// fetch() from here — see extension/CLAUDE.md principle 2). Runs at
// document_start (manifest.json) so content/spaNav.ts's history patch is in
// place before Notion's own bundle loads.
import { findSidebarAnchor } from './lib/anchorFinder';
import { installSpaNavDetection, isDefaultCalendarView } from './content/spaNav';
import { watchForAnchor } from './content/domWatcher';
import { mountPanel, unmountPanel } from './panel/mount';

const PANEL_ROOT_ATTR = 'data-ai-cal-panel';

let stopWatching: (() => void) | null = null;

function isMounted(): boolean {
  return document.querySelector(`[${PANEL_ROOT_ATTR}="root"]`) !== null;
}

function tryMount(): boolean {
  if (isMounted()) return true;
  const anchor = findSidebarAnchor(document);
  if (!anchor) return false;

  anchor.innerHTML = '';
  const root = document.createElement('div');
  root.setAttribute(PANEL_ROOT_ATTR, 'root');
  anchor.appendChild(root);
  const shadow = root.attachShadow({ mode: 'open' });
  mountPanel(shadow);
  return true;
}

function unmount(): void {
  const root = document.querySelector(`[${PANEL_ROOT_ATTR}="root"]`);
  if (root) {
    unmountPanel();
    root.remove();
  }
}

function onGiveUp(): void {
  console.warn(
    '[AI Calendar Manager] Could not find the Notion Calendar sidebar anchor after ' +
      '10s of watching the DOM. Notion likely changed its sidebar structure — this ' +
      "extension needs its lib/anchorFinder.ts selector updated. Panel not injected."
  );
}

function sync(): void {
  stopWatching?.();
  stopWatching = null;

  if (isDefaultCalendarView()) {
    stopWatching = watchForAnchor(tryMount, onGiveUp);
  } else {
    unmount();
  }
}

installSpaNavDetection(sync);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', sync);
} else {
  sync();
}
