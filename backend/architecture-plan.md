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

Scoped down to exactly what you described: screenshot in, parsed text out, ready to work with. Everything else (web clipper, Gmail, Todoist, Canvas as capture sources) slots into this same pipeline later — they'd just be additional ways to create a row in the same inbox table, so building v1 correctly means the rest is additive, not a rebuild.

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
