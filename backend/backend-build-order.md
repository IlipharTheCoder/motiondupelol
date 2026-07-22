# Backend Build Order

A sequence for what to hand Claude (VS Code) next, phase by phase. Ordering logic, in short: **prove the connection → build the one shared primitive everything else reuses → put the safety pattern (human-in-the-loop) in place before anything auto-writes → layer features on top → chat/AI layer last, since it's a thin wrapper around everything below it.**

Each item below references its number from `ai-calendar-manager-spec.md`'s section 12 table, so you can cross-check the algorithmic/API/AI classification while building.

---

## ✅ Already done

- Backend scaffolded, deployed on Vercel, connected to Supabase
- `GET /api/health` (unauthenticated, confirms server is alive)
- `GET /api/inbox` (authenticated, reads `inbox_items` from Supabase)
- App-to-backend auth (`isAuthorized`, shared `x-api-key`)
- Google Cloud service account created; burner calendar (read/write) and external calendars (read-only) shared with it
- `POST /api/capture` written (screenshot → Claude vision → inbox row) — **deprioritized, sitting ready, not blocking anything below**
- Xcode thin client: initial `APIClient` wiring against `/api/health` and `/api/inbox`

---

## Phase 1 — Prove the calendar connection

The immediate next step — everything after this depends on it actually working.

