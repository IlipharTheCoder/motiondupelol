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
type: "task" | "habit" | "focusTime" | "meeting" | "fixed" | "buffer" | "personal"
flexible: "true" | "false"
sourceSystem: "todoist" | "canvas" | "google" | "manual" | "ai-engine"
sourceId: "<external ID, or empty string>"
sourceCalendarId: "<external calendar ID this came from, or empty string>"
sourceLabel: "<human-chosen label for the source calendar, or empty string>"
priority: "critical" | "high" | "medium" | "low"
colorTag: "<hex color, derived from type — never freely chosen>"
deadline: "<ISO datetime \"must be done by\", or empty string>"
tags: "<comma-joined normalized tags, or empty string>"
```

**Update (sync engine, Phase 1 item 2):** added `sourceCalendarId` to the shape above. The sync engine's dedup pair is `{sourceCalendarId, sourceEventId}` — `sourceEventId` reuses the existing generic `sourceId` field rather than introducing a parallel structure, so `sourceCalendarId` is the one new key needed to complete that pair. Non-synced events (manual/ai-engine-created) just leave it `""`, same as `sourceId` already does for those. See `lib/eventMetadata.ts` for the canonical encode/decode module implementing this shape.

**Update (Phase 2 item 4 follow-up, 2026-07-22):** `priority` was originally a numeric `"1".."5"` scale; changed to `critical`/`high`/`medium`/`low` to match how the user actually thinks about events (e.g. doctors' appointments and classes are `critical`) rather than an arbitrary number. `colorTag` was originally a free-form/optional field; it's now always derived from `type` via `lib/eventMetadata.ts`'s `CATEGORY_COLORS` map, so it's never blank and never needs to be chosen by a caller — this also resolves the "Color-tag scheme" open question below, at least for the app-side metadata tag (whether to *additionally* set Google's own native `colorId` so the event's color shows up inside Google Calendar's own UI is still open, and not needed for anything built so far). `deadline` is new: a "must be done by" constraint that travels with an event but is independent of `proposed_start`/`proposed_end` (where it's actually scheduled) — no logic reads it yet.

**Note vs. block, clarified (2026-07-22):** there's no separate stored "kind" field distinguishing an all-day note (birthdays, first-day-of-school) from a timed block. All-day-ness is already visible from whether an event uses `start.date` (note) or `start.dateTime` (block). `priority` simply isn't meaningful for a note; nothing enforces that today, it's just never read for all-day events.

**Event tags added (2026-07-24, Phase 4 items 13/14, "Labels" + "Bulk actions"), built together as prep for item 25's Option B recurring events.** `tags` joins the flat key list above rather than getting its own multi-key encoding, since `extendedProperties.private` allows no arrays — `lib/eventMetadata.ts`'s `encodeEventTags`/`decodeEventTags` comma-join/split a normalized tag array (commas within an individual tag are stripped, not escaped — same "flat string, good-enough" tradeoff already accepted for every other field here). `ProposedChangeInput.tags` already existed and was already validated/normalized, but was previously only ever consumed for the task-list-intake `create` shape (writing into `tasks.tags`) — never threaded into an actual calendar event's own metadata. `applyProposedChange`'s `create`/`update` branches (`lib/proposedChanges.ts`) now do, and `GET /api/calendar/events` now decodes and returns `tags` per event.

The driver: of the two shapes considered for item 25 (native Google `recurrence`/RRULE vs. synthesizing N individual `create` proposals, "Option B"), Option B's weakness was having no way to treat "all N instances of one recurring series" as a single editable unit without a bespoke tracking table. Tags plus bulk-edit solve that generically instead — a future recurring series would tag every instance with a shared `series:<uuid>`, and "edit/cancel the whole series" becomes an ordinary bulk-edit-by-tag call. Item 25 itself is still not built; this just doesn't preclude that path.

**`POST /api/calendar/bulk-edit`** (`lib/bulkEdit.ts`) finds events by tag within a date range — reusing `lib/autoReschedule.ts`'s `fetchSchedulableEvents` (now decoding `tags` too) rather than a new fetch loop, same "fetch a range, decode metadata, filter in application code" pattern every engine here already uses (confirmed nothing in this codebase uses Calendar API's `privateExtendedProperty` query filtering, and this doesn't start). Fans out into one ordinary `update`/`delete`/`move` `proposed_changes` row per match — never bypasses the review queue, mirrors `lib/habitPlacement.ts`'s per-item try/catch summary shape (one match's failure doesn't abort the batch). A bulk `move` is a uniform `time_delta_minutes` applied to each match's own existing start/end (a single absolute target time makes no sense across multiple different-time matches). **Confirmed with the user:** a bulk `update`'s tag changes are additive/subtractive (`tags_add`/`tags_remove`), never a full replace — the underlying single-event `update` proposal primitive stays replace-if-provided (matches how `priority`/`deadline` already behave there), but bulk-edit computes the merged per-match array itself before calling it, so a bulk retag can never silently strip an unrelated tag like a series' own linking tag.

**All-day events excluded from scheduling entirely (2026-07-24):** `lib/busyIntervals.ts`'s `normalizeEventToInterval` now returns `null` for any all-day event rather than an interval spanning its full date range — notes shouldn't be able to block a free-slot search or register as a conflict. This is the shared source every busy/conflict computation in the backend funnels through (`findFreeSlots`, `detectConflicts`, `autoReschedule`, `habitPlacement`, `focusTime`, `bufferTime`), so the fix applies everywhere at once. Caught live: a real multi-day synced event ("Second year student orientation") was blocking conflict-checking across its entire date range before this changed.

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

**On-demand "find me focus time" (added 2026-07-23):** a second, distinct entry point for the "I need focus time today/tomorrow/this week, when works?" ask — `POST /api/focus-time/suggest` (`lib/focusTime.ts`'s `suggestFocusTimeOptions`). Unlike the weekly auto-fill, this doesn't compute or care about any goal shortfall — it just answers "where does a block of this length fit in this window," and puts every candidate straight into `proposed_changes` as its own `pending` row for you to approve/reject (same review-queue principle as everywhere else).
- **Range is always explicit `from`/`to` timestamps** — same shape as `GET /api/calendar/free-slots` and `POST /api/calendar/reschedule`, not a `today`/`tomorrow`/`week` shorthand (dropped after building it — simpler and more consistent to let the caller compute the bounds once, the same way every other range-taking endpoint here already works, rather than this one route knowing "today" means). A thin client's "Today"/"Tomorrow"/"This Week" buttons just compute the matching `from`/`to` locally before calling.
- **One candidate per distinct free opening**, not repeated slices of the same opening — if today has one long free afternoon, that's one option, not three arbitrary subdivisions of it. Across a week-long range you'd typically see genuinely different days/times instead.
- Each candidate gets the same auto-defend treatment as the goal-driven blocks (`priority: 'high'`, `flexible: 'true'`) — a focus block is a focus block regardless of how it was proposed.
- Dedupes against this endpoint's own still-pending proposals in the same window (so calling it twice before you've decided doesn't offer the same slot again) the same way the auto-fill dedupes against itself.
- **Known gap, not solved here:** since each option is an independent `proposed_changes` row, approving one doesn't auto-reject the others — you have to reject the unwanted alternatives yourself, or they sit `pending` and could later be approved by mistake. A "these are mutually exclusive, approving one cancels its siblings" mechanism would need a new grouping concept on `proposed_changes`; not built, since it's not needed unless this turns out to be annoying in practice.

---

## 4c. Buffer Time (implemented 2026-07-23)

Phase 3 item 10 (`backend-build-order.md`) — breaks, travel, and prep/follow-up padding around events, built as real materialized `proposed_changes` blocks (not invisible scheduling padding), differentiated by what triggers them rather than one flat rule applied to everything.

**Two independent trigger mechanisms**, each with its own env var (`BUFFER_TRAVEL_MINUTES`, `BUFFER_PREP_MINUTES`, `BUFFER_FOLLOWUP_MINUTES`, each optional and `0`/off by default — unlike Focus Time's weekly goal, a buffer kind you don't want is a legitimate "unset," not a missing personal target):
- **Travel buffer** — any event with a non-empty Google `location`, *regardless of category*. An errand-type task with an address still needs travel time even though it isn't a "meeting." Proposed both before ("Travel to X") and after ("Travel from X") using the same minutes value both directions.
- **Prep/follow-up buffer** — specifically `category: 'meeting'` events. "Prep for X" before, "Follow-up: X" after. A phone call tagged `meeting` still gets this even without a location; an in-person meeting gets both this and travel buffer, independently.

**Chained placement, not independent placement:** when a trigger qualifies for more than one buffer kind, they're placed contiguously — `[prep][travel][MEETING][travel][follow-up]` — with travel always immediately adjacent to the trigger (you have to actually be traveling right up until you arrive) and prep/follow-up further out.

**Dedup and conflict-checking at plan time, not just apply time:** every buffer candidate is tagged `source_id: <trigger's Google event ID>` so a later run can recognize "this trigger already has a travel-before buffer" (by checking both already-materialized `buffer`-category calendar events *and* still-`pending`/`failed` buffer proposals for overlap against the same `source_id`) and skip re-proposing it. Each remaining candidate is also conflict-checked against the live calendar (`detectConflicts`) before proposing — a buffer squeezed into a slot that's since been taken is skipped and counted, not blindly proposed to fail later at approval time.

