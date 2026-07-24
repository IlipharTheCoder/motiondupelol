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
  category text not null check (category in ('task','habit','focusTime','meeting','fixed','buffer','personal')),
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
  duration_minutes integer check (duration_minutes is null or duration_minutes > 0),
  color_tag text,
  deadline timestamptz,
  reason text,
  bump_if_movable boolean not null default false,
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

**`tags` (added 2026-07-22, Todoist task sync, section 4a):** `text[]`, same `normalizeTags()` treatment as `inbox_items`. Not settable on creation by a sync — a Todoist task-intake `create` proposal lands with `tags: []`, and you set real tags via `PATCH /api/proposed-changes/{id}` before approving (same review-time step as `priority`; see `PATCH /api/proposed-changes/{id}` in `backend-api-reference.md`). **Update (2026-07-24, items 13/14):** originally documented as "untouched for anything that writes to the calendar instead" — no longer true. `applyProposedChange`'s calendar `create`/`update` branches now thread `tags` into the event's own `extendedProperties.private` (comma-joined via `lib/eventMetadata.ts`'s `encodeEventTags`, see `architecture-plan.md`), so a `create`/`move`/`update` proposal's `tags` field now means "tags on the resulting calendar event," in addition to the pre-existing task-list-intake meaning ("tags on the resulting `tasks` row") when `category: 'task'` with no `proposed_start`/`proposed_end`.

**A `create` proposal can now omit `proposed_start`/`proposed_end` — but only when `category` is `'task'`.** This is the "add to the task list, not the calendar" shape (section 4a): `proposed_summary` = the task's title, `deadline` = its due date, nothing scheduled yet. Applying this shape inserts into `tasks` (below) instead of calling the Calendar API — `target_event_id` stays `null` since nothing was written to Google. Every other category still requires both.

If an approved/auto-applied `delete` proposal's `target_event_id` matches a `tasks` row's `scheduled_event_id`, that `tasks` row is marked `completed` as a side effect — closes the loop for the Todoist completion/deletion flow (section 4a step 7) without needing a separate mechanism.

**`duration_minutes` (added 2026-07-23, AI Tasks Part 2, section 4e):** `integer`, same nullable/round-trip treatment as `tags` — carried through from a `tasks` row on a "schedule this task" `create` (`lib/aiTasks.ts`'s `scheduleTaskToNewEvent`), and settable via `PATCH /api/proposed-changes/{id}` at review time for a Todoist task-intake proposal that arrived without one. Not load-bearing on an already-timed `create`/`move` (the proposed start/end already imply the real duration) — this column exists for the task-list-intake shape, where nothing else records how long the task will take.

```sql
alter table proposed_changes
  add column duration_minutes integer check (duration_minutes is null or duration_minutes > 0);

notify pgrst, 'reload schema';
```

**`bump_if_movable` (added 2026-07-23, Phase 3.5 item 24):** `boolean`, `not null default false`. Opt-in per-proposal — set `true` on a `create`/`move` to let `applyProposedChange` (`lib/proposedChanges.ts`) relocate a flexible, strictly-lower-priority occupant out of the way instead of just failing on conflict. Deliberately not the new default behavior (existing "conflict = fail" callers are unaffected unless they opt in), and deliberately never applies `row` itself even when the bump succeeds — the occupant's relocation is only ever proposed (a real, separate `pending` `move` row, bypassing `AUTO_APPLY_CATEGORIES` on purpose), never auto-applied, so `row` stays `failed` with a message pointing at what to approve first until you do. See `POST /api/proposed-changes` / `POST /api/tasks/{id}/schedule` in `backend-api-reference.md`.

```sql
alter table proposed_changes add column bump_if_movable boolean not null default false;
notify pgrst, 'reload schema';
```

**`update` + `source_id` = "link this task to an already-existing event" (AI Tasks Part 1, `architecture-plan.md` section 4d).** A bare `source_id` (no other field) now satisfies `update`'s "needs something to change" validation — this is the one shape where `source_id`'s presence flips the normal precedence: for every other `update`, the *existing* event's `sourceSystem`/`sourceId` metadata wins (a plain field edit shouldn't silently overwrite an event's origin); here, the *proposal's* `source_id` wins instead, and on success the matching `tasks` row (if `source_id` is UUID-shaped — Todoist's own intake `create` shape reuses `source_id` for an external Todoist id, not a `tasks.id`, so this is guarded rather than assumed) gets `status: 'scheduled'` + `scheduled_event_id` set. See `POST /api/tasks/{id}/schedule` in `backend-api-reference.md`.

`category` reuses `BurnerEventType` and `source_system` reuses `SourceSystem` (both from `lib/eventMetadata.ts`) rather than inventing parallel enums.

**Status is a 4-state machine, not 5** — deliberately no separate `approved` state. Applying a change means synchronously calling the Google Calendar API within the same request (either the approve endpoint, or immediately at creation time for a whitelisted auto-apply category), so there's no window where something is "approved but not yet applied" for a state to represent. `pending → applied | rejected | failed`; a `failed` row can be retried (re-approved) or rejected, same as `pending`.

**`priority` is `critical`/`high`/`medium`/`low`, not numeric** — matches how the user actually thinks about events (e.g. doctors' appointments and classes are `critical`), not an arbitrary 1-5 scale. Applies to any timed event ("block"); an all-day event ("note" — birthdays, first-day-of-school-type entries) just doesn't have a meaningful priority, but there's no separate stored "note vs block" type for this — it's inferred from whether the underlying Google event is all-day (`start.date`) vs timed (`start.dateTime`). **All-day events are excluded entirely from scheduling** (changed 2026-07-24) — `lib/busyIntervals.ts`'s `normalizeEventToInterval` returns `null` for them, so they never count as busy time, never block a free-slot search, and never register as a conflict, in any of this backend's scheduling primitives. Previously they blocked their entire date range as if genuinely busy, which a real synced all-day event ("Second year student orientation," a week-long entry) exposed as wrong while verifying item 24.

**`color_tag` is derived from `category`, never freely chosen** — `lib/eventMetadata.ts`'s `CATEGORY_COLORS` map is the single source of truth (task/habit/focusTime/meeting/fixed/buffer/personal each get a fixed hex color). This is why `color_tag` isn't part of `ProposedChangeInput`: the caller can't set it, so it's never blank. It's computed at proposal-creation time (so a still-`pending` row already shows the right color for a review-queue UI) and re-derived at apply time from whatever category is actually being written (so an `update` that changes an event's category gets the matching color, not a stale one).

**`deadline` is separate from `proposed_start`/`proposed_end`** — the latter is where a block is actually placed on the calendar; `deadline` is a "must be done by" constraint that travels with the event but doesn't by itself schedule anything. No deadline-aware logic reads it yet (no "reject if past deadline," no auto-placement) — that's Phase 3 item 7's "deadline-aware backward planning," a distinct, not-yet-built feature. Today this is pure store-and-round-trip.

**Which fields are required depends on `change_type`** (enforced by `validateProposalInput` in `lib/proposedChanges.ts`, not by a DB constraint, since the requirement is conditional): `create` needs `proposed_start`/`proposed_end`/`proposed_summary` and no `target_event_id`; `move` needs `target_event_id` + `proposed_start`/`proposed_end`; `update` needs `target_event_id` + at least one proposed field; `delete` needs only `target_event_id`.

**Access:** same `GRANT` + `NOTIFY` treatment as above.

**No RLS** — same reasoning as `inbox_items`/`event_metadata`.

---

## `tasks`

Phase 3 item 6 (Todoist task sync, `architecture-plan.md` section 4a) — a database of tasks, distinct from both calendar events and the Universal Inbox. A calendar block *can* optionally point back at the task that produced it (via `scheduled_event_id`), but plenty of blocks (meetings, habits) never have one. Populated two ways: `POST /api/todoist/sync` approvals (via `applyProposedChange`'s task-list-intake branch, `lib/proposedChanges.ts`), which go through the `proposed_changes` review queue since Todoist data is external and unreviewed; and `POST /api/tasks` (Phase 3.5 item 19), a direct insert with `source_system: 'manual'` — a task the user states directly isn't external unreviewed data, so it isn't gated behind the review queue, same reasoning as `habits`.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key, default-generated |
| `title` | `text` | Direct from the source task's title (Todoist's `content`) |
| `description` | `text` | |
| `deadline` | `timestamptz` | A "must be done by" constraint — independent of `scheduled_event_id`'s actual time slot. Read by AI Tasks Part 2's deadline-aware backward planning (`architecture-plan.md` section 4e) — a task with a deadline inside the search window gets placed as late as possible before it, rather than at the next open slot |
| `priority` | `text` | `critical`/`high`/`medium`/`low`, same `EventPriority` scale as everywhere else. `null` until set — never imported from Todoist's own priority levels, set by you at review time via `PATCH /api/proposed-changes/{id}` before approving |
| `tags` | `text[]` | Same `normalizeTags()` treatment as `inbox_items`. Set by you at review time, same as `priority` |
| `duration_minutes` | `integer` | How long the task is expected to take. `null` when unknown — **deliberately not backfilled with a default at insert time** (see `TASK_DEFAULT_DURATION_MINUTES` below); AI Tasks Part 2 resolves the fallback only at planning time, so changing the env var later doesn't require a data migration. Settable at review time via `PATCH /api/proposed-changes/{id}`, same as `priority`/`tags` |
| `source_system` | `text` | `'todoist'` / `'canvas'` / `'manual'` |
| `source_id` | `text` | The source system's own task id (e.g. Todoist's task id) |
| `status` | `text` | `'unscheduled'` / `'scheduled'` / `'completed'` / `'discarded'` |
| `scheduled_event_id` | `text` | Burner calendar event id, once AI Tasks (Part 1's manual link/create, or Part 2's auto-placement) gives it an actual time slot. `null` until then |
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
  duration_minutes   integer check (duration_minutes is null or duration_minutes > 0),
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

**`duration_minutes` (added 2026-07-23, AI Tasks Part 2, section 4e):**
```sql
alter table tasks
  add column duration_minutes integer check (duration_minutes is null or duration_minutes > 0);

notify pgrst, 'reload schema';
```

**Access / No RLS:** same reasoning as `inbox_items`/`event_metadata` — only the backend's `service_role` key ever touches this table.

---

## `synced_tasks`

Dedup mapping for the Todoist and Canvas syncs (Phase 4 item 12, `lib/canvasSync.ts`), mirroring `synced_events`/`calendar_sync_state` (section 2a) — same pattern, not reinvented. Keyed by `{source_system, source_id}` rather than a Supabase-generated id, same reasoning as `event_metadata`.

| Column | Type | Notes |
|---|---|---|
| `source_system` | `text` | Part of composite PK |
| `source_id` | `text` | Part of composite PK — the source system's own task id |
| `proposed_change_id` | `uuid` | The `create` proposal made for this task while it's still unresolved (`references proposed_changes(id)`). Set at intake, read by `applyProposedChange` to link the resulting `tasks` row back once approved |
| `task_id` | `uuid` | The resulting `tasks` row, once approved (`references tasks(id)`). `null` while the intake proposal is still pending/failed |
| `source_updated_at` | `timestamptz` | The source system's own last-modified signal, informational only — **not currently acted on**: propagating a post-import edit made in the source system (e.g. reworded in Todoist after the `tasks` row already exists) is explicitly out of scope for now (`architecture-plan.md` section 4a). For Todoist specifically, the REST API v2 exposes no true "last modified" timestamp, so this is populated from the task's `created_at` as a best-effort placeholder. Canvas sync leaves this `null` — same create-once limitation, explicitly chosen for v1 (a due-date edit made in Canvas after intake is silently ignored, same as Todoist) |
| `created_at` | `timestamptz` | Default `now()` |
| `updated_at` | `timestamptz` | Default `now()` |

A row here is removed once resolved either way: `task_id` gets linked at approval time, but the row itself is deleted once the sync observes the source item is gone or resolved — see `lib/todoistSync.ts` (list-membership: a completed/deleted task drops out of Todoist's active list) and `lib/canvasSync.ts` (submission-state: a Canvas assignment never drops out of its course's assignment list, so resolution is read from the current user's own `submission.workflow_state` instead — anything other than `'unsubmitted'` counts as resolved, same as a Todoist task disappearing). So a row's mere existence means "known to the source, tracked here"; there's no `status` column since `proposed_changes.status` / `tasks.status` already carry that.

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

---

## `habits`

Phase 3 item 8 (AI Habits, `architecture-plan.md` section 4f) — recurring, occurrence-count goals ("gym 3x/week," "read 1x/month," "meditate every other day"), distinct from `tasks` (one-off items with a single deadline). Populated directly via `POST /api/habits` — a habit declaration is a goal, not a calendar write, so unlike `tasks` it isn't gated behind a `proposed_changes` approval; only the *occurrence placements* `POST /api/habits/plan` produces go through the review queue.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key, default-generated |
| `title` | `text` | |
| `description` | `text` | |
| `cadence` | `text` | `'weekly'` / `'monthly'` / `'daily'` / `'interval'` — which period `target_count` resets against. The first three are fixed calendar periods (`lib/periodRanges.ts`'s `getCurrentPeriodRange`); `'interval'` (added 2026-07-23, item 21) is a rolling window instead — see `interval_days` below and `lib/habitPlacement.ts`'s `computeIntervalHabitContext` |
| `interval_days` | `integer` | Only meaningful when `cadence` is `'interval'` — the minimum number of days between consecutive occurrences (e.g. `2` for "every other day"). `null` for every other cadence; `not null` is enforced conditionally via `habits_interval_requires_days` below rather than a plain column constraint, since the requirement depends on `cadence`'s value |
| `target_count` | `integer` | How many occurrences per period. Count-based, not duration-based — a deliberate choice (see section 4f). For `'interval'` cadence this is almost always `1` (a single recurring action); values `> 1` are supported but treated all-or-nothing per rolling window rather than spaced within it — see `lib/habitPlacement.ts` |
| `occurrence_duration_minutes` | `integer` | How long one occurrence takes. Nullable (changed 2026-07-23, item 21) — resolved at use-time via `HABIT_DEFAULT_OCCURRENCE_DURATION_MINUTES` (`lib/habits.ts`'s `resolveHabitOccurrenceDurationMinutes`, defaults to 30) when left unset, same "resolve lazily, don't backfill" pattern as `tasks.duration_minutes` |
| `priority` | `text` | `critical`/`high`/`medium`/`low`. `null` until set — resolved to `'low'` only at use-time (`lib/habits.ts`'s `resolveHabitPriority`), not backfilled at insert, same rationale as `tasks.duration_minutes` (changing the default later doesn't need a migration). `'low'` is deliberately the opposite of Focus Time's `'high'` auto-defend — habits are meant to yield, not protect themselves |
| `tags` | `text[]` | Same `normalizeTags()` treatment as `inbox_items` |
| `status` | `text` | `'active'` / `'paused'` — `'paused'` is the soft-off; no delete route, same pattern as `tasks`/`inbox_items` |
| `created_at` | `timestamptz` | Default `now()` |
| `updated_at` | `timestamptz` | Default `now()` |

**No occurrence-log table.** Satisfaction is counted by scanning burner calendar events tagged `type:'habit'` + `sourceId: habit.id` within the habit's current period, plus matching still-pending/failed `proposed_changes` rows — exactly generalizing `lib/focusTime.ts`'s `fetchFocusTimeEvents`/`fetchPendingFocusProposals` pattern (count of occurrences here, rather than summed minutes). This keeps the calendar as ground truth: manually deleting a habit occurrence just means the next plan run proposes a fresh one. `'interval'` cadence works the same way, just scanning a wider bounded window to find the single most recent occurrence rather than counting within a fixed period.

**Why `'interval'` needed genuinely different placement logic, not just a new `cadence` value:** the existing spacing algorithm (`lib/habitSpacing.ts`) only guarantees no-clustering *within* one calendar period (week/month/day) — it has no awareness of what was placed in the adjacent period, so a period-based approximation of "every other day" couldn't actually guarantee the "never two days in a row" property that phrase is about (confirmed while scoping item 21: this cross-period gap already exists, undocumented, for `'weekly'`/`'monthly'` today, and is out of scope to fix here). `'interval'` cadence instead anchors its rolling window to the actual timestamp of the habit's own last occurrence — real calendar event or still-pending/failed proposal, whichever is more recent — so the next one is never proposed less than `interval_days` after it, by construction.

**Setup SQL:**
```sql
create table habits (
  id                          uuid primary key default gen_random_uuid(),
  title                       text not null,
  description                 text,
  cadence                     text not null check (cadence in ('weekly','monthly','daily','interval')),
  interval_days               integer check (interval_days is null or interval_days > 0),
  target_count                integer not null check (target_count > 0),
  occurrence_duration_minutes integer check (occurrence_duration_minutes is null or occurrence_duration_minutes > 0),
  priority                    text check (priority in ('critical','high','medium','low')),
  tags                        text[],
  status                      text not null default 'active' check (status in ('active','paused')),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint habits_interval_requires_days check (cadence <> 'interval' or interval_days is not null)
);

grant select, insert, update, delete on habits to service_role;
notify pgrst, 'reload schema';
```

---

## `capability_requests`

Phase 3.5 item 26 — a backlog for capability gaps discovered while trying to fulfill a natural-language request: something the (future, Phase 5) chat layer — or anyone testing against this API — wanted to do but no existing endpoint covers. Populated directly via `POST /api/capability-requests`, same "declaration, not a calendar write" reasoning as `habits` — nothing here is gated behind `proposed_changes`. Every occurrence is logged as its own row (no dedup/counting) — repeated asks for the same underlying gap are expected to show up as repeated rows, left for you to spot when triaging the list, rather than auto-merged.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key, default-generated |
| `requested_capability` | `text` | `not null` — a short description of what was needed (e.g. "reduce today's workload without a specific conflict") |
| `example_phrase` | `text` | The actual NL phrase that triggered this, if there was one. Nullable — not every request originates from a chat message |
| `context` | `text` | Freeform notes: why nothing existing covers it, a sketch of what the new endpoint might look like, etc. |
| `status` | `text` | `'open'` / `'planned'` / `'built'` / `'wontfix'` — `'planned'` marks something you've decided to build but haven't started, distinct from the rest of the still-open backlog |
| `created_at` | `timestamptz` | Default `now()` |
| `updated_at` | `timestamptz` | Default `now()` |

**Setup SQL:**
```sql
create table capability_requests (
  id                    uuid primary key default gen_random_uuid(),
  requested_capability  text not null,
  example_phrase        text,
  context               text,
  status                text not null default 'open' check (status in ('open','planned','built','wontfix')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

grant select, insert, update, delete on capability_requests to service_role;
notify pgrst, 'reload schema';
```

**Access / No RLS:** same reasoning as `inbox_items`/`event_metadata`.

**Access / No RLS:** same reasoning as `inbox_items`/`event_metadata`.
