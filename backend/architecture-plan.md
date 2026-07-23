# Architecture Plan — AI Calendar Manager

## 0. The core problem with the current picture

Right now there are four floating pieces — burner calendar, universal inbox, the engine, the Calendly-style scheduler — with no shared spine connecting them. The fix is one architectural decision:

> **Build a small central backend that all four pieces talk to. Mac and iPhone become thin display/approval clients; the backend holds the data and does the thinking.**

This single decision answers most of the "where does this live" questions in your notes:
- **"Not sure where the inbox could be stored"** → the same backend/database you're already standing up for the Calendly scheduler. No separate island.
- **The engine needs to act even when your phone is asleep and your Mac is closed** → it can't live only on-device. It has to run somewhere always-on — which is the backend.
- **The Calendly scheduler needs to check your real availability and write bookings somewhere** → same backend, same database, same calendar connection. Not a separate system that happens to also touch your calendar.

Everything below assumes this shape.

---

## 1. System Overview

```
┌─────────────────┐        ┌─────────────────┐
│   Mac App        │        │   iPhone App     │
│  (SwiftUI, thin) │        │  (SwiftUI, thin) │
│  - display        │        │  - display        │
│  - approve/reject │        │  - approve/reject │
│  - capture         │        │  - capture         │
│    screenshots     │        │    screenshots     │
└────────┬─────────┘        └────────┬─────────┘
         │        REST/JSON API over HTTPS       │
         └───────────────────┬─────────────────────┘
                              │
                 ┌────────────▼─────────────┐
                 │   Backend (Vercel)          │
                 │   - Serverless functions    │
                 │   - Scheduling engine        │
                 │   - Universal Inbox API      │
                 │   - Calendly-style booking   │
                 │     pages (public)           │
                 │   - Cron: sync loop trigger  │
                 └────┬─────────────┬──────────┘
                      │             │
        ┌─────────────▼──┐   ┌──────▼──────────────┐
        │  Database        │   │  Google Calendar API │
        │  (Supabase)       │   │  → Burner Calendar    │
        │  - inbox items    │   │  (system of record   │
        │  - task metadata  │   │   for all events)     │
        │  - screenshot      │   └──────────────────────┘
        │    files (storage) │
        └────────────────────┘
                      ▲
                      │
              ┌───────┴────────┐
              │  Claude API      │
              │  (vision parse   │
              │   + NL chat)     │
              └──────────────────┘
```

**Why Vercel + Supabase specifically:** Vercel's free tier hosts your serverless functions and the public booking pages (what you already planned). Supabase's free tier gives you a real Postgres database *and* file storage in one place — which matters because the screenshot clipper needs somewhere to hold the actual image before/while it's parsed. Using one pair of free services instead of three separate ones keeps you from re-solving "where does this live" for every new feature.

---

## 2. Core Data Model: burner calendar events (corrected design)

**Correction from the original plan:** Google Calendar API's `extendedProperties` silently truncates any value over 1024 characters — no error, just quiet corruption of whatever JSON was in there. The original idea of storing subtasks in one JSON blob under `extendedProperties` was vulnerable to this the moment a task had a few subtasks or a longer note. The design below splits data by "does this need to be queryable" and "how big can this grow," rather than putting everything in one place.

