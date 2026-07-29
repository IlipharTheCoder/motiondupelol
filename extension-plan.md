# Chrome Extension — Planning Checklist

Fill in the blanks / check the boxes below, save, and tell me it's done. Everything
marked **(recommended)** is my default if you leave it as-is — you only need to write
something if you want to override it. Backend needs zero changes for any of this;
it's a new client hitting the same API the Swift app already uses.

---

## 1. Injection target (do this first — it's the one thing that can invalidate the plan)

Open devtools on Notion Calendar, right-click the white sidebar you want to use, Inspect.

- [ ] Does the sidebar element have a stable `id` or `data-*` attribute, or only
      auto-generated/hashed class names (e.g. `css-a8f31x`)?

  Paste what you found here:
  ```
      <div class="sc-1je7ayr-2 bZnsQW"><div class="sc-1je7ayr-1 enHWcn"><div class="sc-1je7ayr-0 evkbMl" style="opacity: 1; transform: none;"><div class="sc-6jgiuu-0 sc-16a6nl7-8 krlKcg fuqqCb"><div class="sc-15zpq92-10 fheZZs sc-16a6nl7-3 jMglsN"><div class="sc-15zpq92-9 hZdtxs"><div class="sc-1gvbi80-6 jWoIuA" style="--container-width: 232px; --icon-width: 18px; --icon-right-margin: 8px; --detail-leading-width: 0px; --detail-leading-right-margin: 0px; --input-value-width: 85.7421875px; --detail-trailing-width: 0px; --detail-trailing-left-margin: 0px;"><div class="sc-1gvbi80-5 omDLg"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 20" style="width: 18px; height: 18px;"><path fill="currentColor" d="M14.75 10.875a3.625 3.625 0 0 1 2.938 5.747l1.283 1.467.073.102a.626.626 0 0 1-1.015.72l-1.239-1.416a3.625 3.625 0 1 1-2.04-6.62m0 1.25a2.375 2.375 0 1 0 0 4.75 2.375 2.375 0 0 0 0-4.75"></path><path fill="currentColor" d="M14.375 5A2.625 2.625 0 0 1 17 7.625v2.69a4.7 4.7 0 0 0-1.25-.459V7.625c0-.76-.616-1.375-1.375-1.375h-8.75c-.76 0-1.375.616-1.375 1.375v4.45c0 .76.616 1.375 1.375 1.375h4.493a4.8 4.8 0 0 0-.113 1.25h-4.38A2.625 2.625 0 0 1 3 12.075v-4.45A2.625 2.625 0 0 1 5.625 5z"></path></svg></div><input data-subdued="true" autocomplete="off" placeholder="Search events" autocapitalize="off" spellcheck="false" data-form-type="other" data-lpignore="true" data-input="true" type="text" value=""><div aria-hidden="true" class="sc-1gvbi80-4 fQjRWC">Search events</div></div><div class="sc-15zpq92-8 ihTExJ"><button aria-describedby="tooltip-qz1sh3wjt" class="sc-gfyskm-3 domPjm sc-egm50s-0 cFKGCs" type="button"><div class="sc-gfyskm-2 bEjQfc"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 20 20" style="width: 18px; height: 18px;"><path fill="currentColor" d="M16.25 3.625c1.174 0 2.125.951 2.125 2.125v8.5a2.125 2.125 0 0 1-2.125 2.125H3.75a2.125 2.125 0 0 1-2.125-2.125v-8.5c0-1.174.951-2.125 2.125-2.125zm-12.5 1.25a.875.875 0 0 0-.875.875v8.5c0 .483.392.875.875.875h8.7V4.875zm9.8 10.25h2.7a.875.875 0 0 0 .875-.875v-8.5a.875.875 0 0 0-.875-.875h-2.7z"></path></svg></div></button></div></div><div class="sc-15zpq92-6 YVqJy"></div></div><div class="sc-16a6nl7-7 gYxDPd"><div class="sc-16a6nl7-1 eDDfyz"><div class="sc-16a6nl7-0 bTBvev">Useful shortcuts</div><ul class="sc-16a6nl7-6 hbgxlg"><li class="sc-16a6nl7-5 joRrtx"><div class="sc-16a6nl7-4 bbwWmJ">Command menu</div><span class="sc-rc1qsi-3 dWJYjF"><kbd class="sc-rc1qsi-1 bReyGY">⌘</kbd><kbd class="sc-rc1qsi-1 bReyGY">K</kbd></span></li><li class="sc-16a6nl7-5 joRrtx"><div class="sc-16a6nl7-4 bbwWmJ">Toggle sidebar</div><span class="sc-rc1qsi-3 dWJYjF"><kbd class="sc-rc1qsi-1 bReyGY">`</kbd></span></li><li class="sc-16a6nl7-5 joRrtx"><div class="sc-16a6nl7-4 bbwWmJ">Show teammate calendar</div><span class="sc-rc1qsi-3 dWJYjF"><kbd class="sc-rc1qsi-1 bReyGY">P</kbd></span></li><li class="sc-16a6nl7-5 joRrtx"><div class="sc-16a6nl7-4 bbwWmJ">Go to date</div><span class="sc-rc1qsi-3 dWJYjF"><kbd class="sc-rc1qsi-1 bReyGY">.</kbd></span></li><li class="sc-16a6nl7-5 joRrtx"><div class="sc-16a6nl7-4 bbwWmJ">All keyboard shortcuts</div><span class="sc-rc1qsi-3 dWJYjF"><kbd class="sc-rc1qsi-1 bReyGY">?</kbd></span></li></ul></div></div></div></div></div></div>


  ```

- [ ] Replace what's currently in that sidebar, or add alongside/underneath it?
  - [X] Replace it entirely — **RESOLVED:** replaces the "Search events / Useful shortcuts"
        default-state content shown above. Simpler than "inject alongside" turned out to
        be, since there's nothing of that content worth keeping alongside ours.
  - [ ] Inject above/below the existing content, leave it in place
  - [ ] Other: ______________________

- [ ] Should the panel always show in that spot, or be collapsible/toggleable?
  - [ ] Always visible
  - [X] **RESOLVED — visibility gated by app state, not user-toggled:** the sidebar is
        state-dependent (default view vs. event-detail view when an event is selected,
        confirmed via URL change). Our panel only renders in the default state; when an
        event is selected, we render nothing and let Notion's own event-detail view show
        through untouched. This also means the event-detail DOM dump is no longer
        needed — visibility is gated by URL pattern, not by diffing two DOM states.

  **Still needed before this section is fully build-ready:** the URL pattern Notion
  Calendar uses when an event is selected (hash change? path change? query param?) —
  that's what the show/hide logic keys off. Paste an example URL from each state below:
  ```
  Default (no event selected):
