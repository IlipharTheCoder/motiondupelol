# NL Layer — Implementation Spec

How the chat layer is structured, what context each request carries, and what reference material the model can reach for.

**Written against `backend-api-reference.md` as of 2026-07-24**, including Phase 3.5 items 27–32 (batch proposals, revert, bulk-edit filters, scheduling rules, relocate, recurring weekdays/skip-dates). Four of the gaps this spec previously worked around no longer exist.

---

# Part 1 — Architecture of the NL request loop

## Where it lives

One new endpoint: **`POST /api/chat`**. It owns the agentic loop and is the only place the Anthropic SDK is imported. The Mac/iOS client posts a message and gets back a reply plus resulting proposal IDs — it never sees tool calls or reasoning.

```
POST /api/chat
  body: { message: string, conversation_id?: string }
  → returns: { reply: string, proposals: [...], group_id?: string, clarification?: {...} }
```

## The loop

```
1. Build context block (Part 2)
2. Call Claude with tools + context + conversation history
3. Model returns tool_use blocks → execute against internal lib/ functions
4. Feed tool_result back → repeat
5. Stop when model emits text-only, asks a clarifying question,
   or hits the iteration cap
6. Return reply + any proposals created
```

**Iteration cap: 6.** With batch proposals and filtered bulk-edit now available, no test case needs more than ~3 calls. Past 6, stop and return what happened rather than letting it spin.

**Call internal functions, not HTTP.** Every endpoint's logic lives in `lib/` (`lib/proposedChanges.ts`, `lib/aiTasks.ts`, `lib/focusTime.ts`, `lib/freeSlots.ts`…). Tool handlers should call those directly — an HTTP round-trip from Vercel back to itself burns `maxDuration` and adds a failure mode for nothing. The tool *schema* mirrors the endpoints; the *implementation* skips the network.

## Tool surface

~24 tools, each mapping 1:1 to an existing endpoint. The 1:1 mapping makes wrong-tool errors obvious in eval and lets schemas be regenerated from the API reference when endpoints change.

### Read (safe, no side effects)

| Tool | Endpoint | Notes |
|---|---|---|
| `get_events` | `GET /api/calendar/events` | `q` is fuzzy full-text — good for "the dentist thing", not guaranteed unique |
| `find_free_slots` | `GET /api/calendar/free-slots` | **Rule-aware** — already respects active `scheduling_rules` and working hours |
| `check_conflicts` | `GET /api/calendar/conflicts` | Pure overlap; ignores working hours *and* rules |
| `get_tasks` | `GET /api/tasks` | |
| `get_next_tasks` | `GET /api/tasks/next` | Already sorted by priority + deadline — model must not re-sort |
| `get_habits` | `GET /api/habits` | |
| `get_scheduling_rules` | `GET /api/scheduling-rules` | **New** — check before proposing an explicit time |
| `get_proposed_changes` | `GET /api/proposed-changes` | Needed for undo |
| `get_focus_stats` | `GET /api/focus-time/stats` | |

### Propose (writes to review queue)

| Tool | Endpoint | Notes |
|---|---|---|
| `propose_change` | `POST /api/proposed-changes` | Single create/move/update/delete, plus the task-list-intake shape |
| `propose_batch` | `POST /api/proposed-changes/batch` | **New** — up to 50 proposals, one shared `groupId`. Use whenever N > 1 |
| `propose_recurring` | `POST /api/calendar/recurring` | Weekly cadence; now supports `weekdays[]` and `skip_dates[]` |
| `bulk_edit` | `POST /api/calendar/bulk-edit` | **No longer tag-only** — filters by category, priority, time-of-day, summary, exclusions |
| `relocate_event` | `POST /api/calendar/events/{id}/relocate` | **New** — one call for "move this specific thing to wherever's free" |
| `rebalance_day` | `POST /api/calendar/rebalance` | Reduce a window's total load |
| `reschedule_conflicts` | `POST /api/calendar/reschedule` | Fix existing overlaps |
| `suggest_focus_time` | `POST /api/focus-time/suggest` | Creates N competing proposals — approve one, reject the rest |
| `plan_buffers` | `POST /api/buffer-time/plan` | Requires a `location` on the trigger event for travel buffers |
| `plan_tasks` / `plan_habits` / `plan_focus_week` | the three `/plan` endpoints | Heavy/bulk — only for explicit "plan my week" asks |

### Direct write (bypasses queue by design)