**`extendedProperties.private` holds small, fixed-size, queryable fields** — one flat key per field, values always strings (Calendar API doesn't support other types):

```
schemaVersion: "1"
type: "task" | "habit" | "focusTime" | "meeting" | "fixed" | "buffer"
flexible: "true" | "false"
sourceSystem: "todoist" | "canvas" | "google" | "manual" | "ai-engine"
sourceId: "<external ID, or empty string>"
sourceCalendarId: "<external calendar ID this came from, or empty string>"
sourceLabel: "<human-chosen label for the source calendar, or empty string>"
priority: "critical" | "high" | "medium" | "low"
colorTag: "<hex color, derived from type — never freely chosen>"
deadline: "<ISO datetime \"must be done by\", or empty string>"
```

**Update (sync engine, Phase 1 item 2):** added `sourceCalendarId` to the shape above. The sync engine's dedup pair is `{sourceCalendarId, sourceEventId}` — `sourceEventId` reuses the existing generic `sourceId` field rather than introducing a parallel structure, so `sourceCalendarId` is the one new key needed to complete that pair. Non-synced events (manual/ai-engine-created) just leave it `""`, same as `sourceId` already does for those. See `lib/eventMetadata.ts` for the canonical encode/decode module implementing this shape.

**Update (Phase 2 item 4 follow-up, 2026-07-22):** `priority` was originally a numeric `"1".."5"` scale; changed to `critical`/`high`/`medium`/`low` to match how the user actually thinks about events (e.g. doctors' appointments and classes are `critical`) rather than an arbitrary number. `colorTag` was originally a free-form/optional field; it's now always derived from `type` via `lib/eventMetadata.ts`'s `CATEGORY_COLORS` map, so it's never blank and never needs to be chosen by a caller — this also resolves the "Color-tag scheme" open question below, at least for the app-side metadata tag (whether to *additionally* set Google's own native `colorId` so the event's color shows up inside Google Calendar's own UI is still open, and not needed for anything built so far). `deadline` is new: a "must be done by" constraint that travels with an event but is independent of `proposed_start`/`proposed_end` (where it's actually scheduled) — no logic reads it yet.

**Note vs. block, clarified (2026-07-22):** there's no separate stored "kind" field distinguishing an all-day note (birthdays, first-day-of-school) from a timed block. All-day-ness is already visible from whether an event uses `start.date` (note) or `start.dateTime` (block) — `lib/busyIntervals.ts` already makes exactly this distinction for scheduling purposes (`isAllDay`). `priority` simply isn't meaningful for a note; nothing enforces that today, it's just never read for all-day events.

Keeping these as individual flat keys (rather than one JSON blob) also matters for a second reason: Google's API supports server-side filtering via `privateExtendedProperty=type=task` in an `Events.list` request — but only as an exact match on a whole flat key, never as a query into a nested JSON string. Anything you'll ever want filtered by the API itself has to be a flat key regardless of the truncation issue.

**Anything variable-length or growable lives in Supabase instead** — see the new `event_metadata` table in `docs/schema.md`, keyed by the Google event ID. Subtasks, longer notes, and anything else that could grow past a few hundred characters go here, not in the calendar event.

**One canonical encode/decode module**, not ad-hoc stringifying in each route — `lib/eventMetadata.ts` on the backend defines `encodeEventMetadata()` and `decodeEventMetadata()`, used everywhere an event's metadata is read or written. `schemaVersion` is the field that makes this future-proof: it costs nothing today, but lets a future version of `decodeEventMetadata()` branch on old event versions and handle them correctly, so events written today keep working even after the schema changes later — nothing needs to be migrated retroactively just because the code evolved.

**`description`** stays human-readable notes only — never structured data. Structured data lives in `extendedProperties` or `event_metadata`, never mixed into the text a person actually reads on the event.

---

## 2a. External Calendar Sync Engine — confirmed design

Decision locked in: **sync is one-way only.** External calendars (existing Google accounts, work calendars, etc.) are read-only sources. The burner calendar is where you actually live — it's the primary calendar going forward, not a shadow copy of anything. There is no burner → external sync in either direction; nothing needs to flow back out.

**How the sync loop actually works, concretely:**

- **Incremental sync via `syncToken`, not full re-fetch + diff.** The Google Calendar API supports requesting only what changed since your last sync, rather than pulling the entire event list every cycle and manually comparing it. On first run for a given source calendar, do a normal full fetch and save the `syncToken` Google returns. Every cycle after that, request only the delta. This keeps each poll cheap regardless of how far out your calendar horizon is, and — importantly — **deletions come back automatically** as entries with `status: "cancelled"`, so there's no need to hand-roll "did something disappear" detection.
- **Dedup via source-tagging, not fuzzy matching.** Every event copied from an external calendar into the burner calendar gets `{sourceCalendarId, sourceEventId}` stored in its `extendedProperties`. On each sync, match incoming external events against burner events by that pair — update in place if something changed, skip if unchanged, never create a duplicate.
- **Direction is strictly external → burner for real meetings.** AI-created events (tasks, habits, focus time) only ever exist in the burner calendar — they never originated externally, so there's nothing to sync for them.

**Google auth — implemented approach:** a dedicated Google account (separate from personal/work accounts) owns the burner calendar. A Google Cloud service account was created for this project, and calendars were shared with its email address directly — no OAuth consent flow, no per-user token refresh.

- Burner calendar: shared with the service account at **"Make changes to events"** (read/write)
- Each external source calendar: shared with the service account at **"See all event details"** (read-only)
- Credentials stored as Vercel environment variables: `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_BURNER_CALENDAR_ID`

This works because every calendar involved is one you own — it would not work for calendars owned by other people who haven't explicitly shared them with the service account.

**Correction discovered while building the sync engine (Phase 1 item 2):** source calendars cannot be auto-discovered via `calendarList.list()`. That endpoint only reflects calendars a human has explicitly added to their own Google Calendar UI — sharing a calendar with the service account's email grants ACL access but never populates its `calendarList`, and there is no Google API to enumerate "every calendar this identity has ACL access to" from a cold start. Source calendar IDs are configured explicitly instead, via `GOOGLE_SOURCE_CALENDAR_IDS` — comma-separated `label:calendarId` pairs (e.g. `Kids:nu4bm...@group.calendar.google.com`), where the label is a user-chosen tag written onto every event synced from that calendar (`sourceLabel` in `extendedProperties.private`) so its origin stays visible without a live Google lookup. Adding a new source calendar means adding an entry to that env var, not a data-only change.

**Second correction found during the same build:** the Calendar API enforces a much tighter burst quota on writes (`events.insert`/`update`/`delete`) than on reads — bulk-inserting a large personal calendar's first backfill page with even a few concurrent requests reliably triggers `403 Rate Limit Exceeded`. Google's documented fix is retry with exponential backoff, not just lower concurrency (`lib/calendarSync.ts`'s `withRetry`, capped at 5 attempts). Each write batch also fails safely: a batch is processed with `Promise.allSettled`-style error collection (not a fail-fast `Promise.all`), so any writes that succeeded before a sibling task's retries are exhausted still get flushed to `synced_events` rather than becoming untracked orphans.

**Why the client apps (Mac/iOS) never see any of this:** this credential — along with the Claude API key — lives exclusively in the backend's environment variables, never in the Xcode project. Two reasons: (1) the app never needs to call Google or Claude directly, only the backend; (2) even if it did, a compiled client app is a binary that can be inspected/decompiled, making it a genuinely poor place to store real secrets, unlike a server you control. The app's only credential is the shared `APP_SECRET_KEY`, which authenticates it to the backend and nothing else — lower-stakes if ever leaked, and trivially rotatable.

---

## 3. The Normal Loop, step by step

This is the recurring cycle that keeps everything in sync. Triggered on a schedule (Vercel Cron, e.g. every 10–15 minutes) *and* on demand (you open the app and hit refresh, or a webhook fires).

1. **Pull burner calendar state** — backend calls Google Calendar API, fetches all events in the relevant window (e.g. next 2 weeks), including each event's `extendedProperties` metadata.
2. **Pull universal inbox state** — backend queries Supabase for any inbox items not yet triaged (status = `new` or `parsed`, not yet `scheduled`).
3. **Merge into one working state** — backend now has: fixed events (can't move), flexible/smart events (can move), and untriaged inbox items (not on the calendar yet at all).
4. **Engine evaluates:**
   - Are there conflicts between fixed and flexible events? → resolve by moving the flexible ones.
   - Are there untriaged inbox items that look schedulable (have enough info to become a task)? → propose a slot for each.
   - Are focus-time/habit goals under-served this week? → propose blocks to catch up.
5. **Engine produces a list of proposed changes** — not written yet. Each proposed change is: create X / move Y from A to B / flag Z as needing more info from you.
6. **Proposed changes sync to the app** — Mac/iPhone display them as a review queue (the human-in-the-loop step from your original notes).
7. **You approve, edit, or reject** each proposed change in the app.
8. **Approved changes get written back** — backend calls Google Calendar API to create/update/delete the actual events on the burner calendar, setting `extendedProperties` accordingly.
9. **Loop repeats** — next cycle picks up the new calendar state as the new baseline.

```
 [Google Cal] ──pull──▶ [Backend: merge state] ◀──pull── [Inbox DB]
                                │
                          engine evaluates
                                │
                     [proposed changes list]
                                │
                          sync to app
                                │
                      you approve / reject
                                │
                        write approved
                                │
                                ▼
                          [Google Cal]  (updated)
```

---

## 4. Universal Inbox — v1 (screenshot clipper)

Scoped down to exactly what you described: screenshot in, parsed text out, ready to work with. Everything else (web clipper, Gmail as capture sources) slots into this same pipeline later — they'd just be additional ways to create a row in the same inbox table, so building v1 correctly means the rest is additive, not a rebuild.

**Correction (section 4a, 2026-07-22):** the line above originally listed Todoist and Canvas as future inbox-table sources too — that's now superseded. Both are already-structured task sources (clear title, real due date), unlike a screenshot that needs Claude to even figure out what it is. They get their own path, described in 4a, rather than going through inbox triage.

**Flow:**

1. **Capture** — on iPhone, this is a share-sheet action ("share this screenshot to [App]"); on Mac, a hotkey or drag-onto-menu-bar-icon. Either way, the app uploads the raw image.
2. **Upload** — image goes to Supabase Storage (not straight to Claude — you want a copy retained, both so parsing can be retried and so you have an audit trail of "what did I actually capture").
3. **Create inbox row** — backend inserts a row: `{id, image_url, status: "uploaded", created_at}`.
4. **Parse** — backend calls the Claude API (vision-capable request) with the image, asking it to extract: is this a task/event/note, what's the title, any date/time mentioned, any other relevant detail. This is the one place in the whole system that must be an AI call — there's no clean algorithmic way to read arbitrary screenshot content.
5. **Store result** — response gets saved back onto that same inbox row: `{status: "parsed", extracted_title, extracted_date, extracted_notes, raw_text}`.
6. **Surface for triage** — the app shows this parsed item in your inbox/review list. You either:
   - Accept it as-is → it becomes a task/event candidate, which the engine picks up on the next Normal Loop cycle (step 4 above).
   - Edit it (wrong date, wrong title) → corrected version saved, same next step.
   - Discard it → row marked `status: "discarded"`, ignored going forward.

**Why a database row and not "a file":** you need to query "give me all untriaged items" every loop cycle, update status as items move through the pipeline, and eventually search/filter by date or type. A flat file makes every one of those harder for no benefit — the database you're already running for the scheduler covers this for free.

---

## 4a. Todoist Task Sync (implemented 2026-07-22)

**Why this doesn't reuse the Universal Inbox pipeline (section 4):** the inbox is for *ambiguous* captures — a screenshot needs Claude just to figure out whether it's a task, a note, or an event. A Todoist task already has a clear title and a real due date; running it through vision-parsing triage would be solving a problem it doesn't have. It gets its own path instead.

**Why this is more hands-on than the calendar sync (section 2a):** the calendar sync is fully passive — external calendars mirror into the burner calendar with zero judgment calls, because "what this event is" is already fully known (it's someone's real meeting). A Todoist task's title and due date are similarly just facts to copy over, but *priority* and *tags* aren't things Todoist can tell us — they reflect how you want to organize your own work, not something the source system defines. So this pipeline deliberately stops and waits for you at that one point, rather than guessing.

**New data model — a `tasks` table, distinct from both calendar events and the Universal Inbox.** This is the "database of tasks" side of the model discussed directly with you: calendar events and tasks are separate things, and a calendar block *can* optionally point back at the task that produced it, but plenty of blocks (meetings, habits) never have one.

```
tasks
  id
  title                -- direct from Todoist's task content
  description
  deadline              -- timestamptz, direct from Todoist's due date — not proposed_start/end, this task has no time slot yet
  priority               -- critical | high | medium | low (lib/eventMetadata.ts's EventPriority — reused, not a new scale). Set by you at review time, never imported from Todoist's own priority levels
  tags                   -- text[], same normalizeTags() treatment as inbox_items. Set by you at review time
  source_system          -- 'todoist' | 'canvas' | 'manual'
  source_id               -- the source system's own task id
  status                  -- 'unscheduled' | 'scheduled' | 'completed' | 'discarded'
  scheduled_event_id     -- burner calendar event id, once something (Phase 3 item 7) gives it an actual time slot
```

**Dedup mapping, mirroring `synced_events`/`calendar_sync_state` from section 2a — same pattern, not reinvented:**

```
synced_tasks
  source_system, source_id     -- primary key pair
  proposed_change_id            -- the create-proposal made for this task, while still unresolved
  task_id                        -- the resulting tasks row, once approved
  source_updated_at              -- the source system's own last-modified timestamp, for change detection
```

**Flow:**

1. Fetch active tasks from Todoist's REST API (`TODOIST_API_TOKEN` — a personal access token, no OAuth flow needed, much simpler than the Google service-account setup). A full list each run, not an incremental sync token — a personal task list is small enough that diffing the full list against `synced_tasks` is simpler and cheap, unlike the calendar sync's larger event volumes where `syncToken` genuinely earned its complexity.
2. For each Todoist task with no `synced_tasks` row yet, propose it — same "never write directly" principle as everywhere else, just a new source feeding the same review queue built in Phase 2 item 4.
3. **This introduces a new, valid shape of `create` proposal.** Every `create` proposal today represents "put this on the calendar at this specific time," requiring `proposed_start`/`proposed_end`. A freshly-pulled Todoist task doesn't have a time yet — only a deadline. So: a `create` proposal with `category: 'task'` and **no** `proposed_start`/`proposed_end` means "add this to the task list," not "put this on the calendar." `proposed_summary` = the task's title, `deadline` = its due date, `source_system: 'todoist'`, `source_id` = its Todoist id. `priority` and `tags` are deliberately left unset by the sync itself — this is the "more active" part: you set them when you review the proposal, since nothing upstream can fill them in correctly.
4. **`proposed_changes` needs a new `tags` column** (`text[]`, same `normalizeTags()` treatment as `inbox_items`) so a value set at review time has somewhere to live and can travel through to the resulting `tasks` row. It doesn't exist on this table today.
5. **Applying this shape of proposal writes to `tasks`, not the calendar.** `applyProposedChange`'s `create` branch always calls `calendar.events.insert()` today; it needs a second path — when `proposed_start`/`proposed_end` are both absent, insert into `tasks` instead (title/description/deadline/priority/tags from the proposal), leave `target_event_id` null (nothing was written to Google), and record the resulting `tasks.id` back onto `synced_tasks`.
6. **Giving a task an actual calendar slot is a separate, later step** — Phase 3 item 7 (AI Tasks, not yet built) is what reads `tasks` rows with `status: 'unscheduled'` and proposes a *normal* `create` (this time *with* `proposed_start`/`proposed_end`, `source_system: 'ai-engine'`, `source_id` pointing at the `tasks` row) through the exact same review queue. This is the "engine takes all tasks and gives them a calendar block" end goal already discussed with you — additive on top of what's described here, not a different mechanism.
7. **Completion/deletion in Todoist:** if the task hasn't been scheduled yet (still `unscheduled` in `tasks`, or its create-proposal is still `pending`), the sync can just withdraw it directly — nothing user-visible has happened yet, so there's nothing to confirm. If it's already become a real calendar event (`scheduled_event_id` set), completing/deleting it in Todoist instead proposes a `delete` through the review queue — removing something you already committed to seeing on your calendar still deserves a tap, same principle as everywhere else in this project.

**Auto-apply still applies unchanged** — `AUTO_APPLY_CATEGORIES` isn't special-cased for this. But since an auto-applied task-intake proposal lands with no `priority`/`tags` set (nothing reviewed it), leave `task` out of that whitelist if you want to guarantee you always get a chance to triage before it's real.

**Deliberately out of scope for this design:** propagating an edit made in Todoist *after* a task has already been imported (e.g. you reword it in Todoist once it's already sitting in `tasks`). `synced_tasks.source_updated_at` captures enough to detect that this happened, but deciding *what to do about it* — silently update, or re-propose for review — isn't resolved here. Flagged rather than guessed at.

**New route:** `POST /api/todoist/sync`, same on-demand-only shape as `POST /api/calendar/sync` — nothing in this backend runs on a schedule yet.

**Implementation notes (2026-07-22):**
- `proposed_changes` gained the `tags` column this design called for, plus a relaxed `create` validation rule: `proposed_start`/`proposed_end` may both be omitted, but only when `category` is `'task'` — that's the task-list-intake shape. `applyProposedChange` branches on their presence to decide "write to `tasks`" vs. "write to the calendar."
- **The "set priority/tags at review time" step needed a new endpoint that didn't exist yet:** nothing previously let you edit a still-`pending` proposal's fields before approving it. Added `PATCH /api/proposed-changes/{id}` (`lib/proposedChanges.ts`'s `updateProposedChangeFields`) — accepts `priority` and/or `tags`, only on a `pending`/`failed` row. This is the mechanism for the "you set them when you review the proposal" line above.
- **Added `GET /api/tasks`** (optional `status` filter) — not called for explicitly above, but without it there was no way to see what actually landed in the `tasks` table after approving an intake proposal. Mirrors `GET /api/inbox`/`GET /api/proposed-changes`'s shape.
- **Withdrawing an unscheduled task** (step 7's "the sync can just withdraw it directly") is implemented as: mark the still-`pending`/`failed` intake proposal `rejected` (decided_by `'auto-apply-policy'`, since there's no separate "withdrawn" status in the 4-state machine) and delete its `synced_tasks` row. If it was already rejected by you, it's left alone rather than re-proposed on the next sync.
- **`synced_tasks.source_updated_at`** is populated from Todoist's `created_at` field as a placeholder — the REST API v2 exposes no true last-modified timestamp, and this field isn't acted on yet anyway (see the "deliberately out of scope" note above).
- **Closing the loop on task-backed calendar deletes:** when an approved/auto-applied `delete` proposal's `target_event_id` matches a `tasks.scheduled_event_id`, `applyProposedChange` marks that `tasks` row `completed` as a side effect (best-effort — a failure here doesn't turn an already-succeeded calendar delete into a `failed` proposal). Not explicitly speced above, but without it a task-backed event's deletion would leave `tasks.status` permanently stuck at `'scheduled'`.

---

## 4b. AI Focus Time (implemented 2026-07-23)

Phase 3 item 9 (`backend-build-order.md`) — weekly deep-work goal tracking, auto-defend for existing blocks, and a computed Deep Work Index stat. Chosen over two smaller alternatives (template-window placement; a defend-and-report-only slice with no auto-creation) in favor of the fullest version: a weekly minutes goal that the engine actively fills.

**Weekly-goal auto-fill:** `FOCUS_TIME_WEEKLY_GOAL_MINUTES` (required — a personal target, deliberately no default) is compared each run against this week's `focusTime` time already on the burner calendar plus this engine's own still-`pending`/`failed` `create` proposals for the week (so a re-run before you've approved the last batch doesn't double-propose the same slice of week). If short, new blocks are proposed into `findFreeSlots` openings for the rest of the week — sized to `FOCUS_TIME_BLOCK_MINUTES` (default 90) or whatever's left of the goal, whichever is smaller, and skipped below a 30-minute floor so it never proposes a sliver. Same "never write directly" principle as everywhere else: these are `proposed_changes` `create` rows (`category: 'focusTime'`, `source_system: 'ai-engine'`), reviewed like anything else.

**"Week" is Monday 00:00–Sunday 24:00 in `HOME_TIMEZONE`** (Luxon's `startOf('week')`), independent of `WORKING_DAYS` — the goal covers your whole week, even though new blocks still only ever land inside working hours (same as every other proposal `findFreeSlots` produces).

**Auto-defend is priority, not a new mechanism:** every auto-filled block gets `priority: 'high'` (not the default `medium`) and stays `flexible: 'true'`. This reuses item 5's existing auto-reschedule conflict resolution unchanged — a `high`-priority flexible focus block outranks `medium`-priority flexible events, so *they* get moved on conflict instead of the focus block, without a special case anywhere. It can still lose to a `critical` fixed event, which is the right behavior — an unmovable appointment shouldn't get blocked by a focus session.

**Deep Work Index** (`GET /api/focus-time/stats`) is `completedMinutes / goalMinutes` as a percentage — `completedMinutes` only counts this week's `focusTime` blocks that have already ended (a stat about deep work actually done, not merely booked). `scheduledMinutes` (booked but still in the future) and `pendingProposalMinutes` (proposed, not yet approved) are reported alongside it for the fuller picture, uncapped so overshooting a goal is visible rather than clamped at 100.

**New routes:** `POST /api/focus-time/plan` (the auto-fill run, on-demand only — nothing in this backend runs on a schedule yet), `GET /api/focus-time/stats` (read-only). Implemented via `lib/focusTime.ts`; no schema changes needed — `proposed_changes` already supported `category: 'focusTime'` and `source_system: 'ai-engine'`.

---

## 5. Calendly-style Scheduler (Vercel, free hosting)

This is the piece your notes correctly identified needs its own public web presence — a stranger booking time with you can't go through your native app.

**Flow:**

1. **Availability check** — when someone opens your booking page, a Vercel serverless function calls the Google Calendar API directly (same burner calendar, same credentials the rest of the backend uses) to compute your real free/busy slots, respecting buffers and working hours the same way the main engine does. (Reuse the slot-finding algorithm here — don't write it twice.)
2. **Display slots** — booking page renders available times.
3. **They book** — serverless function writes a new **fixed** event directly to the burner calendar via the Google Calendar API, tagged in `extendedProperties` as `type: meeting`, `flexible: false`.
4. **Feeds back into the Normal Loop automatically** — you don't need any special-case handling for this. The next Normal Loop cycle sees a new fixed event on the calendar, same as if it came from any other invite, and reshuffles flexible blocks around it exactly as it would for a manually-created meeting.

This is the payoff of the "everything writes to one calendar, one engine reads it" design: the booking page doesn't need to know anything about tasks, habits, or focus time — it just adds a fixed event, and the engine's normal conflict-resolution logic does the rest.

---

## 6. Storage decisions — summary

| What | Where | Why |
|---|---|---|
| Calendar events (tasks, habits, meetings, focus time) | Burner Google Calendar, `extendedProperties` for metadata | Single system of record; native to the platform you're already syncing with |
| Universal Inbox items (screenshots + parsed text) | Supabase Postgres (metadata) + Supabase Storage (images) | Needs to be queryable and cross-device; free tier covers both data types in one service |
| Growable event data (subtasks, notes) | Supabase Postgres, `event_metadata` table keyed by Google event ID | `extendedProperties` truncates at 1024 characters — anything that can grow past that doesn't belong on the calendar event itself |
| Tasks (Todoist/Canvas — already-structured work items) | Supabase Postgres, `tasks` + `synced_tasks` tables (section 4a) | Distinct from the Universal Inbox, which is for *ambiguous* captures needing parsing — a Todoist task already has a clear title and due date, so it skips inbox triage entirely |
| Scheduling engine logic | Vercel serverless functions | Needs to run even when devices are offline/asleep; triggered by cron + on-demand |
| Booking pages | Vercel (public routes) | Needs to be reachable by people without your app |
| Google service account credentials | Vercel environment variables (encrypted) — `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_BURNER_CALENDAR_ID`, `GOOGLE_SOURCE_CALENDAR_IDS` | Backend-only; app calendars are shared with the service account, so no per-user OAuth flow is needed (see section 2a) |
| App-to-backend shared secret | `APP_SECRET_KEY` in Vercel env vars; matching value in the Xcode project's gitignored `Secrets.swift` | Sent as an `x-api-key` header on every request; the only credential the client apps hold |

## 7a. App-to-backend authentication (implemented)

Every backend route except `/api/health` checks for a shared secret via an `isAuthorized()` helper (`lib/auth.ts`), comparing the `x-api-key` request header against `process.env.APP_SECRET_KEY`. The Xcode app stores the matching value in a gitignored `Secrets.swift` file and attaches it to every request `APIClient` makes. This is deliberately simple (a single static shared secret, not per-user OAuth) — appropriate for a single-user personal project; would need revisiting if this were ever multi-user.
| AI parsing (screenshot → text) | Claude API, called from backend | Backend-only so your API key never touches the client apps |

---

## 7. Open questions before you start building

- **Sync cadence** — is a 10–15 min cron loop tight enough, or do you want Google Calendar push notifications (webhooks) for near-real-time updates when something changes? (Push is more responsive but more setup; cron is simpler and probably fine for a personal tool.)
- ~~**Approval UX**~~ — resolved (Phase 2 item 4): `AUTO_APPLY_CATEGORIES` env var whitelists categories to auto-apply immediately; everything else sits `pending` for a tap.
- **Inbox triage UI** — does the parsed screenshot text get a dedicated review screen, or does it just appear inline wherever proposed calendar changes show up?
- ~~**Color-tag scheme**~~ — resolved for the app-side metadata tag: `colorTag` is always derived from `type` via a fixed hex-color map (`lib/eventMetadata.ts`'s `CATEGORY_COLORS`), never freely chosen. Still open: whether to *also* set Google's native `colorId` so the color shows up inside Google Calendar's own UI, not just the app's — not needed for anything built so far.
- **Auth for your own apps talking to the backend** — even for a personal project, the Mac/iPhone apps need some way to authenticate to your Vercel backend (simple API key/token is enough at this scale — no need for full OAuth infrastructure between your own components).
