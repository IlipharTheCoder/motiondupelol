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
2. **External → burner sync engine** — using `syncToken` for incremental updates and `extendedProperties` source-ID tagging for dedup, per the design already locked into `architecture-plan.md` section 2a (table #19, #20).

## Phase 2 — The shared primitive + the safety pattern

Build these before any feature that writes to the calendar — everything in Phase 3 is "apply this primitive with different constraints," and nothing should auto-write without the review queue existing first.

3. **Free-slot finding / conflict detection** (table #1, #2) — the one piece of logic that tasks, habits, focus time, buffer insertion, and the booking page will all reuse. Worth over-investing in correctness here specifically.
4. **Proposed-changes / review queue** — a data model (separate from calendar events) plus approve/reject endpoints. This is the human-in-the-loop mechanism from the spec's AI Assistant section — every scheduling feature from here on proposes into this queue rather than writing directly.
5. **Auto-reschedule on conflict** (table #3) — mechanical once #3 and #4 exist: detect overlap, propose a move, wait for approval.

## Phase 3 — Feature layers, built on the primitive

Each of these is meaningfully smaller than it looks, because #3 above already did the hard part.

6. **Todoist task sync** (table #21) — external data has to exist before there's anything to schedule.
7. **AI Tasks** — auto-placement into free slots, deadline-aware backward planning, session-splitting for large tasks, basic "what should I work on next" as a priority-score sort (table #4, #5, #7, #18).
8. **AI Habits** — best-time placement, reflow on conflict (table #6).
9. **AI Focus Time** — weekly goal tracking, auto-defend blocks, Deep Work Index as a computed stat (table #8, #9).
10. **Buffer Time** — breaks, travel, prep/follow-up padding (table #11).
11. **AI Planner** — the orchestration layer that assembles tasks + habits + focus time + buffers into one coherent daily view; mostly gluing the above together, not new logic (table #12).

## Phase 4 — Secondary data sources & utilities

Lower urgency — nothing else depends on these.

12. **Canvas sync** (table #22)
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
- **Quick Capture from other sources** (web clipper, Gmail) — additional inbox intake methods, not core to scheduling
- **Two-way sync back to Todoist/Canvas** — optional per the spec's own notes; only build if you find yourself wanting task-completion status to flow back
- **MCP server / Claude app exposure** — nice-to-have reachability, not core functionality
- **"Scheduling policies"** — still flagged from the original spec as likely cuttable for a solo build

---

## What to hand Claude right now

Phase 1, item 2 — the external → burner sync engine. Item 1 (calendar connection test) is done; this is the next thing everything else depends on.