| Tool | Endpoint | Notes |
|---|---|---|
| `create_task` | `POST /api/tasks` | A stated task isn't unreviewed external data |
| `create_habit` | `POST /api/habits` | A habit is a goal declaration, not a calendar write |
| `create_scheduling_rule` | `POST /api/scheduling-rules` | **New** — a standing policy, same reasoning |
| `update_scheduling_rule` | `PATCH /api/scheduling-rules/{id}` | `active: false` is the pause/delete mechanism |
| `schedule_task` | `POST /api/tasks/{id}/schedule` | |
| `update_proposal` | `PATCH /api/proposed-changes/{id}` | Set priority/tags before approval |
| `reject_proposal` | `POST /api/proposed-changes/{id}/reject` | Undo primitive for *pending* |
| `reject_proposal_group` | `POST /api/proposed-changes/batch/{groupId}/reject` | **New** — undo a whole batch |
| `revert_proposal` | `POST /api/proposed-changes/{id}/revert` | **New** — undo primitive for *applied* |

### Meta

| Tool | Backing | Notes |
|---|---|---|
| `ask_clarifying_question` | none — returned to client | First-class outcome, renders as tappable options |
| `log_capability_gap` | `POST /api/capability-requests` | Fallback when nothing fits |

**Do not expose:** `POST /api/capture` (not implemented), `POST /api/canvas/sync` (non-functional pending school API access), `POST /api/calendar/sync/dedupe` (maintenance), and critically **both approve endpoints** (`/{id}/approve`, `/batch/{groupId}/approve`) — the model proposing *and* approving defeats the entire review-queue design. Reject/revert are exposed because undoing is not the same as authorizing.

## Undo, concretely

Three shapes now, all real:

- **Still `pending`, single** → `get_proposed_changes(status: pending)` → `reject_proposal(id)`
- **Still `pending`, a batch** → `reject_proposal_group(groupId)` — one call
- **Already `applied`** → `revert_proposal(id)` builds a compensating change from the `previous_state` snapshot. **This is a two-call shape**: revert creates a new `pending` row, which the *user* then approves. The model must not treat revert as done — it should tell the user there's a revert awaiting approval.

`revert` returns `409` if the proposal isn't `applied`, or was applied before `previous_state` existed. Keep the last ~5 actions with their proposal/group IDs in conversation state, or "undo that" has nothing to resolve against.

## Scheduling rules change how the model should propose

Rules are enforced in **two** places, and the distinction matters:

1. **Search-time** — `find_free_slots` (and every planner built on it) never offers a rule-violating slot.
2. **Write-time** — a `create`/`move` with an explicit time is checked against active rules at apply time, and **fails like a conflict** if it violates one.

So: **prefer `find_free_slots` over picking a time.** A slot from the search is guaranteed compliant; a time the model reasons its way to can fail on approval, which surfaces to the user as a broken promise.

`ignore_scheduling_rules: true` exists as a deliberate per-write override. **Only set it when the user explicitly signals override** ("schedule it anyway", "I know it's early, do it") — never to route around a failure the model caused itself. Note it's independent of `bump_if_movable`: a rule violation is never bumpable, because the time itself is disallowed regardless of what's occupying it.

## Batch is the default for N > 1

Any request producing more than one proposal should use `propose_batch`, not N × `propose_change`. Beyond the inference savings, the shared `groupId` is what lets the app render one approval card and lets `reject_proposal_group` undo the whole thing. Cap is 50 per call; one item failing doesn't abort the rest (failures come back as `skipped-error` entries).

Prefer `bulk_edit` over `propose_batch` when the selection is expressible as a filter — it does the matching server-side, so the model never has to enumerate event IDs at all.

## Auto-apply: still an open decision

`backend-api-reference.md`'s "Not yet built" still flags item 20 — `AUTO_APPLY_CATEGORIES` keys on `category` only, not `source_system`. **Every calendar change the NL layer proposes needs a manual approval tap.**

Unchanged recommendation: don't build source-system-aware auto-apply. Surface the pending proposal inline in the chat response with an approve button — zero backend work, review-queue guarantee fully intact. With batch groups this is now *better* than it was: twelve changes render as one card with one button, not twelve.

---

# Part 2 — Context to pair with each request

Prepended to every request. **Put it in a cacheable prefix** — tool schemas, config, and rules are stable across turns, so prompt caching cuts the repeated portion ~90%.

## 2.1 Resolved time anchors — the load-bearing piece

Every range-taking endpoint needs absolute ISO datetimes and accepts **no shorthand**. Precompute the anchors so the model never does date arithmetic:

