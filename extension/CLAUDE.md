# Project: AI Calendar Manager — Chrome Extension

## What this is
A second thin client for the same backend the Swift app (`../app/motiondupelol/`) already talks to — a Chromium browser extension (Manifest V3) that injects a panel into Notion Calendar's web app (`calendar.notion.so`), replacing a sidebar area the user doesn't otherwise use. Both clients coexist deliberately (confirmed directly, not assumed) — this is not a Swift-app replacement. Full API contract: `../backend/backend-api-reference.md`. App-facing guiding principles (written generically enough to apply to any client, not just the Swift one): `../backend/app-development-guide.md`. This extension should be built directly against those two docs, the same way the Swift app was — don't re-derive endpoint shapes from scratch.

The planning checklist that produced the decisions below: `../extension-plan.md` (kept for history; this file is the living reference going forward).

## What gets built
One injected panel, three sections, laid out for a narrow sidebar (confirmed ~230-260px scale from the target site's own CSS):

```
┌─────────────────────┐
│ [Tasks] [Approvals]  │  ← tab switcher, one visible at a time
│                       │
│   (active tab's       │
│    content here)      │
│                       │
├─────────────────────┤
│       Chat            │  ← always visible, not tabbed
│  (history + input)    │
└─────────────────────┘
```
- **Tasks** and **Approval queue** are tabbed, not stacked — there isn't room to show both at once at this width. Feature parity with the Swift app's `TaskListView`/`ApprovalQueueView`: create/complete/filter/sort for tasks, approve/reject/set-priority + auto-polling for the queue.
- **Chat** is always visible regardless of which tab is active — feature parity with `ChatInputView`.
- Exact vertical split between the tab region and chat (fixed heights vs. flexible, chat pinned top or bottom) is an open call for build time, not resolved in planning.

## Injection target — mechanics, not just intent

**Where:** replaces Notion Calendar's default-state sidebar content (a "Search events" box + "Useful shortcuts" list) entirely — confirmed via a live DOM dump during planning, not guessed. That content is served by deeply-nested `styled-components`-generated class names (`sc-XXXXX-N` pattern) — **assume these will regenerate on Notion Calendar's next deploy.** Do not hardcode a specific hash class as the anchor. Prefer a structural/content-based selector (e.g. "the element containing the text 'Useful shortcuts'", or the least-deeply-hashed stable ancestor found at implementation time) over a literal class name, and log a clear, loud console warning if the anchor isn't found at injection time rather than failing silently — this is the one part of the whole system outside our control, so breakage needs to be immediately diagnosable, not a mystery bug report later.

**When:** the sidebar is state-dependent — confirmed via live URL capture during planning:
- Default state (show our panel): `https://calendar.notion.so` (bare root path)
- Event-selected state (render nothing, let Notion's own event-detail view show through untouched): `https://calendar.notion.so/event/{id}`

Gate: show iff `location.pathname === '/'` (or, more defensively, iff it does *not* start with `/event/`).

**Notion Calendar is an SPA — `popstate` alone will miss most navigations.** Client-side route changes triggered by `history.pushState`/`replaceState` do not fire `popstate`. The visibility-gate logic needs to either (a) monkey-patch `history.pushState`/`replaceState` to dispatch a synthetic event the content script listens for, or (b) fall back to a `MutationObserver` on `document.title` or another URL-correlated DOM signal, or (c) poll `location.pathname` on a short interval as a blunt fallback. Verify which of these actually fires reliably against the real site before committing to one — this is exactly the kind of assumption that should be checked live, not assumed from how a "typical" SPA behaves.

## Architecture principles

1. **Pure logic lives apart from Chrome-API glue, from the first file.** Same split this session already validated in the backend (`lib/eventTaskDescriptionFormat.ts`, pure, unit-tested vs. `lib/eventTaskDescription.ts`, the thin Supabase/Google-Calendar-touching wrapper around it). Task filter/sort logic, message-protocol types, response parsing: plain TS functions, zero `chrome.*` calls, unit-tested with `vitest`. `chrome.runtime`/`chrome.storage`/`fetch` calls: thin wrapper functions around that core, not unit-tested, kept small enough to eyeball.

2. **The background service worker owns every network call and the API key. The content script and panel UI never call `fetch` directly.** This is not a style preference — it's what avoids CORS entirely without any backend change. A content script's `fetch()` runs in the page's origin (`calendar.notion.so`), and the backend sends no `Access-Control-Allow-Origin` header (confirmed — there's no CORS handling anywhere in `../backend/`). A background service worker's `fetch()`, with `host_permissions` declared for the backend's domain, is not subject to that restriction. Content script/panel → `chrome.runtime.sendMessage` → background does the real work → sends the result back. Define the message shape as an explicit discriminated-union TS type shared by both sides before writing either (e.g. `{ type: 'FETCH_TASKS' } | { type: 'APPROVE_CHANGE'; id: string } | ...`) — this is this project's equivalent of `backend-api-reference.md`: the contract that keeps the two halves from drifting apart silently.

3. **Least-privilege permissions.** `host_permissions` scoped to `calendar.notion.so` and the backend's Vercel domain specifically. Never `<all_urls>`. Get this right in the manifest from the start — retrofitting narrower permissions after code already assumes broad access is real rework, not a config tweak.

4. **The API key is never hardcoded in source.** Extension JS ships as readable files in the unpacked/`.crx` package — unlike the compiled Swift binary, there's no obscurity layer at all. Flow: an options page where the key is pasted once, stored via `chrome.storage.local` — **never `chrome.storage.sync`**, which would sync the key to Google's servers. Confirmed decision: reuse the same `APP_SECRET_KEY` the Swift app uses (not a separate extension-specific key) — accepted tradeoff, not an oversight: if this key ever leaks from the extension side, revoking it also breaks the Swift app, since there's only the one key. Revisit if that tradeoff stops feeling acceptable; the backend change to support two keys is small (`../backend/lib/auth.ts`'s `isAuthorized` would need to accept either).

