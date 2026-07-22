# Database Schema — current state

Keep this updated as tables are added/changed. This is the source of truth Claude should check before writing any query — don't assume column names, verify here.

---

## `inbox_items`

Universal inbox capture items — populated by `POST /api/inbox` (plain text) and `/api/capture` (screenshot → Claude vision); editable via `PATCH /api/inbox/{id}`; will later be populated by other capture sources per `docs/backend-build-order.md` Phase 6.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key, default-generated |
| `title` | `text` | Extracted or user-edited task title |
| `description` | `text` | Extracted or user-edited notes |
| `tags` | `text[]` | Always lowercase, always normalized before insert — see `normalizeTags()` (`lib/normalizeTags.ts`). Freely user-defined — any string is a valid tag, there's no fixed tag list |
| `image_url` | `text` | Points into the `screenshots` Supabase Storage bucket. `null` for text-only entries |
| `status` | `smallint` | **Not text** — confirmed against the live table (this doc previously said `text`, which was wrong). `0 = new`, `1 = parsed`, `2 = scheduled`, `3 = discarded` — see `lib/inboxStatus.ts` (`InboxStatus`) for the canonical mapping, reference it rather than a raw number. No formal `CHECK` constraint yet, worth adding |
| `priority` | `text` | `null` until set (a freshly-captured item has no priority yet) — `critical`/`high`/`medium`/`low`, same `EventPriority` scale as everywhere else in the system (`lib/eventMetadata.ts`'s `EVENT_PRIORITIES`), not a separate enum |
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

## `proposed_changes`

The human-in-the-loop review queue (Phase 2 item 4) — every scheduling feature proposes into this table rather than writing to the calendar directly. See `lib/proposedChanges.ts` and `backend-api-reference.md`'s `/api/proposed-changes` routes.

```sql
create table proposed_changes (
  id uuid primary key default gen_random_uuid(),
  change_type text not null check (change_type in ('create','move','update','delete')),
  category text not null check (category in ('task','habit','focusTime','meeting','fixed','buffer')),
  flexible text check (flexible in ('true','false')),
  source_system text not null check (source_system in ('todoist','canvas','google','manual','ai-engine')),
  source_id text,
  target_event_id text,
  proposed_start timestamptz,
  proposed_end timestamptz,
  proposed_summary text,
  proposed_description text,
  priority text check (priority in ('critical','high','medium','low')),
  tags text[],
  color_tag text,
  deadline timestamptz,
  reason text,
  status text not null default 'pending' check (status in ('pending','applied','rejected','failed')),
  decided_by text check (decided_by in ('user','auto-apply-policy')),
  decided_at timestamptz,
  applied_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on proposed_changes to service_role;
notify pgrst, 'reload schema';
```

**`tags` (added 2026-07-22, Todoist task sync, section 4a):** `text[]`, same `normalizeTags()` treatment as `inbox_items`. Not settable on creation by a sync — a Todoist task-intake `create` proposal lands with `tags: []`, and you set real tags via `PATCH /api/proposed-changes/{id}` before approving (same review-time step as `priority`; see `PATCH /api/proposed-changes/{id}` in `backend-api-reference.md`). Only meaningful for `category: 'task'` proposals that end up in the `tasks` table below — untouched for anything that writes to the calendar instead.

**A `create` proposal can now omit `proposed_start`/`proposed_end` — but only when `category` is `'task'`.** This is the "add to the task list, not the calendar" shape (section 4a): `proposed_summary` = the task's title, `deadline` = its due date, nothing scheduled yet. Applying this shape inserts into `tasks` (below) instead of calling the Calendar API — `target_event_id` stays `null` since nothing was written to Google. Every other category still requires both.

If an approved/auto-applied `delete` proposal's `target_event_id` matches a `tasks` row's `scheduled_event_id`, that `tasks` row is marked `completed` as a side effect — closes the loop for the Todoist completion/deletion flow (section 4a step 7) without needing a separate mechanism.

`category` reuses `BurnerEventType` and `source_system` reuses `SourceSystem` (both from `lib/eventMetadata.ts`) rather than inventing parallel enums.

**Status is a 4-state machine, not 5** — deliberately no separate `approved` state. Applying a change means synchronously calling the Google Calendar API within the same request (either the approve endpoint, or immediately at creation time for a whitelisted auto-apply category), so there's no window where something is "approved but not yet applied" for a state to represent. `pending → applied | rejected | failed`; a `failed` row can be retried (re-approved) or rejected, same as `pending`.

**`priority` is `critical`/`high`/`medium`/`low`, not numeric** — matches how the user actually thinks about events (e.g. doctors' appointments and classes are `critical`), not an arbitrary 1-5 scale. Applies to any timed event ("block"); an all-day event ("note" — birthdays, first-day-of-school-type entries) just doesn't have a meaningful priority, but there's no separate stored "note vs block" type for this — it's inferred from whether the underlying Google event is all-day (`start.date`) vs timed (`start.dateTime`), same distinction `lib/busyIntervals.ts` already makes for scheduling purposes.

**`color_tag` is derived from `category`, never freely chosen** — `lib/eventMetadata.ts`'s `CATEGORY_COLORS` map is the single source of truth (task/habit/focusTime/meeting/fixed/buffer each get a fixed hex color). This is why `color_tag` isn't part of `ProposedChangeInput`: the caller can't set it, so it's never blank. It's computed at proposal-creation time (so a still-`pending` row already shows the right color for a review-queue UI) and re-derived at apply time from whatever category is actually being written (so an `update` that changes an event's category gets the matching color, not a stale one).

**`deadline` is separate from `proposed_start`/`proposed_end`** — the latter is where a block is actually placed on the calendar; `deadline` is a "must be done by" constraint that travels with the event but doesn't by itself schedule anything. No deadline-aware logic reads it yet (no "reject if past deadline," no auto-placement) — that's Phase 3 item 7's "deadline-aware backward planning," a distinct, not-yet-built feature. Today this is pure store-and-round-trip.

**Which fields are required depends on `change_type`** (enforced by `validateProposalInput` in `lib/proposedChanges.ts`, not by a DB constraint, since the requirement is conditional): `create` needs `proposed_start`/`proposed_end`/`proposed_summary` and no `target_event_id`; `move` needs `target_event_id` + `proposed_start`/`proposed_end`; `update` needs `target_event_id` + at least one proposed field; `delete` needs only `target_event_id`.

**Access:** same `GRANT` + `NOTIFY` treatment as above.

**No RLS** — same reasoning as `inbox_items`/`event_metadata`.

---

## `tasks`

Phase 3 item 6 (Todoist task sync, `architecture-plan.md` section 4a) — a database of tasks, distinct from both calendar events and the Universal Inbox. A calendar block *can* optionally point back at the task that produced it (via `scheduled_event_id`), but plenty of blocks (meetings, habits) never have one. Populated by `POST /api/todoist/sync` approvals (via `applyProposedChange`'s task-list-intake branch, `lib/proposedChanges.ts`) — nothing writes here directly.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key, default-generated |
| `title` | `text` | Direct from the source task's title (Todoist's `content`) |
| `description` | `text` | |
| `deadline` | `timestamptz` | A "must be done by" constraint — independent of `scheduled_event_id`'s actual time slot. No deadline-aware logic reads it yet (Phase 3 item 7, not built) |
| `priority` | `text` | `critical`/`high`/`medium`/`low`, same `EventPriority` scale as everywhere else. `null` until set — never imported from Todoist's own priority levels, set by you at review time via `PATCH /api/proposed-changes/{id}` before approving |
| `tags` | `text[]` | Same `normalizeTags()` treatment as `inbox_items`. Set by you at review time, same as `priority` |
| `source_system` | `text` | `'todoist'` / `'canvas'` / `'manual'` |
| `source_id` | `text` | The source system's own task id (e.g. Todoist's task id) |
| `status` | `text` | `'unscheduled'` / `'scheduled'` / `'completed'` / `'discarded'` |
| `scheduled_event_id` | `text` | Burner calendar event id, once Phase 3 item 7 (AI Tasks, not yet built) gives it an actual time slot. `null` until then |
| `created_at` | `timestamptz` | Default `now()` |
| `updated_at` | `timestamptz` | Default `now()` |