```
CURRENT TIME
now: 2026-07-24T14:32:00-04:00
timezone: America/New_York
weekday: Thursday

RESOLVED RANGES (use these directly — do not compute your own)
today:          2026-07-24T00:00:00-04:00 → 2026-07-25T00:00:00-04:00
tomorrow:       2026-07-25T00:00:00-04:00 → 2026-07-26T00:00:00-04:00
rest_of_today:  2026-07-24T14:32:00-04:00 → 2026-07-25T00:00:00-04:00
this_week:      2026-07-20T00:00:00-04:00 → 2026-07-27T00:00:00-04:00
next_week:      2026-07-27T00:00:00-04:00 → 2026-08-03T00:00:00-04:00
this_month:     2026-07-01T00:00:00-04:00 → 2026-08-01T00:00:00-04:00
next_14_days:   2026-07-24T14:32:00-04:00 → 2026-08-07T14:32:00-04:00

NAMED WEEKDAYS (next occurrence)
monday: 2026-07-27 · tuesday: 2026-07-28 · wednesday: 2026-07-29
thursday: 2026-07-30 · friday: 2026-07-31 · saturday: 2026-07-25 · sunday: 2026-07-26

WEEKDAY NUMBERS (for weekdays[] params — 1=Mon..7=Sun)
mon=1 tue=2 wed=3 thu=4 fri=5 sat=6 sun=7
```

The weekday-number line is new and matters: both `propose_recurring` and `create_scheduling_rule` take `weekdays` as integers, and off-by-one on Monday-vs-Sunday indexing is a classic silent failure.

## 2.2 Scheduling config

```
working_hours: 10:00–18:00, Mon–Fri (HOME_TIMEZONE America/New_York)
focus_time_weekly_goal: 600 min · default block: 90 min
buffer: travel 30 / prep 15 / followup 15 min
task_default_duration: 60 min · habit_default_occurrence: 45 min
auto_apply_categories: (whatever AUTO_APPLY_CATEGORIES holds — usually empty)
```

Read from `lib/schedulingConfig.ts` at request time — these are env-driven and will drift.

## 2.3 Active scheduling rules — new, and required

Rules now fail writes, so the model needs to see them to avoid proposing something that will be rejected at approval time:

```
ACTIVE SCHEDULING RULES
- "No early mornings" — global, starts_after 09:00, weekdays [1,2,3,4,5]
- "Gym mornings only" — tag:gym, starts_before 10:00, all days
- "No late meetings" — category:meeting, starts_before 17:00, weekdays [1,2,3,4,5]
```

Rules AND-intersect: every matching rule narrows the allowed window further, never widens it. Include this even when empty (`ACTIVE SCHEDULING RULES: none`) so the model doesn't call `get_scheduling_rules` defensively on every turn.

## 2.4 Enums

```
category: task | habit | focusTime | meeting | fixed | buffer | personal
priority: critical | high | medium | low
change_type: create | move | update | delete
habit cadence: weekly | monthly | daily | interval
proposal status: pending | applied | rejected | failed
```

## 2.5 Calendar digest

A compact ±7 day view — enough to answer "what's my day look like" and resolve references like "the dentist thing" without a tool call:

```
Thu Jul 24: 09:00–09:30 Standup (meeting, critical, fixed) [id: abc123]
            13:00–14:00 Dentist (meeting, critical, fixed) @ 400 Market St [id: def456]
            15:00–17:00 Deep work (focusTime, high, flexible) [id: ghi789]
Fri Jul 25: 11:00–12:00 Client sync — Acme (meeting, critical, fixed) [id: jkl012]
            14:00–15:00 Client sync — Bolt (meeting, critical, fixed) [id: mno345]
```

Include `id` inline so events can be referenced in tool calls without a lookup round-trip — this is what makes `relocate_event` and `exclude_event_ids` usable in a single turn. Cap it; if dense, truncate and note that `get_events` exists.

The digest is also what makes disambiguation possible — "cancel the meeting with the client" is only answerable as a clarification because both Acme and Bolt are visible here.

## 2.6 Open state

```
pending_proposals: 3 (ids: abc, def, ghi)
pending_groups: 1 (groupId: xyz — 12 rows, "move everything after 3pm")
unscheduled_tasks: 7
active_habits: 4
recent_actions:
  1. [2m ago] created group xyz — 12 move proposals
  2. [8m ago] applied proposal abc — "Deep work" Fri 09:00–11:00
```

Tracking `pending_groups` separately is what lets "undo that" resolve to `reject_proposal_group` rather than twelve individual rejects. Recording whether an action was *applied* vs *created* is what decides between `revert_proposal` and `reject_proposal`.

## 2.7 Behavioral rules for the system prompt