5. **Manifest V3 constraints shape the build tooling, not the other way around.** No remote code, no `eval` — everything ships pre-bundled. Confirmed choice: `vite` + `@crxjs/vite-plugin` (standard MV3 setup, dev-server hot-reload for the panel, handles the bundling requirement out of the box). Plain TypeScript + HTML/CSS for the panel UI itself (confirmed — no React; the three-section scope here is small enough that a framework isn't earning its weight, unlike a hypothetically larger app).

6. **Test the pure layer with `vitest`, reusing the backend's already-configured tool** — not a second test runner. The Swift app has zero automated tests today (build-success + manual verification only); don't repeat that gap here by default just because it wasn't caught last time.

## Project structure (once scaffolded)

```
extension/
  manifest.json          — MV3, host_permissions for calendar.notion.so + the backend domain
  background.ts          — service worker: owns the API key, does every fetch, runs the poll
  content-script.ts      — detects sidebar state (URL gate), mounts/unmounts the panel root
  panel/
    TaskList.ts
    ApprovalQueue.ts
    ChatInput.ts
    tabs.ts               — the Tasks/Approvals tab switcher
  lib/                    — pure logic: filters, sorters, message-protocol types, parsers
  options.html            — one-time setup: paste API key + backend URL → chrome.storage.local
```

## Open items (not yet decided — flag if this matters for what you're building)
- Exact vertical split between the tab region and the always-visible chat (fixed vs. flexible height, which is pinned where)
- Which SPA-navigation-detection strategy (`pushState` patch vs. `MutationObserver` vs. polling) actually works reliably against the real site — needs live verification before the visibility gate is finalized
- The concrete DOM anchor selector for injection — needs to be chosen against the live site at implementation time, not hardcoded from the one DOM dump captured during planning
- 25s polling interval for the approval queue (matching the Swift app) — reasonable default, not re-confirmed for this client specifically