**`flexible: 'false'`, `priority: 'low'`** — the opposite stance from Focus Time's auto-defend. A buffer block only means something in its exact adjacent position relative to its trigger; letting auto-reschedule float it elsewhere on conflict would defeat its purpose, so it's marked non-flexible rather than merely low-priority-and-movable. If something else conflicts with a buffer block, the *other* (flexible) side moves instead — `priority: 'low'` is mostly for display/consistency at that point, since a non-flexible event's own priority is never consulted by the mover-selection logic.

**Known limitation, not solved here:** if a trigger event gets rescheduled after its buffers were already created, the old buffer blocks don't follow it — they become orphaned at the old time, and a fresh plan run just proposes new ones adjacent to the new time. Cleaning up orphaned buffers isn't automated (same category of "deliberately out of scope" as the Todoist sync's post-import-edit handling in section 4a).

**New route:** `POST /api/buffer-time/plan?from=...&to=...` (explicit timestamps only, no shorthand — same convention `POST /api/focus-time/suggest` settled on). Implemented via `lib/bufferTime.ts`; no schema changes needed.

---

## 4d. AI Tasks — Part 1: giving a task a calendar block (implemented 2026-07-23)

Phase 3 item 7 (`backend-build-order.md`), split into two parts per the user: this is Part 1 — the underlying "attach a task to calendar time" primitive. Part 2 (automatic placement/sorting) builds on top of it and isn't built yet.

Two distinct modes, both operating on an `unscheduled` `tasks` row (409 if the task isn't):

1. **Link to an existing event** (e.g. an existing Focus Time block) — pure bookkeeping, not a scheduling decision: it doesn't create, move, or delete any calendar time, just tags an already-real event with "this is for task X" and marks the task `scheduled`. **Flagged and asked rather than guessed** (per this project's own "don't guess at ambiguous architecture decisions" rule): does this need review-queue approval like every other calendar write, or can it apply directly since nothing about *when* anything happens changes? Resolved as **actor-dependent** — a new required `actor: 'user' | 'ai-engine'` param on the endpoint:
   - `actor: 'user'` (you, manually) — applies immediately: patches the existing event's `extendedProperties` (`sourceSystem: 'ai-engine'`, `sourceId: <task id>`, everything else preserved) and updates the `tasks` row (`status: 'scheduled'`, `scheduled_event_id`) in the same request. No `proposed_changes` row at all.
   - `actor: 'ai-engine'` (something automated — this is what Part 2 will call) — goes through the normal review queue: a `change_type: 'update'` proposal targeting the existing event, only applied (and only then updating the `tasks` row) once approved.
2. **Create a brand-new event for the task** — this *does* create real calendar time, so it always goes through `proposed_changes` as a `create`, regardless of actor — no special case, consistent with every other create in this backend. `category: 'task'`, `source_system: 'ai-engine'`, `source_id: <task id>`, `proposed_summary`/`deadline`/`priority` carried over from the task row.

**This required two small extensions to the `update` change_type, which had validation and an apply path but no real caller until now:**
- `validateProposalInput` now also accepts a bare `source_id` (with no other field) as satisfying "update needs something to change" — that's the task-link shape.
- `applyProposedChange`'s `update` branch previously always let the *existing* event's metadata win for `sourceSystem`/`sourceId` (`existingMeta.sourceSystem ?? row.source_system`) — correct for an ordinary field-only update, but wrong for a task-link, which needs the *new* value to win. Resolved by making `source_id`'s presence on the proposal the signal: if set, the new `source_system`/`source_id` overwrite; if absent (every other kind of update), the old behavior (existing metadata wins) is unchanged. Nothing else creates `update` proposals yet, so this didn't have to reconcile with another caller's expectations.

**Closing the loop back onto `tasks`:** both the `create` and `update` apply paths now check for a UUID-shaped `source_id` on `category: 'task'` (create) or a task-link (`update`) and, on success, set that `tasks` row to `status: 'scheduled'` / `scheduled_event_id`. Guarded by an actual UUID-format check (`isUuid`, `lib/proposedChanges.ts`) rather than just "is `source_id` set," since `source_id` means something different on the Todoist intake `create` shape (section 4a — an external Todoist id, not a `tasks.id`).

**New route:** `POST /api/tasks/{id}/schedule` — body is either `{ actor, event_id }` (link) or `{ proposed_start, proposed_end }` (create new); exactly one shape, `400` otherwise. Implemented via `lib/aiTasks.ts`; no schema changes needed.

---

## 4e. AI Tasks — Part 2: automatic placement/sorting (implemented 2026-07-23)

Phase 3 item 7's other half: auto-placement into free slots, deadline-aware backward planning, and a priority-score "what should I work on next" sort. Session-splitting for tasks too large for any single opening is **explicitly deferred as a future Part 3** (see below) — this pass only builds compositions of primitives that already existed.

**The duration gap.** Research before building this turned up a real gap: nothing anywhere (not `tasks`, not `proposed_changes`, not Todoist's own sync) recorded how long a task takes — impossible to auto-place or ever split a task without it. Added `duration_minutes` to both tables (see `backend-schema.md`). Left `null` in storage when genuinely unknown rather than backfilled with a default at intake time — `TASK_DEFAULT_DURATION_MINUTES` (optional, defaults to `30`) is resolved only at planning time (`lib/aiTasks.ts`'s `resolveTaskDurationMinutes`), so changing the env var later doesn't require a migration. `lib/todoistSync.ts` now captures Todoist's own optional `duration` field when present; either way, `duration_minutes` is settable via `PATCH /api/proposed-changes/{id}` at review time, same as `priority`/`tags`.

**Priority-score ranking ("what should I work on next").** A lexicographic comparator (`lib/aiTasks.ts`'s `compareTasksByPriorityScore`): priority tier first (reusing `PRIORITY_RANK`, relocated from `lib/autoReschedule.ts` to `lib/eventMetadata.ts` as the shared source of truth), deadline urgency (hours until deadline, overdue clamped to 0, no-deadline treated as `Infinity`) as a same-tier tiebreak, task id as the final deterministic tiebreak. **Confirmed directly with the user: priority tier always wins** — an overdue `low` task never jumps ahead of a `high` task with no deadline; deadline urgency only decides ties within a tier. A deadline-driven reprioritization method that would let urgency override tier is a distinct, explicitly-deferred future item (`backend-build-order.md`), not built here. `GET /api/tasks/next?limit=N` surfaces this ranking read-only, separate from `GET /api/tasks`'s raw listing.

**Auto-placement + backward planning (`lib/taskPlacement.ts`'s `planTaskPlacement`).** Fetches all `unscheduled` tasks, sorts by the priority-score above, and for each (in that order) finds a slot and calls Part 1's `scheduleTaskToNewEvent` — so this only ever decides *where*, never writes to the calendar itself. Confirmed as the simplest correct realization of "backward planning": `findFreeSlots` already returns every fitting opening in a range, ascending — for a task whose deadline falls inside the search window, taking the **last** opening and anchoring the task to its *end* (rather than the first opening's start) **is** backward planning, no separate backward-search algorithm needed. Tasks with no deadline, an already-past deadline, or a deadline beyond the horizon get ASAP forward placement instead. Dedupes against this engine's own still-pending proposals (skip a task that already has one; treat their time as claimed) and additionally tracks every proposal *this run* creates as claimed too, so a lower-ranked task in the same run can't be placed on top of a higher-ranked one it just lost out to. Per-task failures are caught and recorded as a `skipped-error` result rather than aborting the whole batch.

**New route:** `POST /api/tasks/plan?from=...&to=...`, mirroring `POST /api/calendar/reschedule`'s exact shape (both optional, default `now`/`+14 days`).

**Session-splitting — explicitly deferred as Part 3.** A task too big for any single opening anywhere in the search window (not just "no room left after this run's own higher-priority picks," which gets its own distinct message) is skipped with a reason ending "— session-splitting not yet supported," rather than a generic failure — matching this project's established "known limitation, not solved here" pattern (Buffer Time's orphaned-buffer note, Todoist sync's post-import-edit note). Building this properly needs a real data-model change (`tasks.scheduled_event_id` is a single event id; splitting means a task maps to multiple calendar blocks, needing something like a new `task_sessions` table and a new meaning for `status: 'scheduled'`) — deliberately not forced into this pass. `tasks.scheduled_event_id` stays singular so Part 3 doesn't have to unwind anything this pass did.

---

## 4f. AI Habits (implemented 2026-07-23)

Phase 3 item 8 — set recurring occurrence-count goals ("gym 3x/week," "read 1x/month") and, as long as they fit, the engine places them into free time. Chosen deliberately as **occurrence-count based, not duration-based** (unlike Focus Time's total-minutes weekly goal) — confirmed directly with the user.

**New `habits` table** (`backend-schema.md`) — the recurring template/goal: `cadence` (`'weekly'`/`'monthly'`), `target_count`, `occurrence_duration_minutes` (always required — habits are user-declared, never synced from a source that might omit it), `priority` (nullable, resolved to a `'low'` default only at use-time), `tags`, `status` (`'active'`/`'paused'`). **No occurrence-log table** — satisfaction is counted by scanning burner calendar events tagged `type:'habit'` + matching `sourceId`, plus still-pending/failed proposals, generalizing `lib/focusTime.ts`'s existing counting pattern (count of events here, rather than summed minutes). **Habit declarations are direct-insert CRUD, not routed through `proposed_changes`** — a habit is a goal, not a calendar write (closer to `inbox_items`'s direct-POST pattern than to `tasks`'s Todoist-intake-via-proposal pattern, which specifically needed a review step for trusting external data); only the occurrence *placements* below go through the queue.

**Weekly and monthly cadence share one mechanism.** `getCurrentWeekRange` (previously living in `lib/focusTime.ts`, used only there) was relocated to a new `lib/periodRanges.ts` alongside a new `getCurrentMonthRange`, both exposed through `getCurrentPeriodRange(cadence, config, now)` — same relocation reasoning as `PRIORITY_RANK`'s earlier move into `lib/eventMetadata.ts` once a second consumer needed it. `lib/focusTime.ts` re-exports `getCurrentWeekRange` so nothing importing it from there breaks.

**Urgency ranking (`lib/habits.ts`), confirmed formula:** `hoursLeftInPeriod / occurrencesStillNeeded` — a habit needing 3 more sessions with 2 days left ranks more urgent than one needing 1 more with 2 days left, not just "however soon the period ends" (a plain hours-until-period-end count, the more obvious port of `lib/aiTasks.ts`'s `taskDeadlineUrgencyHours`, was considered and rejected for exactly this reason). `compareHabitsByUrgency` is lexicographic — priority tier always wins (same `PRIORITY_RANK`, same deliberate choice as Tasks: a future method letting urgency override tier is a distinct, still-unbuilt item), then this urgency formula breaks ties within a tier, then habit id as the final deterministic tiebreak. This ranking only decides processing order *within one `POST /api/habits/plan` run* — it is not a cross-feature scheduler arbitrating Habits against Tasks or Focus Time for the same calendar time; that full orchestration is Phase 3 item 11 ("AI Planner"), a distinct, later, not-yet-scoped item.

**The one genuinely new algorithm this feature needed: spacing.** Neither Focus Time's greedy weekly fill nor Tasks' single-slot backward planning solves "place N separate occurrences of the same goal without clustering them together" (3 gym sessions crammed into 3 consecutive days isn't a habit, it's a coincidence). New pure module `lib/habitSpacing.ts` (unit-tested alongside `intervals.test.ts`'s style):
- `splitIntoSegments(rangeStart, rangeEnd, count)` — divides the remaining period into `count` equal-length segments; degenerates correctly to one segment spanning the whole range when `count === 1` (plain forward-fill), no special-casing needed.
- `findOccurrenceSlot(fitting, segStart, segEnd, durationMs)` — **confirmed:** earliest fitting opening inside `[segStart, segEnd)` (first-fit, not last-fit — there's no true per-occurrence deadline that would justify anchoring late, unlike a task's real deadline). If the segment itself has no room, falls back to the earliest fit anywhere from `segStart` through the end of the search range — **never before `segStart`**: letting an occurrence backfill into an earlier segment's leftover slack would work against the spacing goal (it's supposed to land after the previous occurrence, not next to it).

`lib/habitPlacement.ts`'s `planHabitPlacement(now?)` — no `from`/`to` params, mirroring `planFocusTime`'s "always the current period" shape, here per-habit via each one's own cadence: computes every active habit's period context (occurrences satisfied/remaining) in one pass, seeds a run-wide `claimedIntervals` from **every active habit's** pending proposals (not just due ones — an already-satisfied habit's still-unapproved occurrence still occupies real time a different habit's new proposal must not collide with), then processes habits with `occurrencesRemaining > 0` in urgency order, running the segment-and-fill mechanism per habit and proposing via `createProposedChange`. Each occurrence is `flexible: 'true'`, `priority` resolved via `resolveHabitPriority` (default `'low'`) — the deliberate opposite of Focus Time's auto-defend stance: habits are meant to yield to everything else, not protect their slot. Per-habit failures are caught and recorded as `skipped-error`, same defensive pattern as `planTaskPlacement`.

**New routes:** `POST /api/habits` + `GET /api/habits` (CRUD), `PATCH /api/habits/{id}` (edits, including `status` as the pause mechanism), `POST /api/habits/plan` (the placement engine, no params, `maxDuration = 60`).

**Deferred, not solved here:** per-habit preferred time-of-day windows (e.g. "only evenings"); a `GET /api/habits/next`-style read-only urgency view (natural, cheap follow-up, not asked for); the cross-feature AI Planner (item 11); letting urgency override priority tier (same explicitly-deferred idea as section 4e's task ranking).

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
