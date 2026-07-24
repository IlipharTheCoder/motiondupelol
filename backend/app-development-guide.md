# App Development Guide — building the Mac/iOS client

Synthesizes `architecture-plan.md`, `backend-schema.md`, and `backend-api-reference.md` into the guiding principles and building blocks available when building the Xcode client. This doc doesn't replace those three — it's the map that tells you which of them to open for detail. Field-by-field request/response shapes live in `backend-api-reference.md`; table columns and constraints live in `backend-schema.md`; the "why," across every feature, lives in `architecture-plan.md`.

---

## 1. The mental model

**The app is a thin display/approval client. The backend holds all state, all logic, and all secrets.** Concretely:

- The app never talks to Google Calendar or Claude directly — only to this backend, over REST/JSON.
- The app holds exactly one credential: `APP_SECRET_KEY`, sent as an `x-api-key` header on every request (`lib/auth.ts`'s `isAuthorized`). Every route except `GET /api/health` requires it. This key authenticates the app to the backend and nothing else — lower-stakes than a Google/Claude credential if it ever leaks, and trivially rotatable.
- There is **one system of record for calendar events**: the burner Google Calendar. Everything else (tasks, habits, scheduling rules, the review queue, chat history, capability requests) lives in Supabase. The app never needs to reconcile two sources of truth for the same thing.
- **The app does not compute scheduling logic locally.** Don't calculate free slots, conflicts, or priority ordering on-device — call the backend (`GET /api/calendar/free-slots`, `GET /api/calendar/conflicts`, `GET /api/tasks/next`, etc.) and render what it returns. The backend's algorithms (working-hours windows, scheduling-rule narrowing, priority-tier-then-urgency ranking) are the single source of truth; a local reimplementation would drift.

---

## 2. The core interaction pattern: propose → review → apply

This is the one idea that shapes almost every screen the app will need.

**Nothing writes to the calendar directly.** Every scheduling feature — auto-reschedule, rebalance, task/habit auto-placement, focus/buffer time, bulk-edit, recurring series, relocate, and the chat layer — produces rows in `proposed_changes` instead of calling the Calendar API itself. The app's job is to **surface that queue and let the user decide**. This is the human-in-the-loop step the whole system is built around (`architecture-plan.md` §3, the "Normal Loop").

**A proposal is a 4-state machine** (`backend-schema.md`'s `proposed_changes`): `pending → applied | rejected | failed`. There's deliberately no separate "approved" state — applying happens synchronously in the same request as the approve call, so nothing sits in an in-between state. A `failed` row (a conflict, a scheduling-rule violation) can be retried via the same approve call, or rejected.

**Some things skip the queue entirely — "declarations," not calendar writes:**
- `tasks`, `habits`, `scheduling_rules`, `capability_requests` are all direct-insert (`POST /api/tasks`, `POST /api/habits`, `POST /api/scheduling-rules`, `POST /api/capability-requests`). Declaring a task, a habit goal, a standing rule, or a capability gap isn't touching the calendar — only *placing* a task/habit onto the calendar (a separate `schedule`/`plan` call) goes through `proposed_changes`.
- None of `habits`/`scheduling_rules` have a delete route — an inactive/paused state (`status: 'paused'`, `active: false`) is the removal mechanism. Design the app's UI around "pause" and "resume," not "delete."

**`AUTO_APPLY_CATEGORIES` means a proposal can arrive already `applied`.** A whitelisted category (env-configured, empty by default — nothing auto-applies today) skips the pending state entirely: the response from whatever created it already shows `status: "applied"`. **The app must not assume every write it triggers needs an approval tap** — check the returned `status`, don't hardcode "pending" as the only outcome.

**Batches and groups** (`proposal_group_id`) — anything that naturally produces more than one proposal at once (`propose_batch`, `bulk_edit`, `create_recurring_series`) shares a `group_id`. The app should offer "approve all / reject all" for a group (`POST /api/proposed-changes/batch/{groupId}/approve|reject`), not force the user through N individual taps. `GET /api/proposed-changes?group_id=...` fetches just that set.

**Undo is a two-step chain, not a button.** `POST /api/proposed-changes/{id}/revert` only *creates* a compensating proposal (still `pending`) — it doesn't apply it. A one-tap "Undo" button in the app should call revert, then immediately approve the id it returns, and only then tell the user it's undone.

---

## 3. Two front doors, same underlying primitives

The app can drive the backend two ways, and they produce **identical** results — the review queue doesn't know or care which one created a row:

1. **Direct structured calls** — the app's own UI (a "new task" form, a "propose a move" gesture, a settings screen for scheduling rules) calls the specific REST endpoint for that action.
2. **`POST /api/chat`** — free text in, and the backend runs an agentic loop (`claude-haiku-4-5`, capped at 6 tool-calling iterations) that maps the request onto the same ~31 tools/endpoints Section 5 lists. A chat-originated proposal is a completely ordinary `proposed_changes` row — the review-queue screen doesn't need a special code path for it.

**Chat request/response shape** (`backend-api-reference.md`'s `POST /api/chat`):
```json
// request
{ "message": "string", "conversation_id": "uuid (optional)" }

// response
{
  "conversation_id": "uuid",
  "reply": "string",
  "proposals": [ /* ProposedChangeRow[] created this turn */ ],
  "group_id": "string (optional)",
  "clarification": "string (optional) — present only if the model asked a clarifying question instead of acting"
}
```
An unrecognized/stale `conversation_id` silently starts a fresh conversation rather than erroring — safe for the app to always send whatever id it last cached, even across app restarts or a backend redeploy. **Nothing from chat auto-applies** (confirmed v1 posture) — every chat-created proposal needs the same review-queue tap as anything else, regardless of how directly the user phrased the request.

---

## 4. The data model — what the app renders

### Calendar events (the burner calendar itself)
Returned by `GET /api/calendar/events` and embedded in every proposal. Metadata beyond Google's native fields is decoded from `extendedProperties.private` (`lib/eventMetadata.ts`):

| Field | Values | Notes |
|---|---|---|
| `category` | `task \| habit \| focusTime \| meeting \| fixed \| buffer \| personal` | Drives the derived `colorTag` — never freely chosen |
| `priority` | `critical \| high \| medium \| low` | How the user actually thinks about importance — not numeric |
| `flexible` | `"true" \| "false"` | Whether auto-reschedule/rebalance/bump is allowed to move it |
| `deadline` | ISO datetime or `null` | A "must be done by" constraint, independent of the event's actual `start`/`end` |
| `tags` | `string[]` | Freely user-defined, always lowercase-normalized |
| `origin.sourceSystem` | `todoist \| canvas \| google \| manual \| ai-engine` | Where it came from |
| `colorTag` | hex string | Always derived from `category`, never independently set |

**All-day events (`start.date`, no `start.dateTime`) never count as busy time anywhere** — they're notes (birthdays, multi-day markers), not scheduled blocks. They still show up in a raw `GET /api/calendar/events` listing; they just never appear as a conflict or block a free-slot search. Don't render a `priority` for one — it's not meaningful for an all-day entry.

### `proposed_changes` — the review queue row shape
The app will render this constantly (approve/reject screens, chat responses' `proposals` array). Key fields beyond the calendar-event ones above: `change_type` (`create \| move \| update \| delete`), `status` (`pending \| applied \| rejected \| failed`), `reason` (human-readable justification, often chat-generated), `error_message` (populated on `failed`), `previous_state` (populated once `applied`, used by revert), `proposal_group_id`. `lib/proposedChanges.ts`'s `describeProposalOutcome` gives a ready-made plain-language string per status (`"Awaiting approval."` / `"Change applied to the calendar."` / etc.) — the API returns this as `message` on most proposal-mutating endpoints; use it directly rather than re-deriving status text in the app.

### Tasks, Habits, Scheduling Rules, Capability Requests
Each is its own small table, independent of calendar events until explicitly scheduled/placed:
- **`tasks`** — one-off items with a single `deadline`. `status`: `unscheduled → scheduled → completed/discarded`. `scheduled_event_id` links to the calendar event once placed.
- **`habits`** — recurring occurrence-count goals ("gym 3x/week"). `status`: `active`/`paused`. `cadence`: `weekly`/`monthly`/`daily`/`interval`.
- **`scheduling_rules`** — standing time-of-day/weekday constraints ("never before 9am on weekdays"), scoped to a category, a tag, or global. `active`: boolean, no delete.
- **`capability_requests`** — the backlog of "asked for X, nothing covers it," mostly populated by the chat layer's `log_capability_gap` fallback. `status`: `open → planned → built/wontfix`. Worth its own small triage screen if you want visibility into what the NL layer keeps failing to do.

### Chat history
`chat_conversations`/`chat_messages` — lightweight, text-only. The app just needs to persist/display `conversation_id` and pass it back on the next `/api/chat` call to continue a thread; there's no separate "fetch conversation" endpoint to build a chat-history screen against yet (would be a natural, currently-unbuilt addition — a capability-request candidate itself).

---

## 5. Building blocks — API surface map

Grouped by what a screen would call it for. Full request/response shapes are in `backend-api-reference.md`; look up the endpoint there by name.

| Area | Endpoints | What it's for |
|---|---|---|
| **Calendar view** | `GET /api/calendar/events`, `GET /api/calendar/free-slots`, `GET /api/calendar/conflicts` | Render the calendar, check availability, diagnose an overlap |
| **Review queue** | `GET/POST /api/proposed-changes`, `POST .../{id}/approve\|reject\|revert`, `PATCH /api/proposed-changes/{id}`, `POST /api/proposed-changes/batch`, `POST .../batch/{groupId}/approve\|reject` | The central approve/reject screen — single rows and groups |
| **Direct calendar actions** | `POST /api/calendar/events/{id}/relocate`, `POST /api/calendar/bulk-edit`, `POST /api/calendar/recurring`, `POST /api/calendar/reschedule`, `POST /api/calendar/rebalance` | "Move this," "edit all matching X," "set up a recurring series," conflict/overload cleanup — all produce ordinary proposals |
| **Tasks** | `GET/POST /api/tasks`, `POST /api/tasks/{id}/schedule`, `GET /api/tasks/next`, `POST /api/tasks/plan` | Task list CRUD, giving a task a calendar slot (manually or auto), "what should I work on next" |
| **Habits** | `GET/POST /api/habits`, `PATCH /api/habits/{id}`, `POST /api/habits/plan` | Habit CRUD (create/pause/resume), the occurrence-placement engine |
| **Focus Time** | `POST /api/focus-time/plan`, `GET /api/focus-time/stats`, `POST /api/focus-time/suggest` | Weekly deep-work goal auto-fill, the Deep Work Index stat, on-demand "find me a block" |
| **Buffer Time** | `POST /api/buffer-time/plan` | Travel/prep/follow-up padding around existing events |
| **Scheduling Rules** | `GET/POST /api/scheduling-rules`, `PATCH /api/scheduling-rules/{id}` | The standing-constraints settings screen |
| **Capability backlog** | `GET/POST /api/capability-requests`, `PATCH /api/capability-requests/{id}` | Triage view for gaps the NL layer surfaced |
| **Chat** | `POST /api/chat` | The conversational front door — see Section 3 |
| **Sync (background/manual trigger)** | `POST /api/calendar/sync`, `POST /api/calendar/sync/dedupe`, `POST /api/todoist/sync` | Pull external calendars/Todoist in — nothing runs on a schedule yet, so a "sync now" affordance (or the app calling this on launch/refresh) is how these actually fire |
| **Inbox (legacy/lower priority)** | `GET/POST /api/inbox`, `PATCH /api/inbox/{id}` | Plain-text quick capture; the screenshot-parsing half (`POST /api/capture`) is **not implemented** — don't build a screenshot-clipper UI against it yet |

---

## 6. Conventions to follow

- **Auth:** `x-api-key: <APP_SECRET_KEY>` header on every call except `/api/health`. Store the key in a gitignored `Secrets.swift`, never commit it.
- **Errors:** always `{ "error": "message" }` with a real HTTP status — `401` (bad/missing key), `400` (validation), `404` (unknown id), `409` (wrong state for the action, e.g. approving an already-applied row), `500` (upstream/Supabase/Google failure). Render `error` directly; the messages are written to be human-readable.
- **Timestamps:** ISO 8601 datetimes throughout; `HOME_TIMEZONE` (backend-configured, default `America/New_York`) governs what "9am" or "this week" means for anything time-of-day-based (working hours, scheduling rules, bulk-edit's `starts_after`/`starts_before`). The app doesn't need to know this value to function — just always send/receive full ISO datetimes, never bare times, and let the backend resolve locality.
- **Range params:** every range-taking endpoint uses explicit `from`/`to` ISO timestamps — there's no `today`/`tomorrow`/`this week` shorthand anywhere in the API. If you want "Today" or "This Week" buttons, compute the matching `from`/`to` in the app before calling.
- **Tags:** always lowercase, trimmed, deduped — the backend normalizes on write (`normalizeTags()`), but don't rely on that to clean up a mixed-case display list; treat tags as case-insensitive in the app's own UI too.
- **Casing gotcha to know about:** database-row responses (`proposed_changes`, `scheduling_rules`, `tasks`, `habits`) are snake_case throughout, even in JSON responses. Purpose-built summary objects (bulk-edit, batch, recurring-series, relocate results) are camelCase at the top level — and bulk-edit's own result is a mixed case, camelCase on top with a snake_case nested `filters` echo. Don't assume one convention across the whole API surface.
- **Polling, not push:** nothing in this backend runs on a schedule (no cron, no webhooks) as of this writing. If the app wants "fresh" data, it calls the relevant `GET`/sync endpoint itself — pull-to-refresh, not a live feed.

---

## 7. What's not there yet — don't build against it

- **`POST /api/capture`** (screenshot → Claude vision → inbox item) is documented as intended behavior but the route doesn't exist in the codebase at all. Don't wire up a capture UI expecting it to work.
- **No delete on `habits`/`scheduling_rules`** — only pause (`status`/`active` flags). Don't design a swipe-to-delete for these; swipe-to-pause instead.
- **No chat-history listing endpoint** — the app can continue a conversation via `conversation_id` but can't yet fetch a list of past conversations or replay one from a fresh app install.
- **No task session-splitting** — a task too big for any single free opening fails placement with a message saying so, rather than splitting across multiple blocks.
- **No cross-feature arbitration ("AI Planner")** — Tasks/Habits/Focus Time/Buffers each plan independently against shared calendar state; there's no single orchestrator resolving them against each other in one pass.
- **Canvas sync is on hiatus** — code exists but is unverified/non-functional pending API access; don't surface it as a working sync source in the UI yet.
- **Weekly time-spend reports and follow-up reminder notifications** are unbuilt (Phase 4, lower priority).

For the full, current list with reasoning, see `backend-api-reference.md`'s "Not yet built" section and `backend-build-order.md`.
