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

**What it does:** lists upcoming events from the burner calendar (`GOOGLE_BURNER_CALENDAR_ID`) via the Google Calendar API, authenticated as the service account (`lib/googleCalendar.ts`). Read-only proof that the auth chain works — no scheduling logic, no writes.

**Query behavior:** `timeMin` = now, `singleEvents: true`, `orderBy: 'startTime'`, `maxResults: 50`. Not yet configurable via query params.

**Response:** array of events, mapped down from Google's raw event objects
```json
[
  {
    "id": "string",
    "summary": "string",
    "description": "string | null",
    "location": "string | null",
    "start": { "dateTime": "string", "timeZone": "string" },
    "end": { "dateTime": "string", "timeZone": "string" },
    "status": "string",
    "htmlLink": "string"
  }
]
```

**Errors:** `401` if unauthorized, `500` with `{ "error": message }` if the Google Calendar API call fails (bad credentials, calendar not shared, etc.)

---

## `POST /api/calendar/sync`

**Auth:** required — `x-api-key` header must match `APP_SECRET_KEY`

**Request:** no body

**What it does:** mirrors every calendar listed in `GOOGLE_SOURCE_CALENDAR_IDS` (comma-separated `label:calendarId` pairs, e.g. `Kids:abc...@group.calendar.google.com` — `calendarList.list()` can't be used here, since sharing a calendar with a service account never populates its `calendarList`, only its ACL permissions) into the burner calendar. Every synced event is tagged with `sourceLabel` (the configured label) and `sourceCalendarId` in its `extendedProperties.private`, so its origin calendar is always identifiable. One-way sync only (external → burner) — see `architecture-plan.md` section 2a. First run per calendar does a full backfill capped at 1 year out; subsequent runs use Google's `syncToken` for incremental deltas. Dedup and no-op-skip are driven by the `synced_events` and `calendar_sync_state` tables (see `backend-schema.md`) — safe to call repeatedly, including mid-backfill. Google write calls (`insert`/`update`/`delete`) retry with exponential backoff on rate-limit/transient errors, since bulk-writing a large first backfill reliably trips the Calendar API's write burst quota.

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

## Not yet built

- Proposed-changes endpoints (create/approve/reject) — Phase 2
- Task/habit/focus-time endpoints — Phase 3
