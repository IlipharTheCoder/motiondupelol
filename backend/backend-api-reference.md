# API Reference — current endpoints

Keep this updated as new routes are added. Purpose: so building a new endpoint doesn't require re-reading every existing route file to learn the pattern — read this instead.

---

## `GET /api/health`

**Auth:** none (intentionally public — used to confirm the server is alive)

**Response:**
```json
{ "status": "ok" }
```

---

## `GET /api/inbox`

**Auth:** required — `x-api-key` header must match `APP_SECRET_KEY`

**Response:** array of rows from `inbox_items` (see `backend-schema.md`)
```json
[
  {
    "id": "uuid",
    "title": "string",
    "description": "string",
    "tags": ["string"],
    "image_url": "string",
    "status": "smallint — 0=new, 1=parsed, 2=scheduled, 3=discarded (see lib/inboxStatus.ts)",
    "priority": "critical | high | medium | low | null — null until set via PATCH",
    "created_at": "timestamptz"
  }
]
```

**Errors:** `401` if unauthorized, `500` with `{ "error": message }` on a Supabase failure

---

## `POST /api/inbox`

**Auth:** required — same as above

**Request:** `application/json`
```json
{
  "title": "string (required)",
  "description": "string (optional)",
  "tags": ["string (optional)"]
}
```
Tags are normalized (trimmed, lowercased, deduped) before insert via `normalizeTags()` (`lib/normalizeTags.ts`).

**What it does:** inserts a plain-text `inbox_items` row directly — no screenshot, no Claude parsing. `image_url` is always `null`, `status` is always `InboxStatus.NEW` (`0`). Meant for quick manual capture (typed notes/tasks), as opposed to `/api/capture`'s screenshot pipeline. Rows created here are indistinguishable from any other `inbox_items` row once inserted — same row shape, picked up by `GET /api/inbox` and any future triage/scheduling flow the same way.

