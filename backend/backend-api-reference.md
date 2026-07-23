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

**Response:** array of rows from `inbox_items` (see `docs/schema.md`)
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

**Status:** `app/api/capture/route.ts` is currently an empty file — despite this doc previously claiming it was written, there is no implementation yet. Deprioritized per `docs/backend-build-order.md` Phase 6; the description above is the intended behavior, not yet-built reality.

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
      "category": "task | habit | focusTime | meeting | fixed | buffer | null",
      "priority": "critical | high | medium | low | null",
      "deadline": "timestamptz | null",
      "colorTag": "string (hex color, derived from category) | null",
      "origin": {
        "sourceSystem": "todoist | canvas | google | manual | ai-engine | null",
        "sourceLabel": "string | null"
      }
    }
  ],
  "nextPageToken": "string | null"
}
```
There's no separate stored "all-day note vs. block" type — an all-day event (`start.date` instead of `start.dateTime`) is just an event whose `priority` isn't meaningful; whether it's all-day is already visible from `start`/`end`'s shape.

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

**What it does:** computes open slots on the burner calendar within `[from, to)`, intersected with working hours (`HOME_TIMEZONE`/`WORKING_HOURS_START`/`WORKING_HOURS_END`/`WORKING_DAYS` — see `lib/schedulingConfig.ts`, defaults `America/New_York` 10:00–18:00 Mon–Fri). Every non-cancelled burner event counts as busy regardless of its `flexible` tag — this primitive reports what's free, it doesn't decide what to do about conflicts (see `architecture-plan.md`/`backend-build-order.md` Phase 2). `paddingMinutes` expands each busy event by that many minutes on both sides before subtracting (a generic knob, not built-in "buffer time" semantics); `minDurationMinutes` drops any resulting slot shorter than that.

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

**What it does:** checks whether `[from, to)` overlaps any non-cancelled burner event. Pure calendar-overlap only — does **not** consult working hours (a candidate outside working hours is a policy question for a later layer, not this primitive's concern). Back-to-back placement (candidate starts exactly when an existing event ends, or vice versa) is **not** a conflict.

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
  "category": "task | habit | focusTime | meeting | fixed | buffer",
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
  "deadline": "ISO datetime (optional) — a \"must be done by\" constraint, independent of proposed_start/proposed_end",
  "reason": "string (optional, human-readable justification)"
}
```
`update` requires `target_event_id` plus at least one of `proposed_start`/`proposed_end`/`proposed_summary`/`proposed_description`/`priority`/`deadline`.

**`create` may omit `proposed_start`/`proposed_end` entirely — but only when `category` is `'task'`.** That shape means "add this to the task list" rather than "put this on the calendar" (`architecture-plan.md` section 4a) — `proposed_summary` becomes the task's title, `deadline` its due date, and applying it inserts into the `tasks` table (`backend-schema.md`) instead of calling the Calendar API; `target_event_id` stays `null`. `proposed_start` and `proposed_end` must both be present or both be absent — one without the other is a `400`. Every category other than `'task'` still requires both.

Note there's no `color_tag` input — color is always derived from `category` (`lib/eventMetadata.ts`'s `CATEGORY_COLORS`), never freely chosen, so it's never blank. The response's `color_tag` reflects this even on a still-`pending` row (useful for a review-queue UI to show the right color before approval).

**What it does:** validates the input for its `change_type` (`lib/proposedChanges.ts`'s `validateProposalInput`), inserts a `pending` row, then checks `category` against the `AUTO_APPLY_CATEGORIES` env var (comma-separated `BurnerEventType` list, e.g. `habit,buffer`; empty/unset means nothing auto-applies). If `category` is whitelisted, the change is applied to the calendar immediately in the same request — the response reflects the final `applied`/`failed` state, not `pending`. If you want a chance to set `priority`/`tags` before a Todoist task-intake proposal becomes real, keep `task` out of `AUTO_APPLY_CATEGORIES`.

Applying (whether via auto-apply here or via the `approve` endpoint below) re-checks for conflicts on `create`/`move` using `detectConflicts` (`GET /api/calendar/conflicts`'s underlying function) — a conflict fails the change (`status: "failed"`, descriptive `error_message`) rather than double-booking. `create` builds `extendedProperties.private` via `encodeEventMetadata`; `update` reads the existing event first and merges changed fields into its metadata (Google's `patch` replaces the whole `extendedProperties.private` map rather than merging individual keys, so the full map is always resent) — `color_tag` is re-derived from whichever category ends up written, not preserved from the stale row.

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
  "tags": "string[]"
}
```

**What it does:** edits a still-open (`pending` or `failed`) proposed change's `priority`/`tags` before it's approved. This is the review-time step Todoist task-intake proposals need — the sync deliberately leaves both unset (Todoist can't tell us how you want to prioritize/organize your own work), so you set them here before approving. Not specific to Todoist — any pending/failed proposal can be corrected the same way. `tags` is normalized the same way as `inbox_items`.

**Response:** the updated row plus `message` (same plain-language summary as the other proposed-changes routes)

**Errors:** `401` unauthorized, `400` if neither field is given or `priority` is invalid, `404` if no row matches `id`, `409` if the row's `status` isn't `pending` or `failed`, `500` on a Supabase failure

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

## `GET /api/tasks`

**Auth:** required — same as above

**Query params:** `status` (optional — one of `unscheduled`/`scheduled`/`completed`/`discarded`; omit to return all rows)

**What it does:** lists rows from `tasks` (`backend-schema.md`), newest first — the task list produced by approving Todoist (or future Canvas/manual) intake proposals.

**Response:** array of `tasks` rows

**Errors:** `401` unauthorized, `400` if `status` isn't a valid value, `500` on a Supabase failure

---

## Not yet built

- AI Tasks — auto-placement of `tasks` rows into free calendar slots, deadline-aware planning (Phase 3 item 7)
- Buffer Time endpoints (Phase 3 item 10)
- AI Habits endpoints (Phase 3 item 8)
