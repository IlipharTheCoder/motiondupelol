# Database Schema — current state

Keep this updated as tables are added/changed. This is the source of truth Claude should check before writing any query — don't assume column names, verify here.

---

## `inbox_items`

Universal inbox capture items (currently populated only by `/api/capture`; will later be populated by other capture sources per `docs/backend-build-order.md` Phase 6).

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | Primary key, default-generated |
| `title` | `text` | Extracted or user-edited task title |
| `description` | `text` | Extracted or user-edited notes |
| `tags` | `text[]` | Always lowercase, always normalized before insert |
| `image_url` | `text` | Points into the `screenshots` Supabase Storage bucket |
| `status` | `text` | One of: `new`, `parsed`, `scheduled`, `discarded` — no formal `CHECK` constraint yet, worth adding |
| `created_at` | `timestamptz` | Default `now()` |

**Access:** requires `GRANT` to `service_role` (this table needed one explicitly — see the PGRST205 troubleshooting from earlier in the build).

---

## Storage buckets

- **`screenshots`** — private bucket, holds raw uploaded images before/after Claude parses them. Not yet cleaned up automatically (worth deciding: delete after parse, or keep indefinitely — currently undecided, see `docs/architecture-plan.md` open items).

---

## Tables not yet built (coming per `docs/backend-build-order.md`)

- **Proposed changes / review queue** (Phase 2) — will need: what the change is, what it affects, current approval status, timestamps. Design this fresh when you get to Phase 2 rather than retrofitting `inbox_items`'s shape onto it — they're not the same kind of data.
- Any local caching of Todoist/Canvas tasks (Phase 3) — not yet designed.
