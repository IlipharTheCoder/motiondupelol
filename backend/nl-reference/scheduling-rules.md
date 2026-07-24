# Scheduling rules — how they actually apply

A scheduling rule narrows *when* something is allowed to start; it does not
say what to do about existing events already outside the window.

**Scope is exclusive**: a rule targets a `category`, OR a `tag`, OR neither
(global, applies to everything) — never a category and a tag together. Use
two separate rules if you need both.

**Rules only ever narrow, never widen**: when more than one active rule
applies to the same category/tag/weekday, their windows AND-intersect. There
is no way for one rule to carve out an exception to another — if the user
wants an exception, the correct action is `ignore_scheduling_rules: true` on
the specific write, or narrowing/pausing the rule itself
(`update_scheduling_rule` with `active: false`), not adding a second rule
hoping it "overrides" the first.

**Enforcement happens in two places**: at *search time* (`get_free_slots` and
every planning tool that calls it internally, like `plan_tasks` or
`relocate_event`) rules narrow the working-hours window before free slots are
computed — so a search-based tool naturally avoids proposing something that
violates a rule. At *write time* (approving any `create`/`move` proposal),
the exact same rules are checked again as a hard gate — this is what actually
blocks a manually-specified time that a search tool never got a chance to
filter out. `ignore_scheduling_rules: true` on a `propose_change`/`propose_batch`
item, or on `schedule_task`'s new-event shape, is the only way to bypass this
gate — use it only when the user has explicitly said to override a rule for
this one write, never by default.

**There is no delete** — `update_scheduling_rule` with `active: false` is the
way to retire a rule. A paused rule stops narrowing at both search time and
write time immediately.

**A rule scoped to a `tag`, applied to a `move`, checks the proposal's own
input tags** — not necessarily the target event's current real tags on the
calendar. If a tag-scoped rule doesn't seem to be catching a move the way you
expect, check what tags the move proposal itself was given.
