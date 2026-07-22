# Database Schema — current state

Keep this updated as tables are added/changed. This is the source of truth Claude should check before writing any query — don't assume column names, verify here.

---

## `inbox_items`

Universal inbox capture items — populated by `POST /api/inbox` (plain text) and `/api/capture` (screenshot → Claude vision); will later be populated by other capture sources per `docs/backend-build-order.md` Phase 6.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key, default-generated |
| `title` | `text` | Extracted or user-edited task title |
| `description` | `text` | Extracted or user-edited notes |
| `tags` | `text[]` | Always lowercase, always normalized before insert — see `normalizeTags()` (`lib/normalizeTags.ts`) |
| `image_url` | `text` | Points into the `screenshots` Supabase Storage bucket. `null` for text-only entries |
| `status` | `smallint` | **Not text** — confirmed against the live table (this doc previously said `text`, which was wrong). `0 = new`, `1 = parsed`, `2 = scheduled`, `3 = discarded` — see `lib/inboxStatus.ts` (`InboxStatus`) for the canonical mapping, reference it rather than a raw number. No formal `CHECK` constraint yet, worth adding |
| `created_at` | `timestamptz` | Default `now()` |

**Access:** requires `GRANT` to `service_role` (this table needed one explicitly — see the PGRST205 troubleshooting from earlier in the build).

---

## Storage buckets

- **`screenshots`** — private bucket, holds raw uploaded images before/after Claude parses them. Not yet cleaned up automatically (worth deciding: delete after parse, or keep indefinitely — currently undecided, see `docs/architecture-plan.md` open items).

---

## `event_metadata`

Growable/variable-length data attached to burner calendar events — deliberately kept out of Google Calendar's `extendedProperties`, which silently truncates any value over 1024 characters. Keyed by the Google Calendar event ID, not a Supabase-generated one.

| Column | Type | Notes |
|---|---|---|
| `google_event_id` | `text` | Primary key — matches the `id` field of the corresponding Google Calendar event, not a Supabase `uuid` |
| `subtasks` | `jsonb` | Default `[]` |
| `notes` | `text` | Longer-form notes that don't belong in the calendar event's own description |
| `created_by` | `text` | e.g. `"ai-engine v1"` — useful for debugging why/how an event was created |
| `created_at` | `timestamptz` | Default `now()` |

**Access:** requires the same `GRANT ... TO service_role` + `NOTIFY pgrst, 'reload schema'` treatment as any new table — see `backend-setup-guide.md`.

**No RLS policy** — same reasoning as `inbox_items`, only the backend's `service_role` key ever touches this table.

---

## `calendar_sync_state`

One row per external source calendar (discovered live via `calendar.calendarList.list()`, not hardcoded). Tracks incremental-sync bookkeeping for the Phase 1 sync engine (`lib/calendarSync.ts`) — Vercel functions are stateless between invocations, so this is the only place a Google `syncToken`/`pageToken` survives across runs.

| Column | Type | Notes |
|---|---|---|
| `source_calendar_id` | `text` | Primary key — the external Google calendar's ID |
| `source_calendar_summary` | `text` | Human-readable calendar name, for logs/response payloads only |
| `sync_token` | `text` | Google's `nextSyncToken`. `null` = no completed full sync yet |
| `page_token` | `text` | Google's `nextPageToken`, saved mid-fetch so a serverless timeout is resumable. `null` = no fetch in progress |
| `backfill_time_min` | `text` | ISO timestamp — frozen `timeMin` for an in-progress backfill (must stay identical across every page of that backfill, even across invocations). `null` once backfill completes |
| `backfill_time_max` | `text` | ISO timestamp — frozen `timeMax`, same reasoning. `1 year` out from `backfill_time_min` |
| `last_synced_at` | `timestamptz` | Set only when a sync cycle (backfill or incremental) completes cleanly |
| `last_attempted_at` | `timestamptz` | Set on every invocation touch, even partial/errored |
| `last_error` | `text` | Last error message, if any — informational only, never gates behavior |
| `last_error_at` | `timestamptz` | |
| `created_at` | `timestamptz` | Default `now()` |
| `updated_at` | `timestamptz` | Default `now()` |

State is derived from `sync_token`/`page_token` rather than a redundant status enum — see `lib/calendarSync.ts` for the four-way interpretation (never synced / backfill in progress / steady-state incremental / incremental delta interrupted mid-page).

**Setup SQL:**
```sql
create table calendar_sync_state (
  source_calendar_id      text primary key,
  source_calendar_summary text,
  sync_token              text,
  page_token              text,
  backfill_time_min       text,
  backfill_time_max       text,
  last_synced_at          timestamptz,
  last_attempted_at       timestamptz,
  last_error              text,
  last_error_at           timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

grant select, insert, update, delete on calendar_sync_state to service_role;
notify pgrst, 'reload schema';
```

**Access:** requires the same `GRANT ... TO service_role` + `NOTIFY pgrst, 'reload schema'` treatment as `event_metadata` (PGRST205 troubleshooting).

**No RLS** — same reasoning as `inbox_items`/`event_metadata`, only the backend's `service_role` key ever touches this table.

---

## `synced_events`

Dedup mapping: `{source_calendar_id, source_event_id} → burner_event_id`. This is what makes the sync engine's dedup a fast local Supabase lookup instead of a Google API call (`privateExtendedProperty` filtering) per external event.

| Column | Type | Notes |
|---|---|---|
| `source_calendar_id` | `text` | Part of composite PK |
| `source_event_id` | `text` | Part of composite PK — the external Google event's ID |
| `burner_event_id` | `text` | The corresponding event's ID on the burner calendar. `unique` — one external event must never map to two burner events |
| `etag` | `text` | The external event's Google `etag` at last sync — lets the sync engine skip a write entirely when nothing changed |
| `source_updated_at` | `timestamptz` | The external event's Google `updated` field, informational |
| `created_at` | `timestamptz` | Default `now()` |
| `updated_at` | `timestamptz` | Default `now()` |

**Setup SQL:**
```sql
create table synced_events (
  source_calendar_id text not null,
  source_event_id    text not null,
  burner_event_id    text not null,
  etag               text,
  source_updated_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (source_calendar_id, source_event_id),
  constraint synced_events_burner_event_id_key unique (burner_event_id)
);

create index synced_events_calendar_idx on synced_events (source_calendar_id);

grant select, insert, update, delete on synced_events to service_role;
notify pgrst, 'reload schema';
```

**Access:** same `GRANT` + `NOTIFY` treatment as above.

**No RLS** — same reasoning as `inbox_items`/`event_metadata`.

---

## Tables not yet built (coming per `docs/backend-build-order.md`)

- **Proposed changes / review queue** (Phase 2) — will need: what the change is, what it affects, current approval status, timestamps. Design this fresh when you get to Phase 2 rather than retrofitting `inbox_items`'s or `event_metadata`'s shape onto it — they're not the same kind of data.
- Any local caching of Todoist/Canvas tasks (Phase 3) — not yet designed.
