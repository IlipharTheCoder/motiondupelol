// Retries anchor-finding as the page's DOM fills in — Chrome-API/DOM glue,
// not unit-tested. On first load this content script runs at
// document_start, before Notion has rendered anything at all, so the very
// first attempt failing is expected/routine, not an error. Debounces
// mutation bursts and only escalates to a loud console warning after a
// bounded window of genuinely no success — so normal startup latency never
// triggers a false alarm, but a real Notion redesign (the anchor never
// appearing at all) still gets flagged loudly, per extension/CLAUDE.md's
// "fail loudly, not silently" instruction.
const DEBOUNCE_MS = 200;
const GIVE_UP_AFTER_MS = 10_000;

export function watchForAnchor(tryFind: () => boolean, onGiveUp: () => void): () => void {
  const startedAt = Date.now();
  let debounceId: number | undefined;
  let gaveUp = false;

  const attempt = () => {
    if (gaveUp) return;
    const found = tryFind();
    if (found) {
      observer.disconnect();
      return;
    }
    if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
      gaveUp = true;
      observer.disconnect();
      onGiveUp();
    }
  };

  const observer = new MutationObserver(() => {
    window.clearTimeout(debounceId);
    debounceId = window.setTimeout(attempt, DEBOUNCE_MS);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // One immediate attempt too — the anchor might already be present (e.g.
  // re-entering the default view after navigating back from an event).
  attempt();

  return function teardown() {
    observer.disconnect();
    window.clearTimeout(debounceId);
  };
}
