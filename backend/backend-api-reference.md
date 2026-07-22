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
    "status": "new | parsed | scheduled | discarded",
    "created_at": "timestamptz"
  }
]
```

**Errors:** `401` if unauthorized, `500` with `{ "error": message }` on a Supabase failure

---

## `POST /api/capture`

**Auth:** required — same as above

**Request:** `multipart/form-data`, field name `image`, containing an image file

**What it does:** uploads the image to the `screenshots` Supabase Storage bucket, sends it to Claude (`claude-haiku-4-5`) for extraction, inserts a new `inbox_items` row with the result

**Response:** the newly inserted row (array, per Supabase's `.select()` behavior), same shape as `/api/inbox`

**Errors:** `401` unauthorized, `400` if no image provided, `500` if upload fails, Claude call fails, JSON parsing fails, or the insert fails — each returns `{ "error": message }`

**Status:** written but not yet wired into the client or any downstream flow (deprioritized per `docs/backend-build-order.md` Phase 6)

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

## Not yet built

- Proposed-changes endpoints (create/approve/reject) — Phase 2
- Task/habit/focus-time endpoints — Phase 3
