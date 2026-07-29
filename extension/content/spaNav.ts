// SPA-navigation detection — Chrome-API/DOM glue, not unit-tested (mutates
// global window.history). See extension/CLAUDE.md's "CRITICAL UNRESOLVED
// RISK" note: Notion Calendar's client-side router almost certainly
// navigates via history.pushState/replaceState, which does NOT fire
// popstate — so popstate alone would miss most navigations.
//
// Primary: patch pushState/replaceState to dispatch a synthetic event.
// Also: a native popstate listener (catches back/forward, which the patch
// alone doesn't). Also, unconditionally (not "only if the above fails"):
// low-frequency polling of location.pathname as defense in depth against
// (a) a page script having captured an unpatched reference to pushState
// before this content script's document_start injection actually lands —
// document_start ordering isn't perfectly guaranteed — and (b) any
// navigation mechanism that changes the path without touching `history` at
// all. The polling cost is a cheap string comparison, so running it always
// is worth the safety margin.
const POLL_INTERVAL_MS = 750;
const EVENT_NAME = 'ai-cal-locationchange';

export function installSpaNavDetection(onChange: () => void): () => void {
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = function patchedPushState(...args) {
    originalPushState(...args);
    window.dispatchEvent(new Event(EVENT_NAME));
  };
  history.replaceState = function patchedReplaceState(...args) {
    originalReplaceState(...args);
    window.dispatchEvent(new Event(EVENT_NAME));
  };

  const listener = () => onChange();
  window.addEventListener(EVENT_NAME, listener);
  window.addEventListener('popstate', listener);

  let lastPathname = location.pathname;
  const pollId = window.setInterval(() => {
    if (location.pathname !== lastPathname) {
      lastPathname = location.pathname;
      onChange();
    }
  }, POLL_INTERVAL_MS);

  return function teardown() {
    history.pushState = originalPushState;
    history.replaceState = originalReplaceState;
    window.removeEventListener(EVENT_NAME, listener);
    window.removeEventListener('popstate', listener);
    window.clearInterval(pollId);
  };
}

// The visibility gate itself — confirmed via live URL capture during
// planning (extension-plan.md): default state is the bare root path,
// event-selected state is /event/{id}.
export function isDefaultCalendarView(): boolean {
  return !location.pathname.startsWith('/event/');
}