- **Never compute dates yourself** — use the resolved anchors. For offsets ("in 5 days"), add to a stated anchor.
- **Never sort or rank** — `get_next_tasks` and `rebalance_day` implement the ranking. Don't re-order their output.
- **Never approve proposals.** Creating is your job; approving is the user's. This includes after a revert.
- **Prefer `find_free_slots` over choosing a time** — search results are rule-compliant by construction; reasoned-to times can fail at write time.
- **Use `bulk_edit` when the selection is a filter; `propose_batch` when it's an enumerated list; `propose_change` only for a genuine single change.**
- **`ignore_scheduling_rules` requires explicit user override language.** Never set it to route around your own failure.
- **State assumptions in `reason`** — every proposal takes one. Put the guess there ("assumed 1 hour; you didn't specify"). The user sees it at review time, which is why guessing usually beats asking.
- **When nothing fits, call `log_capability_gap`** and say so plainly. Don't approximate with a wrong-shaped tool.

---

# Part 3 — Documents the NL layer can reach for

**Don't put the API reference in the system prompt.** It's now 87KB (~22k tokens) and would be re-sent every turn. Progressive disclosure instead.

## Always loaded (~1.8k tokens)

**`docs/nl-tool-manifest.md`** — one line per tool: name, one-sentence purpose, required params, and "use when / don't use when" for the confusable pairs. Generate it from the API reference so it can't drift.

The disambiguations that actually matter:

- `propose_batch` vs `bulk_edit` — batch takes an explicit list you've already enumerated; bulk_edit matches server-side by filter. **Prefer bulk_edit** when the selection is describable as a filter, since you never have to list IDs.
- `propose_recurring` vs `create_habit` — recurring creates fixed occurrences at a known time; habits are cadence-driven with flexible placement the engine chooses.
- `relocate_event` vs `propose_change(move)` — relocate finds the slot for you; move requires you to already know the target time.
- `rebalance_day` vs `reschedule_conflicts` — rebalance reduces load; reschedule fixes actual overlaps.
- `revert_proposal` vs `reject_proposal` — revert undoes *applied*; reject cancels *pending*.
- `create_scheduling_rule` vs per-request constraints — a rule is permanent and applies to every future search; a constraint on one request is just params.
- `suggest_focus_time` vs `plan_focus_week` — on-demand options vs weekly-goal auto-fill.

## Fetchable on demand

One tool: **`read_reference(topic)`**, returning a pre-chunked section under `docs/nl-reference/`:

| Topic | Contents |
|---|---|
| `proposed-changes` | Full body shape, task-intake shape, `bump_if_movable`, `ignore_scheduling_rules` |
| `batch` | Batch shape, the 50 cap, group approve/reject semantics |
| `revert` | Per-`change_type` compensating behavior, the two-call shape, `409` conditions |
| `bulk-edit` | Filter composition, `priority_in` vs `priority`, time-of-day semantics |
| `recurring` | `weekdays`, `skip_dates`, series tags, `count`/`until`, the 260 ceiling |
| `scheduling-rules` | Scope exclusivity, AND-intersection, search-time vs write-time enforcement |
| `tasks` / `habits` | Lifecycles, the two `schedule` shapes, cadence types |
| `metadata` | Category/priority enums, `extendedProperties` encoding, what `flexible` means |
| `limitations` | What genuinely cannot be done — below |

## The `limitations` doc — substantially shorter now

Four previous entries are **no longer limitations** and must be deleted, or the model will refuse things it can now do:

- ~~No standing rules~~ → `create_scheduling_rule` exists
- ~~`bulk_edit` is tag-only~~ → filters by category, priority, time-of-day, summary, exclusions
- ~~No undo of applied changes~~ → `revert_proposal` exists
- ~~Recurring is single-weekday with no exceptions~~ → `weekdays[]` and `skip_dates[]` exist

**Still genuinely unsupported:**

- **No task dependencies.** No `depends_on` anywhere. "After I've submitted the budget review" can't be expressed — propose without the dependency and say so, or log the gap.
- **No session-splitting.** A task larger than any single opening is skipped.
- **No per-habit time-of-day windows natively** — but see the workaround below, which covers most real cases.
- **No timezone/travel awareness beyond `HOME_TIMEZONE`.** No landing-event concept; overnight time-of-day windows (after 10pm *or* before 6am) can't be expressed in one rule.
- **Canvas sync is non-functional** pending school API access.
- **`q` search is fuzzy, not exact.** Multiple matches are normal — that's the disambiguation trigger.
- **`move` + tag-scoped rules is a known v1 gap** — the rule check matches the proposal's own `tags`, not the target event's current tags.

## The workaround worth documenting prominently

**Tag-scoped rules give you per-habit time windows.** Habits carry `tags`, and `scheduling_rules` can scope by `tag`. So "gym every day before 10am" — which has no native per-habit window — is:

