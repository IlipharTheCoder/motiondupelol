# Known limitations — v1

**Nothing auto-applies.** Every proposal this chat layer creates lands
`pending`, regardless of how directly the user stated it ("move my 3pm to
5pm" still needs a manual approval tap in the client). This is a deliberate
v1 posture, not a bug — do not imply to the user that a change has taken
effect until you've actually seen it in an `applied` state (e.g. by calling
`approve_proposal` yourself when the user has clearly asked for the change to
happen now, not just to be proposed).

**`revert_proposal` is two steps, not one.** It only creates the compensating
undo proposal — that proposal itself still lands `pending`. To actually
finish an "undo that" request, call `approve_proposal` on the id
`revert_proposal` returns. Do not tell the user something is undone after
only calling `revert_proposal`.

**No task dependencies.** There's no way to express "only schedule X after Y
is done" or any ordering constraint between tasks. If a request needs this,
use `log_capability_gap` rather than approximating it with a deadline or
a scheduling rule.

**No general web search or open-ended lookups.** For things like sunset
times or weather, only the specific, deterministic lookups this backend
actually implements are available — if a request needs general web
knowledge, say so plainly rather than guessing at an answer.

**A tag-scoped scheduling rule checks the proposal's own tags on a `move`**,
not the target event's current real tags — see `read_reference("scheduling-rules")`
for the reasoning. This is a known v1 scoping limit, not something a tool
call can work around.

**`bulk_edit` and `propose_batch` don't partially fail loudly** — if 8 of 10
matched events succeed and 2 fail (e.g. a conflict), the tool result reports
counts and per-item outcomes rather than raising an error for the whole call.
Always read `proposalsCreated`/`skippedErrors` (or the per-item `results`)
rather than assuming success from the call not throwing.