**Setup SQL:**
```sql
create table tasks (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null,
  description        text,
  deadline           timestamptz,
  priority           text check (priority in ('critical','high','medium','low')),
  tags               text[],
  source_system      text not null check (source_system in ('todoist','canvas','manual')),
  source_id          text,
  status             text not null default 'unscheduled' check (status in ('unscheduled','scheduled','completed','discarded')),
  scheduled_event_id text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

grant select, insert, update, delete on tasks to service_role;
notify pgrst, 'reload schema';
```

**Access / No RLS:** same reasoning as `inbox_items`/`event_metadata` — only the backend's `service_role` key ever touches this table.

---

## `synced_tasks`

Dedup mapping for the Todoist sync, mirroring `synced_events`/`calendar_sync_state` (section 2a) — same pattern, not reinvented. Keyed by `{source_system, source_id}` rather than a Supabase-generated id, same reasoning as `event_metadata`.

| Column | Type | Notes |
|---|---|---|
| `source_system` | `text` | Part of composite PK |
| `source_id` | `text` | Part of composite PK — the source system's own task id |
| `proposed_change_id` | `uuid` | The `create` proposal made for this task while it's still unresolved (`references proposed_changes(id)`). Set at intake, read by `applyProposedChange` to link the resulting `tasks` row back once approved |
| `task_id` | `uuid` | The resulting `tasks` row, once approved (`references tasks(id)`). `null` while the intake proposal is still pending/failed |
| `source_updated_at` | `timestamptz` | The source system's own last-modified signal, informational only — **not currently acted on**: propagating a post-import edit made in the source system (e.g. reworded in Todoist after the `tasks` row already exists) is explicitly out of scope for now (`architecture-plan.md` section 4a). For Todoist specifically, the REST API v2 exposes no true "last modified" timestamp, so this is populated from the task's `created_at` as a best-effort placeholder |
| `created_at` | `timestamptz` | Default `now()` |
| `updated_at` | `timestamptz` | Default `now()` |

A row here is removed once resolved either way: `task_id` gets linked at approval time, but the row itself is deleted once the sync observes the source task is gone (completed/deleted upstream) — see `lib/todoistSync.ts`. So a row's mere existence means "known to Todoist, tracked here"; there's no `status` column since `proposed_changes.status` / `tasks.status` already carry that.

**Setup SQL:**
```sql
create table synced_tasks (
  source_system      text not null,
  source_id          text not null,
  proposed_change_id uuid references proposed_changes(id),
  task_id            uuid references tasks(id),
  source_updated_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (source_system, source_id)
);

grant select, insert, update, delete on synced_tasks to service_role;
notify pgrst, 'reload schema';
```

**Access / No RLS:** same reasoning as `inbox_items`/`event_metadata`.