1. ✅ **Done.** **`GET /api/calendar/events`** — list events from the burner calendar using the service account credentials. No scheduling logic yet, just proves the auth chain works end to end (table #19). Implemented via `lib/googleCalendar.ts` (shared JWT client, full `calendar` scope) + `app/api/calendar/events/route.ts`; verified locally against the real burner calendar.
2. ✅ **Done.** **External → burner sync engine** — using `syncToken` for incremental updates and `extendedProperties` source-ID tagging for dedup, per the design already locked into `architecture-plan.md` section 2a (table #19, #20). Implemented via `lib/calendarSync.ts` + `lib/eventMetadata.ts` + `POST /api/calendar/sync`, backed by two new Supabase tables (`calendar_sync_state`, `synced_events`) for resumable, efficient dedup. Source calendars are configured via `GOOGLE_SOURCE_CALENDAR_IDS` (`calendarList.list()` doesn't work for service accounts — see `architecture-plan.md` section 2a), each tagged with a `sourceLabel`; first backfill per calendar capped 1 year out; Google writes retry with backoff to survive the Calendar API's write burst quota. Verified end-to-end against 5 real calendars — full backfill, idempotent re-run (steady-state incremental, zero changes), and correct `sourceLabel` tagging all confirmed.
   - **Bug found & fixed (2026-07-22):** a batched end-of-page `synced_events` flush meant a mid-page function kill could lose already-successful Google writes, causing the next sync to recreate the same events as duplicates — 121 orphaned duplicates were produced this way in one source calendar. Fixed by flushing each event's `synced_events` row immediately after its own Google write succeeds. A maintenance endpoint, `POST /api/calendar/sync/dedupe`, was added to clean up existing duplicates (and any future ones) — see `backend-api-reference.md`. Verified: cleanup ran to zero duplicates, and a subsequent sync produced `created: 0` across all calendars.

## Phase 2 — The shared primitive + the safety pattern

Build these before any feature that writes to the calendar — everything in Phase 3 is "apply this primitive with different constraints," and nothing should auto-write without the review queue existing first.

3. ✅ **Done.** **Free-slot finding / conflict detection** (table #1, #2) — the one piece of logic that tasks, habits, focus time, buffer insertion, and the booking page will all reuse. Worth over-investing in correctness here specifically. Implemented as a clean pure/IO split: `lib/intervals.ts` (pure interval math — merge/subtract/pad/filter, unit-tested), `lib/workingHours.ts` (DST-correct working-window generation via `luxon`, unit-tested including real spring-forward/fall-back transitions), `lib/busyIntervals.ts` (Google fetch + per-event-timezone normalization, unit-tested), `lib/freeSlots.ts` (`findFreeSlots`/`detectConflicts` orchestration), `lib/schedulingConfig.ts` (`HOME_TIMEZONE`/`WORKING_HOURS_START`/`WORKING_HOURS_END`/`WORKING_DAYS` env vars, defaults `America/New_York` 10:00–18:00 Mon–Fri). Exposed via `GET /api/calendar/free-slots` and `GET /api/calendar/conflicts` for verification against the real burner calendar. 47 unit tests (`npm test`), every non-cancelled burner event counts as busy regardless of `flexible` tag — deciding what to do about conflicts is explicitly deferred to item 5.
4. ✅ **Done.** **Proposed-changes / review queue** — a data model (separate from calendar events) plus approve/reject endpoints. This is the human-in-the-loop mechanism from the spec's AI Assistant section — every scheduling feature from here on proposes into this queue rather than writing directly. Implemented via a new `proposed_changes` Supabase table + `lib/proposedChanges.ts` + `GET/POST /api/proposed-changes` + `POST /api/proposed-changes/{id}/approve|reject`. Per-`change_type` field validation (`create`/`move`/`update`/`delete`); a 4-state status machine (`pending → applied | rejected | failed`, no separate "approved" state since applying happens synchronously); an `AUTO_APPLY_CATEGORIES` whitelist env var (empty/unset = nothing auto-applies, per your explicit choice to build this now rather than defer it) that applies a proposal immediately at creation time instead of waiting for approval; a conflict recheck via `detectConflicts` (item 3's primitive) on every `create`/`move` apply, failing safe with a descriptive error rather than double-booking. Verified end-to-end against the real burner calendar: manual approve, auto-apply (both success and a real-conflict failure), reject, retry-from-failed, and 409s on already-decided rows.
   - **Data-model alignment + additions (2026-07-22):** clarified the real model with the user — a `tasks` database (not yet built, Phase 3) and calendar events are separate; a block *can* optionally tie back to a task but doesn't have to; synced external events are always non-flexible (already true). Changed `priority` from a numeric `1-5` scale to `critical`/`high`/`medium`/`low` (matches how the user actually thinks about events — doctors' appointments/classes are `critical`); `colorTag` is now always derived from `category` (`lib/eventMetadata.ts`'s `CATEGORY_COLORS`) rather than freely settable, so it's never blank; added a `deadline` field (a "must be done by" constraint, independent of where a block is actually scheduled — no logic reads it yet, that's Phase 3 item 7); `GET /api/calendar/events` now surfaces `category`/`priority`/`deadline`/`colorTag`/`origin` per event; every create/approve/reject response now includes a plain-language `message` alongside `status`. "All-day note vs. block" isn't a separately stored type — it's inferred from Google's own all-day-vs-timed event shape, same as `lib/busyIntervals.ts` already does for scheduling.
5. ✅ **Done.** **Auto-reschedule on conflict** (table #3) — mechanical once #3 and #4 exist: detect overlap, propose a move, wait for approval. Implemented via `lib/autoReschedule.ts` (`findAndProposeReschedules`) + `POST /api/calendar/reschedule`. Pairwise conflict scan over a time window using `intervalsOverlap` (item 3); movability comes from an event's own `flexible` metadata, not `category` — if both sides of a conflict are flexible, the lower-priority one moves (`critical` > `high` > `medium` > `low`, the priority scale from item 4's rework), tie-broken deterministically by `eventId`; unresolvable (both non-flexible) conflicts are reported, not forced. Replacement slot is the first opening `findFreeSlots` returns of at least the event's own duration; proposes via the normal `createProposedChange` (item 4) so `AUTO_APPLY_CATEGORIES` still applies immediately where whitelisted. Deduplicates against existing `pending`/`failed` `move` proposals for the same event so repeated runs don't pile up duplicate proposals. On-demand only — no cron wiring yet. Verified end-to-end against the real burner calendar with seeded conflicts: flexible-vs-fixed (flexible moves, fixed untouched), flexible-vs-flexible at different priorities (lower priority moves), and re-running confirmed as a no-op (both skipped as already-pending) — this closes out Phase 2.

Also done alongside this: `GET /api/calendar/events` gained `from`/`to`/`maxResults`/`pageToken`/`q` query params (previously fixed at "upcoming, 50 max, no search") — response shape changed from a bare array to `{ events, nextPageToken }` to support pagination. See `backend-api-reference.md`.

## Phase 3 — Feature layers, built on the primitive

Each of these is meaningfully smaller than it looks, because #3 above already did the hard part.

6. **Todoist task sync** (table #21) — external data has to exist before there's anything to schedule. New/changed items land in the review queue from Phase 2 (item 4) for approval before entering the task list — see `docs/architecture-plan.md` section 4a.
7. **AI Tasks** — auto-placement into free slots, deadline-aware backward planning, session-splitting for large tasks, basic "what should I work on next" as a priority-score sort (table #4, #5, #7, #18).
8. **AI Habits** — best-time placement, reflow on conflict (table #6).
9. **AI Focus Time** — weekly goal tracking, auto-defend blocks, Deep Work Index as a computed stat (table #8, #9).
10. **Buffer Time** — breaks, travel, prep/follow-up padding (table #11).
11. **AI Planner** — the orchestration layer that assembles tasks + habits + focus time + buffers into one coherent daily view; mostly gluing the above together, not new logic (table #12).

## Phase 4 — Secondary data sources & utilities

Lower urgency — nothing else depends on these.

12. **Canvas sync** (table #22) — same review-queue gating as Todoist, item 6
13. **Labels** (table #14)
14. **Bulk actions** (table #15)
15. **Weekly time-spend reports** (table #13)
16. **Follow-up reminder notifications** (table #17)

## Phase 5 — Chat / NL layer

Deliberately last — this is a thin conversational wrapper around everything above, so it's cheap to add once the underlying actions already exist and expensive/wasteful to build first with nothing real for it to trigger.

17. **Chat box NL query understanding + conversational responses** (table #26, #27)
18. **Reprioritize/reschedule via chat, create habits conversationally** (table #28, #29) — trigger via Claude, execution via the Phase 2/3 logic already built

## Phase 6 — Deferred / lower priority

Explicitly parked, not forgotten:

- **AI Scheduling Links** (Calendly-style booking pages) — reuses the Phase 2 slot-finder, but is public-facing and has its own hosting/security surface; do it once the core engine is trustworthy, not before
- **Quick Capture screenshot parsing** — already built (`/api/capture`), just not wired into anything downstream yet
- **Quick Capture from other sources** — web clipper still open; **Gmail no longer needs the Gmail API** — use inbound email forwarding (Postmark/Mailgun/Cloudflare Email Routing → webhook → `/api/capture`'s existing pipeline) instead. No OAuth, no polling, no Gmail credentials at all — see `docs/architecture-plan.md` section 4a.
- **Two-way sync back to Todoist/Canvas** — optional per the spec's own notes; only build if you find yourself wanting task-completion status to flow back
- **MCP server / Claude app exposure** — nice-to-have reachability, not core functionality
- **"Scheduling policies"** — still flagged from the original spec as likely cuttable for a solo build

---