**Response:** the newly inserted row (array, per Supabase's `.select()` behavior), same shape as `GET /api/inbox`

**Errors:** `401` unauthorized, `400` if `title` is missing/empty, `500` if the insert fails

---

## `PATCH /api/inbox/{id}`

**Auth:** required — same as above

**Request:** `application/json`, every field optional — only the ones present get updated:
```json
{
  "title": "string (non-empty if provided)",
  "description": "string | null",
  "tags": ["string (optional)"],
  "status": "0-3, see lib/inboxStatus.ts",
  "priority": "critical | high | medium | low | null"
}
```
`tags` are freely user-defined (any string), normalized the same way as `POST /api/inbox` — trimmed, lowercased, deduped via `normalizeTags()`. `priority` reuses the same `critical`/`high`/`medium`/`low` scale used everywhere else in the system (`lib/eventMetadata.ts`'s `EVENT_PRIORITIES`); pass `null` to clear it. `image_url` and `created_at` aren't editable through this route.

**What it does:** partial-updates one `inbox_items` row. At least one field must be present in the body.

**Response:** the updated row, same shape as `GET /api/inbox`

**Errors:** `401` unauthorized, `400` if the body has no valid fields, an empty `title`, an invalid `status`, or an invalid `priority`, `404` if no row matches `id`, `500` on a Supabase failure

---

## `POST /api/capture`

**Auth:** required — same as above

**Request:** `multipart/form-data`, field name `image`, containing an image file

**What it does:** uploads the image to the `screenshots` Supabase Storage bucket, sends it to Claude (`claude-haiku-4-5`) for extraction, inserts a new `inbox_items` row with the result

**Response:** the newly inserted row (array, per Supabase's `.select()` behavior), same shape as `/api/inbox`

**Errors:** `401` unauthorized, `400` if no image provided, `500` if upload fails, Claude call fails, JSON parsing fails, or the insert fails — each returns `{ "error": message }`

**Status:** `app/api/capture/` doesn't exist in the codebase at all (confirmed 2026-07-24 — not even an empty stub file, the whole route directory is absent) — despite this doc and `backend-build-order.md`'s "Already done"/Phase 6 sections previously claiming it was written. Deprioritized per `backend-build-order.md` Phase 6; the description above is the intended behavior if/when it gets built, not current reality. Don't include this as a callable tool for the NL layer.

---

## `GET /api/calendar/events`

**Auth:** required — `x-api-key` header must match `APP_SECRET_KEY`

**What it does:** lists events from the burner calendar (`GOOGLE_BURNER_CALENDAR_ID`) via the Google Calendar API, authenticated as the service account (`lib/googleCalendar.ts`).

**Query params (all optional — omitting all of them reproduces the original fixed behavior: upcoming events from now, 50 max):**
- `from`/`to` (ISO datetimes) — override the default `timeMin: now` and add a `timeMax`. `400` if either fails to parse, or if `to` isn't later than `from`.
- `maxResults` (positive integer, default `50`, capped at Google's own ceiling of `2500`) — `400` if not a positive integer or over the cap.
- `pageToken` (opaque string from a previous response's `nextPageToken`) — continue a previous listing.
- `q` (string) — passed straight through to Google's own full-text search across `summary`/`description`/`location`/attendee fields. This is substring/fuzzy matching, not a strict exact-match filter — "look up an event by name" works, but isn't guaranteed to match *only* that event.

**Response:** `{ events: [...], nextPageToken: string | null }`. Each event is mapped down from Google's raw event object; `category`/`priority`/`deadline`/`colorTag`/`origin` are decoded from `extendedProperties.private` (`lib/eventMetadata.ts`) — `null` for any event that predates a given field (e.g. events synced before `deadline` existed) or that didn't originate from this system at all.
```json
{
  "events": [
    {
      "id": "string",
      "summary": "string",
      "description": "string | null",
      "location": "string | null",
      "start": { "dateTime": "string", "timeZone": "string" },
      "end": { "dateTime": "string", "timeZone": "string" },
      "status": "string",
      "htmlLink": "string",
      "category": "task | habit | focusTime | meeting | fixed | buffer | personal | null",
      "priority": "critical | high | medium | low | null",
      "deadline": "timestamptz | null",
      "colorTag": "string (hex color, derived from category) | null",
      "tags": "string[] — always an array, [] when none (added 2026-07-24, item 13)",
      "origin": {
        "sourceSystem": "todoist | canvas | google | manual | ai-engine | null",
        "sourceLabel": "string | null"
      }
    }
  ],
  "nextPageToken": "string | null"
}
```
There's no separate stored "all-day note vs. block" type — an all-day event (`start.date` instead of `start.dateTime`) is just an event whose `priority` isn't meaningful; whether it's all-day is already visible from `start`/`end`'s shape. All-day events still show up here (this endpoint lists raw calendar events, unfiltered) but never count as busy time for any scheduling primitive — see `GET /api/calendar/free-slots`/`GET /api/calendar/conflicts`.

**Errors:** `401` if unauthorized, `400` on any invalid query param (see above), `500` with `{ "error": message }` if the Google Calendar API call fails (bad credentials, calendar not shared, etc.)

---

## `POST /api/calendar/sync`

**Auth:** required — `x-api-key` header must match `APP_SECRET_KEY`

**Request:** no body

**What it does:** mirrors every calendar listed in `GOOGLE_SOURCE_CALENDAR_IDS` (comma-separated `label:calendarId` pairs, e.g. `Kids:abc...@group.calendar.google.com` — `calendarList.list()` can't be used here, since sharing a calendar with a service account never populates its `calendarList`, only its ACL permissions) into the burner calendar. Every synced event is tagged with `sourceLabel` (the configured label) and `sourceCalendarId` in its `extendedProperties.private`, so its origin calendar is always identifiable. Synced events are always `flexible: 'false'` and default to `priority: 'critical'` — they're external commitments (appointments, classes, meetings) that shouldn't move and rarely need to. One-way sync only (external → burner) — see `architecture-plan.md` section 2a. First run per calendar does a full backfill capped at 1 year out; subsequent runs use Google's `syncToken` for incremental deltas. Dedup and no-op-skip are driven by the `synced_events` and `calendar_sync_state` tables (see `backend-schema.md`) — safe to call repeatedly, including mid-backfill. Google write calls (`insert`/`update`/`delete`) retry with exponential backoff on rate-limit/transient errors, since bulk-writing a large first backfill reliably trips the Calendar API's write burst quota.

Bounded to ~50s of work per call (Vercel `maxDuration: 60`). If a backfill is large, a single call may not finish — check the response for `truncatedByTimeBudget: true` or any calendar with `status: "in_progress"` and call the endpoint again with no params; it resumes entirely from Supabase state.

**Response:**
```json
{
  "startedAt": "timestamptz",
  "finishedAt": "timestamptz",
  "durationMs": 47213,
  "truncatedByTimeBudget": true,
  "calendars": [
    {
      "calendarId": "string",
      "calendarSummary": "string",
      "mode": "backfill | incremental",
      "status": "complete | in_progress | error",
      "created": 0,
      "updated": 0,
      "deleted": 0,
      "skipped": 0,
      "pagesProcessed": 0,
      "errorMessage": "string | null"
    }
  ]
}
```

**Errors:** `401` if unauthorized, `500` with `{ "error": message }` only for a run-level failure (e.g. calendar discovery itself couldn't reach Google). A single calendar failing mid-sync does **not** fail the request — it's reported as `status: "error"` with `errorMessage` set on that calendar's entry, response is still `200`.

**Note:** each event's `synced_events` mapping is now written immediately after its own Google write succeeds, not batched and flushed once at the end of a page — a batched flush meant a mid-page function kill (Vercel `maxDuration`, or a burst of write-rate-limit retries) could lose every successful write that came before the kill, causing the same page to be recreated as duplicates on the next run. See `POST /api/calendar/sync/dedupe` below for cleaning up any duplicates this already produced.

---

## `POST /api/calendar/sync/dedupe`

**Auth:** required — `x-api-key` header must match `APP_SECRET_KEY`

**Request:** no body

**What it does:** maintenance endpoint — scans every event on the burner calendar, groups them by the `(sourceCalendarId, sourceId)` pair already tagged in `extendedProperties.private` (untagged/manual events are never touched), and for any group with more than one event, keeps the copy `synced_events` currently points at (or the most-recently-updated copy if the mapping is missing/stale, repointing `synced_events` to it) and deletes the rest. Safe to call repeatedly — a clean calendar returns `groupsWithDuplicates: 0, eventsDeleted: 0`. Deletes go through the same `withRetry`/concurrency-limited machinery as `POST /api/calendar/sync`, since a large cleanup can trip the same Calendar API write rate limit.

**Response:**
```json
{
  "groupsScanned": 52,
  "groupsWithDuplicates": 0,
  "eventsDeleted": 0,
  "errors": ["string"]
}
```

**Errors:** `401` if unauthorized, `500` with `{ "error": message }` on a run-level failure. A single group's cleanup failing does not fail the request — its error is collected into `errors` and other groups still get processed.

---

## `GET /api/calendar/free-slots`

**Auth:** required — `x-api-key` header must match `APP_SECRET_KEY`

**Query params:** `from`, `to` (required, ISO datetimes) · `minDurationMinutes`, `paddingMinutes` (optional, non-negative numbers)

**What it does:** computes open slots on the burner calendar within `[from, to)`, intersected with working hours (`HOME_TIMEZONE`/`WORKING_HOURS_START`/`WORKING_HOURS_END`/`WORKING_DAYS` — see `lib/schedulingConfig.ts`, defaults `America/New_York` 10:00–18:00 Mon–Fri). Every non-cancelled, timed burner event counts as busy regardless of its `flexible` tag — this primitive reports what's free, it doesn't decide what to do about conflicts (see `architecture-plan.md`/`backend-build-order.md` Phase 2). **All-day events never count as busy** (changed 2026-07-24 — see `lib/busyIntervals.ts`'s `normalizeEventToInterval`): they're treated as notes/markers, not scheduled time, so they're excluded before this or any other busy-interval computation ever sees them. `paddingMinutes` expands each busy event by that many minutes on both sides before subtracting (a generic knob, not built-in "buffer time" semantics); `minDurationMinutes` drops any resulting slot shorter than that.

**Response:**
```json
{
  "rangeStart": "timestamptz",
  "rangeEnd": "timestamptz",
  "slots": [
    { "start": "timestamptz", "end": "timestamptz" }
  ]
}
```

**Errors:** `401` unauthorized, `400` if `from`/`to` are missing/invalid/out of order or `minDurationMinutes`/`paddingMinutes` aren't valid non-negative numbers, `500` on a Google API or config failure

---

## `GET /api/calendar/conflicts`

**Auth:** required — same as above

**Query params:** `from`, `to` (required, ISO datetimes) · `excludeEventId` (optional — ignore this event's own current placement, e.g. when checking whether moving it elsewhere would still conflict) · `paddingMinutes` (optional, non-negative number)

**What it does:** checks whether `[from, to)` overlaps any non-cancelled, **timed** burner event. Pure calendar-overlap only — does **not** consult working hours (a candidate outside working hours is a policy question for a later layer, not this primitive's concern). Back-to-back placement (candidate starts exactly when an existing event ends, or vice versa) is **not** a conflict. All-day events can never appear in `conflicts` (changed 2026-07-24 — treated as notes, not scheduled time; `isAllDay` in the response shape below is consequently always `false` now, kept for shape stability rather than meaning anything today).

**Response:**
```json
{
  "hasConflict": true,
  "conflicts": [
    { "eventId": "string", "summary": "string | null", "start": "timestamptz", "end": "timestamptz", "isAllDay": false }
  ]
}
```

**Errors:** `401` unauthorized, `400` if `from`/`to` are missing/invalid/out of order or `paddingMinutes` isn't a valid non-negative number, `500` on a Google API or config failure

---

## `POST /api/calendar/reschedule`

**Auth:** required — `x-api-key` header must match `APP_SECRET_KEY`

**Query params:** `from`/`to` (optional ISO datetimes — default `from: now`, `to: from + 14 days`). `400` if either fails to parse or `to` isn't later than `from`.

**What it does:** scans `[from, to)` for overlapping burner events and proposes a `move` (into `proposed_changes`, via `lib/autoReschedule.ts`) for the flexible side of each conflict it can resolve — it never writes to the calendar directly, same as everything else built on the review queue. Policy, in order:
- Movability comes from an event's own `flexible` metadata, not its `category`. Two non-flexible events conflicting is unresolvable — reported in the summary, no proposal made.
- If both sides of a conflict are flexible, the **lower-priority one moves** (`critical` > `high` > `medium` > `low`); exact ties break on `eventId` comparison — arbitrary but deterministic, so re-running doesn't flip which side moves.
- The replacement slot is the first opening `findFreeSlots` returns (respecting working hours) at least as long as the event's own current duration, searched within the same `[from, to)` window (clamped to not start before now). No proposal is made if nothing fits.
- Won't create a duplicate: if a `pending` or `failed` `move` proposal already targets that event, it's skipped. An event already conflicting with several others in the window still only gets one proposal, listing every conflict in `reason`.
- Goes through the normal `createProposedChange` path, so a whitelisted `AUTO_APPLY_CATEGORIES` category still applies immediately instead of staying `pending`.

**Response:**
```json
{
  "eventsScanned": 0,
  "conflictingPairs": 0,
  "proposalsCreated": 0,
  "skippedAlreadyPending": 0,
  "unresolvedBothFixed": 0,
  "noSlotAvailable": 0,
  "proposals": []
}
```
`proposals` is the array of newly-created `proposed_changes` rows (see `GET /api/proposed-changes`'s response shape) — already-pending duplicates skipped this run aren't included since nothing new happened for them.

**Errors:** `401` unauthorized, `400` on an invalid `from`/`to`, `500` on a Google API or Supabase failure. On-demand only — nothing in this backend runs on a schedule yet (no Vercel Cron wired up), so this has to be called explicitly for now.

---

## `POST /api/calendar/rebalance`

**Auth:** required — same as above

**Query params:**
- `from`/`to` (required, ISO datetimes) — the window whose total busy time should be reduced (e.g. today's bounds — no `today` shorthand, compute the timestamps you want before calling, same convention as every other range-taking endpoint here).
- `maxBusyMinutes` (required, non-negative number) — target ceiling for `[from, to)`'s total scheduled minutes.
- `searchTo` (optional ISO datetime, default `to + 7 days`) — how far forward to look for a new slot for anything moved. `400` if not later than `to`.

**What it does:** Phase 3.5 item 23, "on-demand day-rebalancing" — narrower than the full **AI Planner** (item 11): given a window that's carrying too much, propose moving some lower-priority flexible items elsewhere, rather than reacting to an actual overlap the way `POST /api/calendar/reschedule` does. Implemented via `lib/dayRebalance.ts`'s `rebalanceWorkload`, reusing `lib/autoReschedule.ts`'s `fetchSchedulableEvents` (same flexible/priority metadata read) and its movability rule (`flexible` metadata, not `category`).

- Sums every schedulable event's duration in `[from, to)`. All-day events never contribute (an all-day entry's `start.date`/`end.date` span whole calendar days, not a literal block of scheduled time — summing one in would wildly overstate "workload"; this was originally patched here specifically after being found live, and is now also true upstream at the shared source, `lib/busyIntervals.ts`'s `normalizeEventToInterval` — see item 23's discovery and the broader 2026-07-24 fix in `architecture-plan.md`). If the total is already `<= maxBusyMinutes`, returns immediately with `alreadyUnderTarget: true` and no proposals.
- Otherwise, ranks flexible events lowest-priority-first (`critical` > `high` > `medium` > `low`, so `low` moves first), largest-duration-first within a tier (fewer moves needed to hit the target), `eventId` as a final deterministic tiebreak.
- For each candidate in that order, until enough minutes are accounted for: skips it if a `pending`/`failed` `move` proposal already targets it (same dedup as `reschedule`); otherwise searches for a free slot of at least its own duration, **excluding slots this same run already claimed for an earlier candidate** (two candidates independently landing on the same still-genuinely-free slot, since neither is applied yet, was a real bug caught in live verification before this tracking was added). The search always starts at `to`, never before — moving something to a still-in-`[from, to)` slot wouldn't reduce that window's total at all, so only relocations that actually leave the window count toward the target, regardless of how far `searchTo` extends the outer bound.
- A candidate with no available slot is skipped (not forced) and the next-lowest-priority one is tried — one immovable/no-slot item doesn't block progress on the rest.
- Same review-queue principle as everywhere else: every relocation is a `move` proposal via `createProposedChange`, nothing is written to the calendar directly, and a whitelisted `AUTO_APPLY_CATEGORIES` category still applies immediately.

**Response:**
```json
{
  "rangeStart": "ISO datetime",
  "rangeEnd": "ISO datetime",
  "searchEnd": "ISO datetime",
  "maxBusyMinutes": 0,
  "totalBusyMinutesBefore": 0,
  "totalBusyMinutesAfter": 0,
  "alreadyUnderTarget": false,
  "eventsScanned": 0,
  "candidatesConsidered": 0,
  "proposalsCreated": 0,
  "skippedAlreadyPending": 0,
  "skippedNoSlot": 0,
  "unmetMinutes": 0,
  "proposals": []
}
```
`totalBusyMinutesAfter` is best-effort — it assumes every proposal in this response gets approved; it isn't re-verified after the fact. `unmetMinutes` is how much of the original overage couldn't be resolved this run (ran out of movable candidates, or nothing flexible was left to try) — `0` means the target was fully met by these proposals (once approved).

**Errors:** `401` unauthorized, `400` on a missing/invalid `from`/`to`/`maxBusyMinutes`/`searchTo`, `500` on a Google API or Supabase failure. On-demand only — nothing in this backend runs on a schedule yet.

---

## `POST /api/calendar/bulk-edit`

**Auth:** required — same as above

**Request:** `application/json`:
```json
{
  "tag": "string (required)",
  "from": "ISO datetime (required)",
  "to": "ISO datetime (required)",
  "action": "update | delete | move",

  "proposed_summary": "string (optional, action: update)",
  "proposed_description": "string (optional, action: update)",
  "priority": "critical | high | medium | low (optional, action: update)",
  "deadline": "ISO datetime (optional, action: update)",
  "tags_add": "string[] (optional, action: update) — tags to add to each match",
  "tags_remove": "string[] (optional, action: update) — tags to remove from each match",

  "time_delta_minutes": "number, nonzero (required, action: move) — shift applied to each match's own start/end",

  "reason": "string (optional, human-readable, carried into every resulting proposal)"
}
```
`action: 'update'` requires at least one of `proposed_summary`/`proposed_description`/`priority`/`deadline`/`tags_add`/`tags_remove`. `action: 'move'` requires `time_delta_minutes`. `action: 'delete'` needs nothing else.

**What it does:** Phase 4 items 13/14 ("Labels" + "Bulk actions"), built together as prep for item 25's Option B recurring events — see `architecture-plan.md`. Finds every schedulable (timed, non-cancelled) event in `[from, to)` carrying `tag` (reuses `lib/autoReschedule.ts`'s `fetchSchedulableEvents`, same "fetch the range, decode metadata, filter in code" pattern every engine here already uses — no Calendar API query-param filtering), then creates one ordinary `update`/`delete`/`move` `proposed_changes` row per match — never bypasses the review queue, same `AUTO_APPLY_CATEGORIES` handling as any other proposal. One match's failure (e.g. a `move` that lands on a conflict once applied) doesn't block the rest of the batch.

- **`update`**: `tags_add`/`tags_remove` are additive/subtractive against each match's *own current* tags, never a full replace — a bulk update that doesn't mention a tag never touches it (important for a future recurring series' `series:<uuid>` linking tag surviving an unrelated bulk retag). `proposed_summary`/`proposed_description`/`priority`/`deadline`, when given, apply identically to every match (the single-event `update` proposal's own replace-if-provided behavior).
- **`move`**: `time_delta_minutes` is a uniform offset applied to each match's own existing start/end (duration unchanged) — not a single absolute target time, which wouldn't make sense across multiple different-time matches.
- **`delete`**: proposes deleting every match.

**Response:**
```json
{
  "tag": "string",
  "rangeStart": "ISO datetime",
  "rangeEnd": "ISO datetime",
  "action": "update | delete | move",
  "eventsMatched": 0,
  "proposalsCreated": 0,
  "skippedErrors": 0,
  "results": [
    { "eventId": "string", "summary": "string | null", "outcome": "proposed | skipped-error", "proposal": {}, "reason": "string" }
  ]
}
```
`eventsMatched: 0` (no matching tag found) is a normal, successful response, not an error.

**Errors:** `401` unauthorized, `400` on a missing/invalid `tag`/`from`/`to`/`action`/action-specific field, `500` on a Google API or Supabase failure. On-demand only — nothing in this backend runs on a schedule yet.

---

## `POST /api/calendar/recurring`

**Auth:** required — same as above

**Request:** `application/json`:
```json
{
  "category": "task | habit | focusTime | meeting | fixed | buffer | personal (required)",
  "proposed_summary": "string (required)",
  "proposed_description": "string (optional)",
  "priority": "critical | high | medium | low (optional)",
  "flexible": "true | false (optional)",
  "first_start": "ISO datetime (required) — the first occurrence's start; its weekday and time-of-day anchor every later occurrence",
  "first_end": "ISO datetime (required) — defines the duration applied to every occurrence",
  "interval_weeks": "integer, positive (optional, default 1) — 1 = every week, 2 = every other week",
  "count": "integer, positive, at most 260 — exactly one of count/until is required",
  "until": "ISO datetime — exactly one of count/until is required",
  "tags": "string[] (optional) — merged with the auto-generated series tag, not a replacement for it",
  "bump_if_movable": "boolean (optional, default false) — applied to every occurrence's create proposal, see item 24",
  "reason": "string (optional, carried into every resulting proposal)"
}
```

**What it does:** Phase 5 item 25 ("Recurring events"), Option B — synthesizes N individual `create` proposals (one per occurrence) rather than a native Google `recurrence`/RRULE series, chosen specifically because items 13/14 (event tags + `POST /api/calendar/bulk-edit`) already solve Option B's usual weakness of having no way to treat the whole series as one unit. Every occurrence is tagged with a fresh, unique `series:<uuid>` (plus any `tags` you supply) — **save this tag from the response** to later edit or cancel the whole series via `POST /api/calendar/bulk-edit`.

Each occurrence is an ordinary `create` proposal, going through the exact same review-queue path and per-instance `detectConflicts` check as any other create — a conflict on one occurrence fails only that one proposal, the rest are unaffected. Weekly cadence only (anchored to `first_start`'s own weekday and time-of-day); interval math is DST-safe (stays at the same local time-of-day across a spring-forward/fall-back transition between occurrences).

**No default horizon — `count` or `until` is required, not both, not neither.** This is a deliberate choice: there's no "silently ran out" failure mode to worry about, but also no "recurring forever" in one call — a still-wanted indefinite series just means calling this again later with a new `first_start`. A hard ceiling of 260 occurrences (5 years weekly) applies regardless; if an `until`-bounded request would exceed it, the response comes back `truncated: true` with as many occurrences as fit.

**Response:**
```json
{
  "seriesTag": "series:<uuid>",
  "occurrencesRequested": 0,
  "truncated": false,
  "proposalsCreated": 0,
  "skippedErrors": 0,
  "results": [
    { "index": 1, "start": "ISO datetime", "end": "ISO datetime", "outcome": "proposed | skipped-error", "proposal": {}, "reason": "string" }
  ]
}
```

**Errors:** `401` unauthorized, `400` on a missing/invalid `category`/`proposed_summary`/`first_start`/`first_end`/`interval_weeks`/`count`/`until`/`tags`/`bump_if_movable`, `500` on a Google API or Supabase failure. On-demand only — nothing in this backend runs on a schedule yet.

---

## `POST /api/focus-time/plan`

**Auth:** required — same as above

**Request:** no body

**What it does:** the AI Focus Time weekly-goal auto-fill (`architecture-plan.md` section 4b, `lib/focusTime.ts`). Compares this week's (Monday–Sunday, `HOME_TIMEZONE`) existing `focusTime` calendar time plus this engine's own still-pending/failed `create` proposals against `FOCUS_TIME_WEEKLY_GOAL_MINUTES`; if short, proposes new `focusTime` blocks (`category: 'focusTime'`, `source_system: 'ai-engine'`, `priority: 'high'`, `flexible: 'true'`) into `findFreeSlots` openings for the rest of the week, sized to `FOCUS_TIME_BLOCK_MINUTES` (default 90) or whatever's left of the goal, skipping anything under a 30-minute floor. Same review-queue principle as everywhere else — nothing is written to the calendar directly.

**Response:**
```json
{
  "weekStart": "ISO datetime",
  "weekEnd": "ISO datetime",
  "goalMinutes": 0,
  "alreadyAccountedMinutes": 0,
  "remainingMinutes": 0,
  "proposalsCreated": 0,
  "proposals": [],
  "noRoomLeftInWeek": false
}
```
`proposals` is the array of newly-created `proposed_changes` rows. `noRoomLeftInWeek: true` means the goal isn't met but there's no more qualifying free time left this week (rather than an error).

**Errors:** `401` unauthorized, `500` if `FOCUS_TIME_WEEKLY_GOAL_MINUTES`/`FOCUS_TIME_BLOCK_MINUTES` are unset or invalid, or on a Google API/Supabase failure. On-demand only — nothing in this backend runs on a schedule yet.

---

## `GET /api/focus-time/stats`

**Auth:** required — same as above

**Query params:** none

**What it does:** computes the Deep Work Index for the current week (`architecture-plan.md` section 4b) — read-only, no proposals or writes.

**Response:**
```json
{
  "weekStart": "ISO datetime",
  "weekEnd": "ISO datetime",
  "goalMinutes": 0,
  "completedMinutes": 0,
  "scheduledMinutes": 0,
  "pendingProposalMinutes": 0,
  "deepWorkIndex": 0
}
```
`completedMinutes` only counts `focusTime` blocks that have already ended — actual deep work done this week, not merely booked. `scheduledMinutes` (booked, still upcoming) and `pendingProposalMinutes` (proposed, not yet approved) are broken out separately. `deepWorkIndex` is `completedMinutes / goalMinutes` as a percentage, uncapped (overshooting a goal shows as >100, not clamped).

**Errors:** `401` unauthorized, `500` if `FOCUS_TIME_WEEKLY_GOAL_MINUTES` is unset/invalid, or on a Google API/Supabase failure.

---

## `POST /api/focus-time/suggest`

**Auth:** required — same as above

**Query params:**
- `from`/`to` (required — ISO datetimes; same shape as `GET /api/calendar/free-slots`/`POST /api/calendar/reschedule`, no `today`/`tomorrow`/`week` shorthand — compute the bounds you want before calling)
- `durationMinutes` (optional — defaults to `FOCUS_TIME_BLOCK_MINUTES`, itself defaulting to 90; must be at least 30)
- `maxOptions` (optional — defaults to 3; must be an integer 1–10)

**What it does:** the on-demand "I need focus time today/tomorrow/this week, when works?" ask (`architecture-plan.md` section 4b, `lib/focusTime.ts`'s `suggestFocusTimeOptions`) — distinct from `POST /api/focus-time/plan`'s weekly-goal auto-fill; this doesn't consult or care about the weekly goal at all. Finds free openings of at least `durationMinutes` in the requested window (via `findFreeSlots`, minus this endpoint's own still-pending proposals in that window so a repeat call doesn't offer the same slot twice) and takes one candidate per distinct opening — up to `maxOptions` — rather than slicing one long opening into several near-identical options. Each candidate is inserted into `proposed_changes` immediately as its own `pending` `create` row (`category: 'focusTime'`, `source_system: 'ai-engine'`, `priority: 'high'`, `flexible: 'true'` — same auto-defend treatment as the goal-driven blocks), ready for you to approve one and reject the rest.

**Response:**
```json
{
  "rangeStart": "ISO datetime",
  "rangeEnd": "ISO datetime",
  "durationMinutes": 90,
  "options": []
}
```
`options` is the array of newly-created `proposed_changes` rows (one per candidate) — see `GET /api/proposed-changes`'s response shape. An empty array means no opening in the window fit `durationMinutes`, not an error.

**Note:** approving one option doesn't automatically reject the others — they're independent `proposed_changes` rows, so reject the ones you don't want or they'll sit `pending`.

**Errors:** `401` unauthorized, `400` on a missing/invalid `from`/`to`, `durationMinutes`, or `maxOptions`, `500` on a Google API or Supabase failure

---

## `POST /api/buffer-time/plan`

**Auth:** required — same as above

**Query params:** `from`/`to` (required — ISO datetimes, same shape as every other range-taking endpoint here, no shorthand)

**What it does:** the differentiated Buffer Time build (`architecture-plan.md` section 4c, `lib/bufferTime.ts`). Scans `[from, to)` for two independent trigger conditions: any event with a Google `location` set (any category) gets a travel buffer proposed both before ("Travel to X") and after ("Travel from X"), sized by `BUFFER_TRAVEL_MINUTES`; any `category: 'meeting'` event gets a prep buffer before ("Prep for X", `BUFFER_PREP_MINUTES`) and a follow-up buffer after ("Follow-up: X", `BUFFER_FOLLOWUP_MINUTES`). All three env vars are independently optional and default to `0` (off) — at least one must be non-zero or this is a `400`. When a trigger qualifies for more than one kind, they're chained contiguously (prep, then travel, immediately against the trigger; travel, then follow-up, on the way out).

Each candidate is tagged `source_id` = the trigger event's Google event ID, so re-running skips anything that already has an overlapping `buffer`-category calendar event or pending/failed buffer proposal tagged to that same trigger — no duplicate buffers pile up on repeat calls. Remaining candidates are conflict-checked (`detectConflicts`) before proposing; a slot that's since been taken by something else is skipped, not proposed to fail later. Every proposal is `flexible: 'false'` (a buffer only means something in its exact adjacent position — it shouldn't get auto-rescheduled elsewhere) and `priority: 'low'`.

**Response:**
```json
{
  "rangeStart": "ISO datetime",
  "rangeEnd": "ISO datetime",
  "triggersScanned": 0,
  "proposalsCreated": 0,
  "skippedAlreadyBuffered": 0,
  "skippedConflict": 0,
  "proposals": []
}
```
`proposals` is the array of newly-created `proposed_changes` rows.

**Errors:** `401` unauthorized, `400` on a missing/invalid `from`/`to`, or if all three `BUFFER_*_MINUTES` env vars are `0`/unset, `500` on a Google API or Supabase failure

---

## `GET /api/proposed-changes`

**Auth:** required — same as above

**Query params:** `status` (optional — one of `pending`/`applied`/`rejected`/`failed`; omit to return all rows)

**What it does:** lists rows from `proposed_changes` (see `backend-schema.md`), newest first. This is the human-in-the-loop review queue every scheduling feature writes into instead of touching the calendar directly.

**Response:** array of `proposed_changes` rows (see schema for full shape)

**Errors:** `401` unauthorized, `400` if `status` isn't a valid value, `500` on a Supabase failure

---

## `POST /api/proposed-changes`

**Auth:** required — same as above

**Request:** `application/json`, shape depends on `change_type`:
```json
{
  "change_type": "create | move | update | delete",
  "category": "task | habit | focusTime | meeting | fixed | buffer | personal",
  "flexible": "true | false (optional)",
  "source_system": "todoist | canvas | google | manual | ai-engine",
  "source_id": "string (optional)",
  "target_event_id": "string (required for move/update/delete, must be absent for create)",
  "proposed_start": "ISO datetime (required for create/move)",
  "proposed_end": "ISO datetime (required for create/move)",
  "proposed_summary": "string (required for create)",
  "proposed_description": "string (optional)",
  "priority": "critical | high | medium | low (optional, default medium)",
  "tags": "string[] (optional) — normalized (trimmed/lowercased) same as inbox_items; only meaningful for category: 'task'",
  "duration_minutes": "number, positive (optional) — only meaningful for category: 'task'; see AI Tasks Part 2, architecture-plan.md section 4e",
  "deadline": "ISO datetime (optional) — a \"must be done by\" constraint, independent of proposed_start/proposed_end",
  "reason": "string (optional, human-readable justification)",
  "bump_if_movable": "boolean (optional, default false) — only meaningful for create/move, see below"
}
```
`update` requires `target_event_id` plus at least one of `proposed_start`/`proposed_end`/`proposed_summary`/`proposed_description`/`priority`/`deadline`/`tags`/`source_id` (the last one links a task to this event — see `POST /api/tasks/{id}/schedule`). `tags` was added to this list 2026-07-24 (item 13) — previously accepted but silently meaningless for a real calendar `update` (only ever written for the task-list-intake shape), it now writes onto the event's own metadata too, so a tags-only update is a legitimate "something to change."

**`create` may omit `proposed_start`/`proposed_end` entirely — but only when `category` is `'task'`.** That shape means "add this to the task list" rather than "put this on the calendar" (`architecture-plan.md` section 4a) — `proposed_summary` becomes the task's title, `deadline` its due date, and applying it inserts into the `tasks` table (`backend-schema.md`) instead of calling the Calendar API; `target_event_id` stays `null`. `proposed_start` and `proposed_end` must both be present or both be absent — one without the other is a `400`. Every category other than `'task'` still requires both.

Note there's no `color_tag` input — color is always derived from `category` (`lib/eventMetadata.ts`'s `CATEGORY_COLORS`), never freely chosen, so it's never blank. The response's `color_tag` reflects this even on a still-`pending` row (useful for a review-queue UI to show the right color before approval).

**`category: 'personal'`** (added 2026-07-23, item 22) — freestanding leisure/personal-time blocks (e.g. "budget 2 hours of video games") that don't fit any existing category: `buffer` is semantically tied to a trigger event, and every other category implies a specific engine/purpose. `'personal'` has no dedicated engine — it's created the same plain way `meeting`/`fixed` are, via a direct call to this endpoint with `flexible`/`priority` supplied explicitly (or the blanket `flexible: 'true'`/`priority: 'medium'` default if omitted).

**What it does:** validates the input for its `change_type` (`lib/proposedChanges.ts`'s `validateProposalInput`), inserts a `pending` row, then checks `category` against the `AUTO_APPLY_CATEGORIES` env var (comma-separated `BurnerEventType` list, e.g. `habit,buffer`; empty/unset means nothing auto-applies). If `category` is whitelisted, the change is applied to the calendar immediately in the same request — the response reflects the final `applied`/`failed` state, not `pending`. If you want a chance to set `priority`/`tags` before a Todoist task-intake proposal becomes real, keep `task` out of `AUTO_APPLY_CATEGORIES`.

Applying (whether via auto-apply here or via the `approve` endpoint below) re-checks for conflicts on `create`/`move` using `detectConflicts` (`GET /api/calendar/conflicts`'s underlying function) — a conflict fails the change (`status: "failed"`, descriptive `error_message`) rather than double-booking. `create` builds `extendedProperties.private` via `encodeEventMetadata`; `update` reads the existing event first and merges changed fields into its metadata (Google's `patch` replaces the whole `extendedProperties.private` map rather than merging individual keys, so the full map is always resent) — `color_tag` is re-derived from whichever category ends up written, not preserved from the stale row.

**`bump_if_movable`** (added 2026-07-23, item 24) — on a conflict, instead of just failing, checks whether every conflicting event is `flexible` and *strictly* lower priority than this one (`critical` > `high` > `medium` > `low` — equal priority doesn't bump, matching `lib/autoReschedule.ts`'s mover rule). If so, each occupant gets its own ordinary `move` proposal into a free slot found within the next 14 days — but **this proposal still ends up `failed`**, not applied: the occupant hasn't actually vacated the slot yet, only been proposed to. The `error_message` names the blocking proposal(s) to approve first; once you do, retry this one (the normal `POST /api/proposed-changes/{id}/approve` retry-a-failed-proposal flow — no new mechanism). If even one conflicting event is immovable or equal/higher priority, nothing is bumped — same plain conflict failure as `bump_if_movable: false`. The occupant's move proposal always lands `pending` regardless of `AUTO_APPLY_CATEGORIES` — a bump is never allowed to silently cascade onto the real calendar without you approving it.

**Response:** the created/updated `proposed_changes` row, plus a `message` field — a plain-language summary of `status` (`lib/proposedChanges.ts`'s `describeProposalOutcome`) meant for a thin client to display directly: `"Awaiting approval."` / `"Change applied to the calendar."` / `"Change rejected."` / `` `"Failed to apply: {error_message}"` ``.

**Errors:** `401` unauthorized, `400` on a validation failure, `500` on a Supabase or unexpected failure

---

## `POST /api/proposed-changes/{id}/approve`

**Auth:** required — same as above

**Request:** no body

**What it does:** applies a `pending` or `failed` proposed change to the calendar (see the application logic described above). Retrying a previously `failed` change is just approving it again.

**Response:** the updated row plus `message` (same plain-language summary as `POST /api/proposed-changes`), `status: "applied"` (with `target_event_id` set to the resulting burner event, for `create`) or `status: "failed"` (with `error_message` set)

**Errors:** `401` unauthorized, `404` if no row matches `id`, `409` if the row's `status` isn't `pending` or `failed` (already `applied`/`rejected`), `500` on a Google API or Supabase failure

---

## `POST /api/proposed-changes/{id}/reject`

**Auth:** required — same as above

**Request:** no body

**What it does:** marks a `pending` or `failed` proposed change as `rejected` — no calendar write happens. Rejecting a `failed` change is an alternative to retrying it via `approve`.

**Response:** the updated row plus `message`, `status: "rejected"`

**Errors:** `401` unauthorized, `404` if no row matches `id`, `409` if the row's `status` isn't `pending` or `failed`, `500` on a Supabase failure

---

## `PATCH /api/proposed-changes/{id}`

**Auth:** required — same as above

**Request:** `application/json`, at least one of:
```json
{
  "priority": "critical | high | medium | low",
  "tags": "string[]",
  "duration_minutes": "number (positive)"
}
```

**What it does:** edits a still-open (`pending` or `failed`) proposed change's `priority`/`tags`/`duration_minutes` before it's approved. This is the review-time step Todoist task-intake proposals need — the sync deliberately leaves priority/tags unset (Todoist can't tell us how you want to prioritize/organize your own work), and `duration_minutes` only when Todoist's own optional duration wasn't set on the task — so you set them here before approving. Not specific to Todoist — any pending/failed proposal can be corrected the same way. `tags` is normalized the same way as `inbox_items`.

**Response:** the updated row plus `message` (same plain-language summary as the other proposed-changes routes)

**Errors:** `401` unauthorized, `400` if no field is given or a field is invalid, `404` if no row matches `id`, `409` if the row's `status` isn't `pending` or `failed`, `500` on a Supabase failure

---

## `POST /api/todoist/sync`

**Auth:** required — same as above

**Request:** no body

**What it does:** on-demand Todoist task sync (`architecture-plan.md` section 4a) — fetches your active Todoist tasks (`TODOIST_API_TOKEN`, a personal access token) and diffs the full list against `synced_tasks`. Every Todoist task with no `synced_tasks` row yet gets a `create` proposal into `proposed_changes` (`category: 'task'`, no `proposed_start`/`proposed_end`, `proposed_summary` = the task's title, `deadline` = its due date, `source_system: 'todoist'`) — this is the "add to the task list" shape described above, so nothing lands in `tasks` until you approve it (and, typically, set `priority`/`tags` first via `PATCH /api/proposed-changes/{id}`). Tasks that drop out of Todoist's active list (completed or deleted there — the REST API doesn't distinguish, and both get the same handling) either get silently withdrawn (if nothing user-visible happened yet: the intake proposal is still pending/failed, or already rejected) or get a `delete` proposal into the review queue (if already scheduled onto the calendar).

Same on-demand-only shape as `POST /api/calendar/sync` — nothing in this backend runs on a schedule yet.

**Response:**
```json
{
  "proposed": "number — new task-intake proposals created this run",
  "skippedExisting": "number — Todoist tasks already tracked in synced_tasks",
  "withdrawnUnscheduled": "number — tasks that disappeared from Todoist before ever reaching the calendar",
  "proposedDeletes": "number — delete proposals created for tasks that disappeared after already being scheduled",
  "errors": "string[] — per-task failures; a failure on one task doesn't stop the rest"
}
```

**Errors:** `401` unauthorized, `500` if `TODOIST_API_TOKEN` is unset, the Todoist API call fails, or on an unexpected/Supabase failure

---

## `POST /api/canvas/sync`

**Status: currently non-functional, on hiatus (as of 2026-07-24) — pending the user's school admin approving Canvas API access.** `CANVAS_API_TOKEN` is unset; `CANVAS_BASE_URL` currently holds a bare label ("upenn"), not a full URL, and will need fixing to something like `https://upenn.instructure.com` once a token is available — calling this today will 500. Code is complete and was designed/reviewed, just never live-verified against a real Canvas account. Don't present this as a working tool to the NL layer until both env vars are set correctly and it's been re-verified live.

**Auth:** required — same as above

**Request:** no body

**What it does:** on-demand Canvas assignment sync (Phase 4 item 12, `lib/canvasSync.ts`) — same review-queue gating and `synced_tasks` dedup pattern as `POST /api/todoist/sync`, adapted for Canvas's shape:
- Fetches your active courses (`CANVAS_BASE_URL`/`CANVAS_API_TOKEN`, a personal access token), then each course's assignments (`include[]=submission`, paginated via Canvas's `Link` header).
- Only assignments/quizzes are synced — items whose `submission_types` includes `discussion_topic` (graded discussions) are skipped.
- Unlike Todoist, a Canvas assignment never disappears from its course's assignment list, so "resolved" is read from the current user's own submission state instead of list membership: anything other than `'unsubmitted'` (`submitted`/`graded`/`pending_review`) counts as done, same role Todoist's "dropped off the active list" plays.
- Every unresolved, syncable assignment with no `synced_tasks` row yet gets a `create` proposal into `proposed_changes` (`category: 'task'`, no `proposed_start`/`proposed_end`, `proposed_summary` = `"<course name>: <assignment name>"`, `proposed_description` = the assignment's description with HTML tags stripped, `deadline` = `due_at`, `source_system: 'canvas'`) — same task-list-intake shape as Todoist, nothing lands in `tasks` until approved.
- Resolved assignments get the same withdrawal handling as Todoist: silently withdrawn if nothing user-visible happened yet, or a `delete` proposal if already scheduled onto the calendar.
- **Create-once, same limitation as Todoist sync:** an assignment already tracked in `synced_tasks` is never re-checked for a changed due date or title — a due-date move in Canvas after intake is silently ignored (explicit choice for v1; flagged as a known gap, same as Todoist's).

Same on-demand-only shape as `POST /api/todoist/sync` — nothing in this backend runs on a schedule yet.

**Response:** identical shape to `POST /api/todoist/sync`'s (`proposed`/`skippedExisting`/`withdrawnUnscheduled`/`proposedDeletes`/`errors`), same meanings.

**Errors:** `401` unauthorized, `500` if `CANVAS_BASE_URL`/`CANVAS_API_TOKEN` is unset, the Canvas API call fails, or on an unexpected/Supabase failure

---

## `GET /api/tasks`

**Auth:** required — same as above

**Query params:** `status` (optional — one of `unscheduled`/`scheduled`/`completed`/`discarded`; omit to return all rows)

**What it does:** lists rows from `tasks` (`backend-schema.md`), newest first — the task list produced by approving Todoist (or future Canvas/manual) intake proposals.

**Response:** array of `tasks` rows

**Errors:** `401` unauthorized, `400` if `status` isn't a valid value, `500` on a Supabase failure

---

## `POST /api/tasks`

**Auth:** required — same as above

**Request:** `application/json`:
```json
{
  "title": "string (required)",
  "description": "string (optional)",
  "deadline": "ISO datetime (optional) — a \"must be done by\" constraint",
  "priority": "critical | high | medium | low (optional) — null/omitted resolves to 'medium' at use-time, not stored",
  "duration_minutes": "integer, positive (optional) — null/omitted resolves via TASK_DEFAULT_DURATION_MINUTES at planning time, not stored",
  "tags": "string[] (optional) — normalized same as inbox_items"
}
```

**What it does:** creates a new task directly, `status: 'unscheduled'`, `source_system: 'manual'`. Direct insert, not routed through `proposed_changes` — a task the user states directly ("I need a haircut by Monday") isn't external unreviewed data like a Todoist import, so it doesn't need the review queue, same reasoning as `POST /api/habits` (Phase 3.5 item 19, `backend-build-order.md`).

**Response:** the created `tasks` row

**Errors:** `401` unauthorized, `400` on a missing/invalid required field, `500` on a Supabase failure

---

## `POST /api/tasks/{id}/schedule`

**Auth:** required — same as above

**Request:** `application/json`, exactly one shape:
```json
{ "actor": "user | ai-engine", "event_id": "string" }
```
or
```json
{ "proposed_start": "ISO datetime", "proposed_end": "ISO datetime", "bumpIfMovable": "boolean (optional, default false)" }
```
Providing both or neither shape is a `400`.

**What it does:** AI Tasks Part 1 (`architecture-plan.md` section 4d, `lib/aiTasks.ts`) — gives an `unscheduled` task a calendar presence, one of two ways:
- **`event_id` (link to an existing event, e.g. an existing Focus Time block):** doesn't create/move/delete any calendar time — it tags that event's metadata with this task and marks the task `scheduled`. `actor` decides whether that's immediate or reviewed: `"user"` applies directly (a real Google Calendar write + `tasks` update in this same request, no `proposed_changes` row at all); `"ai-engine"` instead creates a `change_type: 'update'` proposal targeting `event_id`, only actually linking once that's approved.
- **`proposed_start`/`proposed_end` (create a brand-new event for the task):** always goes through `proposed_changes` as a `create` regardless of `actor` — this genuinely creates calendar time, so it's never exempt from the review queue. `category: 'task'`, carrying over the task's title/description/deadline/priority. `bumpIfMovable` passes straight through as that proposal's `bump_if_movable` (item 24, see `POST /api/proposed-changes`) — if the requested slot conflicts with something flexible and lower-priority, that occupant gets its own relocation proposal instead of this request just failing, though this request still ends up `failed` pending your approval of that relocation either way.

Either way, the task must currently be `status: 'unscheduled'` — already-scheduled/completed/discarded tasks are a `409`.

**Response:**
- Direct link (`actor: 'user'`): `{ "mode": "linked-directly", "task": { ...updated tasks row... } }`
- Proposed link (`actor: 'ai-engine'`): `{ "mode": "linked-via-proposal", "proposal": { ...proposed_changes row... } }`
- New event: `{ "mode": "created-via-proposal", "proposal": { ...proposed_changes row... } }`

**Errors:** `401` unauthorized, `400` on a malformed body/dates or an invalid `actor`, `404` if the task or (for a direct link) the target event doesn't exist, `409` if the task isn't `unscheduled`, `500` on a Google API or Supabase failure

---

## `GET /api/tasks/next`

**Auth:** required — same as above

**Query params:** `limit` (optional — integer 1–20, default `1`)

**What it does:** AI Tasks Part 2's "what should I work on next" (`architecture-plan.md` section 4e, `lib/aiTasks.ts`'s `getNextTasks`) — read-only, no side effects. Fetches `status: 'unscheduled'` tasks and sorts them: priority tier first (`critical` > `high` > `medium` > `low`, always wins), deadline urgency (hours until deadline, overdue clamped to most-urgent, no deadline least-urgent) as a same-tier tiebreak, task id as the final deterministic tiebreak. Slices to `limit`.

**Response:** array of `tasks` rows, each with an added `priority_score` (a single display-only number that sorts consistently with the ranking above — not itself the ranking logic).

**Errors:** `401` unauthorized, `400` if `limit` is out of range, `500` on a Supabase failure

---

## `POST /api/tasks/plan`

**Auth:** required — same as above

**Query params:** `from`/`to` (optional ISO datetimes — default `from: now`, `to: from + 14 days`, same shape as `POST /api/calendar/reschedule`). `400` if either fails to parse or `to` isn't later than `from`.

**What it does:** AI Tasks Part 2's auto-placement engine (`architecture-plan.md` section 4e, `lib/taskPlacement.ts`'s `planTaskPlacement`). Processes all `unscheduled` tasks in the same priority-score order as `GET /api/tasks/next`, and for each one, in order:
- Skips it if it already has a `pending`/`failed` `create` proposal awaiting approval.
- If its `deadline` falls inside `[from, to]`, searches for a slot **backward from the deadline** — the last fitting opening before it, so the task lands as late as possible while still finishing on time. Otherwise (no deadline, already past, or beyond the horizon) takes the first fitting opening — ASAP placement.
- Calls `POST /api/tasks/{id}/schedule`'s underlying `scheduleTaskToNewEvent` once a slot is chosen — same as a manual "create new event for this task" call, so this still lands in `proposed_changes` for approval, not written directly.
- Tracks every slot it claims (including this run's own prior picks) so a lower-ranked task can't land on top of one a higher-ranked task already took.

A task too big for any single opening anywhere in the window is skipped with a reason ending "— session-splitting not yet supported" (that feature isn't built yet — see `architecture-plan.md` section 4e); a task that lost out to a higher-ranked task in the same run gets a distinct "already claimed" reason instead. A single task's failure doesn't abort the run — it's recorded as `skipped-error`.

**Response:**
```json
{
  "rangeStart": "ISO datetime",
  "rangeEnd": "ISO datetime",
  "tasksScanned": 0,
  "proposalsCreated": 0,
  "skippedAlreadyPending": 0,
  "skippedNoSlot": 0,
  "results": [
    { "taskId": "uuid", "title": "string", "outcome": "proposed | skipped-already-pending | skipped-no-slot | skipped-error", "proposal": {}, "reason": "string" }
  ]
}
```

**Errors:** `401` unauthorized, `400` on an invalid `from`/`to`, `500` on a Google API or Supabase failure. On-demand only — nothing in this backend runs on a schedule yet.

---

## `GET /api/habits`

**Auth:** required — same as above

**Query params:** `status` (optional — one of `active`/`paused`; omit to return all rows)

**What it does:** lists rows from `habits` (`backend-schema.md`), newest first.

**Response:** array of `habits` rows

**Errors:** `401` unauthorized, `400` if `status` isn't a valid value, `500` on a Supabase failure

---

## `POST /api/habits`

**Auth:** required — same as above

**Request:** `application/json`:
```json
{
  "title": "string (required)",
  "description": "string (optional)",
  "cadence": "weekly | monthly | daily | interval (required)",
  "interval_days": "integer, positive — required when cadence is 'interval', invalid otherwise",
  "target_count": "integer, positive (required) — how many occurrences per period",
  "occurrence_duration_minutes": "integer, positive (optional) — null/omitted resolves via HABIT_DEFAULT_OCCURRENCE_DURATION_MINUTES at planning time, not stored",
  "priority": "critical | high | medium | low (optional) — null/omitted resolves to 'low' at use-time, not stored",
  "tags": "string[] (optional) — normalized same as inbox_items"
}
```
`interval_days` is the minimum number of days between consecutive occurrences (e.g. `2` for "every other day") — only meaningful when `cadence` is `'interval'`; `400` if `cadence` is `'interval'` and `interval_days` is missing/invalid.

**What it does:** creates a new habit, `status: 'active'`. Direct insert, not routed through `proposed_changes` — a habit declaration is a goal, not a calendar write (`architecture-plan.md` section 4f).

**Response:** the created `habits` row

**Errors:** `401` unauthorized, `400` on a missing/invalid required field, `500` on a Supabase failure

---

## `PATCH /api/habits/{id}`

**Auth:** required — same as above

**Request:** `application/json`, at least one of `title`/`description`/`cadence`/`interval_days`/`target_count`/`occurrence_duration_minutes`/`priority`/`tags`/`status`. Setting `status: 'paused'` is the pause mechanism — there's no delete route. If `cadence` is being set to `'interval'`, `interval_days` must be provided in the same request (this route doesn't re-read the row first, so it can't check a value set on an earlier call — the DB's `habits_interval_requires_days` constraint is the backstop for any gap this misses).

**What it does:** edits a habit's fields, same field-by-field validation as `POST /api/habits`.

**Response:** the updated `habits` row

**Errors:** `401` unauthorized, `400` if no valid field is given or a field is invalid, `404` if no row matches `id`, `500` on a Supabase failure

---

## `POST /api/habits/plan`

**Auth:** required — same as above

**Request:** no body, no query params — always operates on "the current period," per-habit, via each habit's own `cadence` (mirrors `POST /api/focus-time/plan`'s shape, not `POST /api/tasks/plan`'s `from`/`to`).

**What it does:** AI Habits' occurrence-count auto-fill with spacing (`architecture-plan.md` section 4f, `lib/habitPlacement.ts`). For every `status: 'active'` habit, counts occurrences already satisfied this period (calendar events tagged `type:'habit'` + matching `sourceId`, plus still-pending/failed proposals) and, for any habit still short of `target_count`, proposes the remaining occurrences spread across what's left of the period (not clustered together) via `findFreeSlots` + a segment-based spacing mechanism. Habits due this run are processed in urgency order (priority tier first, then `hoursLeftInPeriod / occurrencesStillNeeded` as a same-tier tiebreak) so a more urgent habit claims free time before a less-squeezed one. Every proposed occurrence is `flexible: 'true'`, `priority` defaulting to `'low'` — the opposite of Focus Time's auto-defend stance, since habits are meant to yield rather than protect their slot. Same review-queue principle as everywhere else — nothing is written to the calendar directly.

**`cadence: 'interval'` uses a different "period" (item 21):** instead of a fixed calendar window, its window rolls forward from the habit's own last occurrence (real event or pending/failed proposal, whichever is more recent) — the next one is never proposed less than `interval_days` after it. This is what actually delivers "never two days in a row" for something like "every other day," which a fixed weekly/monthly window can't guarantee across its own period boundary. `'daily'` cadence, by contrast, is just a fixed calendar period like weekly/monthly, sized to one day.

**Response:**
```json
{
  "now": "ISO datetime",
  "habitsScanned": 0,
  "habitsAlreadySatisfied": 0,
  "occurrencesProposed": 0,
  "occurrencesSkippedNoSlot": 0,
  "results": [
    { "habitId": "uuid", "title": "string", "occurrenceIndex": 1, "outcome": "proposed | skipped-no-slot | skipped-error", "proposal": {}, "reason": "string" }
  ]
}
```
`occurrenceIndex` is 1-based within that habit's remaining occurrences this run; `0` marks a habit-level error (`skipped-error`) not tied to one specific occurrence.

**Errors:** `401` unauthorized, `500` on a Google API or Supabase failure. On-demand only — nothing in this backend runs on a schedule yet.

---

## `GET /api/capability-requests`

**Auth:** required — same as above

**Query params:** `status` (optional — one of `open`/`planned`/`built`/`wontfix`; omit to return all rows)

**What it does:** lists rows from `capability_requests` (`backend-schema.md`), newest first — the backlog of missing capabilities surfaced while trying to fulfill a natural-language request.

**Response:** array of `capability_requests` rows

**Errors:** `401` unauthorized, `400` if `status` isn't a valid value, `500` on a Supabase failure

---

## `POST /api/capability-requests`

**Auth:** required — same as above

**Request:** `application/json`:
```json
{
  "requested_capability": "string (required) — short description of what was needed",
  "example_phrase": "string (optional) — the NL phrase that triggered this, if any",
  "context": "string (optional) — why nothing existing covers it, a sketch of a possible endpoint, etc."
}
```

**What it does:** logs a capability gap, `status: 'open'`. Direct insert, not routed through `proposed_changes` — this is a backlog declaration, not a calendar write, same reasoning as `POST /api/habits`. Every call inserts a new row — no dedup against existing requests, so the same gap asked for repeatedly shows up as repeated rows (a deliberate choice: surfaces "asked N times" as a pattern you spot when triaging the list, rather than an exact-text match silently merging differently-worded but related asks).

**Response:** the created `capability_requests` row

**Errors:** `401` unauthorized, `400` if `requested_capability` is missing/empty, `500` on a Supabase failure

---

## `PATCH /api/capability-requests/{id}`

**Auth:** required — same as above

**Request:** `application/json`, at least one of `requested_capability`/`example_phrase`/`context`/`status`. This is the triage step — move a request from `open` to `planned` once you've decided to build it, or to `built`/`wontfix` once resolved.

**What it does:** edits a capability request's fields, same field-by-field validation as `POST /api/capability-requests`.

**Response:** the updated `capability_requests` row

**Errors:** `401` unauthorized, `400` if no valid field is given or a field is invalid, `404` if no row matches `id`, `500` on a Supabase failure

---

## Not yet built

- **Item 20, source-system-aware auto-apply** — `AUTO_APPLY_CATEGORIES` only keys on `category`, not `source_system`. There is currently no way to auto-apply chat/NL-originated changes while still holding e.g. Todoist imports back for review — every `proposed_changes` row the NL layer creates (other than direct-insert `POST /api/tasks`/`POST /api/habits`, which bypass the queue entirely) sits `pending` needing a manual approval tap, regardless of how directly the user stated it. Worth an explicit decision before/while building the chat layer — either build this, or deliberately accept "everything the NL layer proposes onto the calendar needs a manual tap" as the v1 posture.
- AI Tasks Part 3 — session-splitting for tasks too large for any single free opening (Phase 3 item 7; Parts 1 and 2 are done — manual link/create via `POST /api/tasks/{id}/schedule`, auto-placement via `POST /api/tasks/plan`)
- A deadline-driven reprioritization method that lets deadline/period urgency override priority tier for either Tasks or Habits (today's ranking always lets tier win — a future, distinct item)
- Per-habit preferred time-of-day windows (e.g. "only evenings")
- The cross-feature "AI Planner" orchestration layer (Phase 3 item 11) that would arbitrate Tasks/Habits/Focus Time/Buffers against each other for the same calendar time — each planner today only coordinates through shared calendar/pending-proposal state, independently triggered
- Item 15, weekly time-spend reports; item 16, follow-up reminder notifications — both Phase 4, not started, lower priority
- `POST /api/capture` (screenshot → Claude vision → inbox row) — see its own entry above; not implemented at all, don't list as a callable tool
