# Field-name casing across tool results

This backend does not use one uniform casing convention. Get this wrong and a
tool call will look successful but read back the wrong field as `undefined`.

**Database rows are snake_case throughout, including in responses**: this
covers every result shaped like a `proposed_changes`, `scheduling_rules`,
`tasks`, or `habits` row — e.g. `proposed_start`, `target_event_id`,
`starts_after`, `duration_minutes`, `proposal_group_id`.

**Purpose-built summary objects are camelCase at the top level**: the results
of `bulk_edit`, `propose_batch`, `create_recurring_series`, `relocate_event`,
`approve_proposal_group`/`reject_proposal_group`, and the various `plan_*`
tools all use top-level keys like `rangeStart`, `rangeEnd`, `proposalsCreated`,
`eventsMatched`, `groupId`, `skippedErrors`.

**The one mixed case to watch for — `bulk_edit`'s result**: the top level is
camelCase (`rangeStart`, `eventsMatched`, `proposalsCreated`), but the nested
`filters` echo object inside it is snake_case, matching the request fields
exactly: `filters.starts_after`, `filters.priority_in`, `filters.category`,
`filters.summary_contains`, `filters.exclude_event_ids`. There is no
`filters.startsAfter` — do not guess a camelCase variant here.

**`get_calendar_events` results** use a hybrid shape inherited from the
Google Calendar API itself: `htmlLink` (camelCase, from Google) alongside
`colorTag`/`sourceSystem`/`sourceLabel` (this backend's own derived fields,
also camelCase) and `start`/`end` sub-objects shaped like Google's own
`{dateTime}` or `{date}` (all-day) — not a flat ISO string.