https://calendar.notion.so

  Event selected:
https://calendar.notion.so/event/M2ExdGE4aDVuajd1cmYwN2I3aW9xMWc0YzQvYzdiODRmZTVlMDE2Y2VkNWU2MWZlNWU1YTlkOTE5MGJiMzlhMGY3ZTUyNjIwMzc0OGY1ODdhZDIwZTlkYjFhNEBncm91cC5jYWxlbmRhci5nb29nbGUuY29tLzEzZjk1Mjk4LTE1NmItNDk4Ni1hMTM3LWUyYTgxNjMxMWMwNw==
or 
https://calendar.notion.so/event/bGdvNHRxN2NucTBxamRmNzdsajRjNjNmbjgvYzdiODRmZTVlMDE2Y2VkNWU2MWZlNWU1YTlkOTE5MGJiMzlhMGY3ZTUyNjIwMzc0OGY1ODdhZDIwZTlkYjFhNEBncm91cC5jYWxlbmRhci5nb29nbGUuY29tLzEzZjk1Mjk4LTE1NmItNDk4Ni1hMTM3LWUyYTgxNjMxMWMwNw==


  ```

---

## 2. What shows up in the panel

Which of the three Swift app sections does this extension need? All three — **RESOLVED
layout**, given the sidebar's narrow width:

- **Chat** — always visible (its own fixed region of the panel, not tabbed)
- **Tasks** and **Approval queue** — two tabs sharing the remaining space, one visible
  at a time (a small tab switcher, not stacked — there isn't room to show both at once
  at this width)

```
Panel layout, top to bottom:
┌─────────────────────┐
│ [Tasks] [Approvals]  │  ← tab switcher
│                       │
│   (active tab's       │
│    content here)      │
│                       │
├─────────────────────┤
│       Chat            │  ← always visible
│  (history + input)    │
└─────────────────────┘
```
(Exact split — chat pinned to the bottom vs. top, relative height of each region — still
open; flag here if you have a preference, otherwise I'll make a reasonable call when
building.)

---

## 3. Framework for the panel UI

- [X] Plain TypeScript + HTML/CSS **(recommended — matches the actual size of 1-3 small panels)**
- [ ] React
- [ ] Other: ______________________

---

## 4. API key for this client

The extension's JS ships as readable source (unlike the compiled Swift binary), so its
key is more exposed. Options:

- [X] Reuse the existing `APP_SECRET_KEY` (same one the Swift app uses)
- [ ] Issue a **separate** key for the extension **(recommended — if it ever leaks,
      you can revoke just this one without breaking the Swift app)**. Needs a small
      backend change: `isAuthorized()` in `lib/auth.ts` would need to accept either key.

---

## 5. Repo location

- [X] New `extension/` directory at the repo root, sibling to `app/` and `backend/`
      **(recommended — matches the existing two-client-one-backend layout)**
- [ ] Somewhere else: ______________________

---

## 6. Bundler / build tooling

- [X] `vite` + `@crxjs/vite-plugin` **(recommended — standard MV3 setup, dev-server
      hot-reload for the panel, handles the "no remote code" bundling requirement)**
- [ ] Something else: ______________________

---

## 7. Testing

- [X] Reuse `vitest` for the pure logic layer (filter/sort functions, message-protocol
      types, response parsing) **(recommended — same tool the backend already uses,
      zero new setup cost)**
- [ ] Skip automated tests for this, same as the Swift app has today
- [ ] Other: ______________________

---

## 8. Anything else I should know before starting

```


```