```
create_habit(title: "Gym", cadence: "daily", target_count: 1, tags: ["gym"])
create_scheduling_rule(tag: "gym", starts_before: "10:00", name: "Gym mornings only")
```

Two calls, fully supported, permanent. This should be in the manifest as an explicit pattern, not left for the model to derive — it's the kind of composition that's obvious in hindsight and easy to miss in the moment.

---

# Part 4 — Lookups like sunset times

**Yes, and it costs nothing — but not via web search.**

## Sunset/sunrise is pure math

Solar position is deterministic from latitude, longitude, and date. `suncalc` (~2KB, zero dependencies, no key, no network) computes sunrise, sunset, golden hour, dusk, dawn, and solar noon offline in microseconds.

Same principle as everything else here: **deterministic means engine, not model.**

```
get_daylight(date) → { sunrise, sunset, civilDusk, solarNoon }
```

Zero cost, no latency, exact. And it composes: "schedule my run before sunset tomorrow" → `get_daylight` → `find_free_slots` with the resolved bound → `propose_change`.

Same category, same answer: moon phase, day length, week numbers, business-day math, holiday calendars (static list).

## Weather is dynamic but still cheap

Genuinely needs a network call, but **Open-Meteo is free and keyless**, making `get_weather(date, location)` nearly as cheap. Worth adding for "don't schedule my run when it's raining," and a natural pairing with daylight.

## Web search: still skip it

- **Costs per search** on top of tokens, unlike both options above
- **Adds seconds of latency** to a chat that should feel immediate
- **Unbounded scope** — once search exists, the model reaches for it on anything, and you've built a general assistant instead of a calendar manager

Almost every fact this assistant needs is deterministic (dates, daylight, durations) or already in your own data. The narrow exceptions are better served by one purpose-built free API than by general search. If you later want travel-time-aware scheduling, that's a Distance Matrix call — a specific tool with a specific purpose. Still not search.

---

# Appendix — Test case coverage

Where the 20 cases stand against the current surface.

| # | Case | Status | Path |
|---|---|---|---|
| 1 | Gym daily before 10am | ✅ | `create_habit` + tag-scoped `create_scheduling_rule` |
| 2 | Every other Tuesday, skip last week | ✅ | `propose_recurring` with `interval_weeks: 2` + `skip_dates` |
| 3 | Doctor in 5 days | ✅ | `find_free_slots` → `propose_change` |
| 4 | Push dentist to next week | ✅ | `get_events(q)` → `relocate_event` — 2 calls |
| 5 | Rest after critical tasks | ⚠️ | No dependencies — propose without, or `log_capability_gap` |
| 6 | Lighten tomorrow | ✅ | `ask_clarifying_question` → `rebalance_day` |
| 7 | 1hr with Sarah Thursday (full) | ✅ | `find_free_slots` → propose alternatives |
| 8 | Move everything after 3pm | ✅ | `bulk_edit(starts_after: "15:00", action: move)` — 1 call |
| 9 | Never before 9am on weekdays | ✅ | `create_scheduling_rule(starts_after: "09:00", weekdays: [1,2,3,4,5])` |
| 10 | Cancel meetings except manager | ✅ | `bulk_edit(category: ["meeting"], exclude_event_ids: [...])` |
| 11 | 3hrs for Q3 after budget review | ⚠️ | Duration/placement fine; dependency not expressible |
| 12 | Reschedule lowest priority Friday | ✅ | `rebalance_day` |
| 13 | Coffee with Alex, nothing too early | ✅ | `find_free_slots` with bound, or a permanent rule |
| 14 | Reminder before my flight | ✅ | `get_events(q: "flight")` → `propose_change` |
| 15 | MWF gym, other days a walk | ✅ | 2 × `propose_recurring` with `weekdays: [1,3,5]` / `[2,4,6,7]` |
| 16 | Travel time around dentist | ⚠️ | `plan_buffers` works but duration is env-global, not per-request |
| 17 | Cancel the client meeting (2 exist) | ✅ | `ask_clarifying_question` from digest |
| 18 | Undo that | ✅ | `revert_proposal` / `reject_proposal` / `reject_proposal_group` |
| 19 | Quick vendor call before lunch | ✅ | `find_free_slots` → `propose_change` |
| 20 | Land NYC 6pm, block 2hrs after | ⚠️ | Works if the landing event exists; no timezone/travel awareness |

**16 of 20 fully supported, 4 partial.** The remaining gaps cluster into exactly two features — task dependencies (#5, #11) and per-request/travel-aware buffers (#16, #20) — which is a clean backlog rather than scattered holes.
