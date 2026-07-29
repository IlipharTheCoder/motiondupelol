# AI Calendar Manager — Chrome Extension

Second thin client for the same backend the Swift app talks to (`../app/motiondupelol/`).
Injects a Tasks/Approvals/Chat panel into Notion Calendar's sidebar. See `CLAUDE.md` for
the full architecture reference — this file is just load/run instructions.

## Load it unpacked

```bash
npm install
npm run build
```

Then in Chrome (or any Chromium browser — Edge, Brave, Arc all work identically):

1. `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select `extension/dist/`

## Set up your API key

Click the extension's toolbar icon (or right-click it → Options). Paste in:
- **Backend URL** — e.g. `https://motiondupelol.vercel.app`
- **API key** — the same `x-api-key` value the Swift app's `Secrets.swift` uses

Stored in `chrome.storage.local` only — never synced, never in source.

## Development

```bash
npm run dev    # vite dev server with HMR — reload the unpacked extension after changes
npm test       # vitest — the pure logic layer (lib/*.ts)
npx tsc --noEmit -p .   # typecheck everything, including DOM/Chrome-API glue
```

## What's automatically verified vs. what isn't

`npm test` + `npx tsc --noEmit -p .` + `npm run build` cover: every pure-logic module
(sort/filter/needsPriority/secondaryLine/case-conversion/chat-body-building/anchor-finding
against a real captured DOM fixture), full type-safety across the whole extension, and
that the manifest/bundle actually produces a loadable `dist/`.

**Not automatically verified — no browser-driving is set up yet, this needs a human:**
- Live injection against the real `calendar.notion.so` (anchor found, panel replaces the
  search/shortcuts sidebar cleanly, no visual clipping at the real sidebar width)
- The visibility gate across a real click-into-an-event, browser back/forward, and a
  direct URL edit — proving the pushState-patch + popstate + poll fallback all work
- End-to-end task/approval/chat actions against the real backend (create, complete,
  sort, filter, approve, reject, the priority-picker gate, chat send/receive)
- The cache-hit/cache-write usage lines specifically — per `backend-api-reference.md`'s
  own measurement, the chat layer's stable prompt prefix is currently under Claude
  Haiku 4.5's cacheable-length minimum, so those two lines won't actually show up on a
  live call yet; the unit tests are the real coverage for that logic until the backend
  crosses that threshold

If `lib/anchorFinder.ts` ever stops finding the sidebar, check the browser console for a
`[AI Calendar Manager]` warning first — it names the exact file that needs updating.
