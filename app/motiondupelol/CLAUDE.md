# Project: AI Calendar Manager — Mac + iOS Client

## What this app is
A thin native client (Mac + iPhone, one Xcode project) for a backend-driven calendar manager. This app does **not** run the scheduling engine, does **not** talk to Google Calendar directly, and does **not** hold any Google or Claude API credentials. All of that lives in a separate backend (Vercel + Supabase) — a sibling directory in this same workspace: `../backend/`. Full system design: `../backend/architecture-plan.md`. Guiding principles + the API surface written specifically for app-side work: `../backend/app-development-guide.md` (start there, not the raw API reference, unless you need a specific endpoint's exact field shapes).

## What this app currently does — "calendar manager," not a calendar (rebuilt 2026-07-25)
One screen, three vertical sections, no calendar grid and no inbox — a deliberate reset away from an earlier calendar-visualization design:
- **Task list** (top) — view/create tasks (`APIClient.fetchTasks`/`createTask`, `TaskListView`/`TasksViewModel`). View-and-create only; there's no `PATCH /api/tasks/{id}` on the backend yet, so no edit UI.
- **Approval queue** (middle) — the pending-changes review queue (`APIClient.fetchProposedChanges`/`approveChange`/`rejectChange`, `ApprovalQueueView`/`ProposedChangesViewModel`). **Auto-updates two ways**: refreshed immediately after any action that could change it (a chat reply that produced proposals, an approve, a reject), and independently polled every 25s while the app is active (`ProposedChangesViewModel.startPolling()`, paused on backgrounding via `scenePhase`). **Priority-at-confirmation (added 2026-07-25):** a chat-created calendar-block proposal always lands with `priority` unset; `PendingChangeRow` shows an inline "Set priority" menu instead of a plain badge for that case (calling the new `APIClient.setProposedChangePriority`/`ProposedChangesViewModel.setPriority`) and disables Approve/Retry until one is picked — this mirrors a hard block the server itself enforces (approving without a priority fails with `status: "failed"`), so don't remove the client-side gate even though the server would eventually catch it too.
- **Chat** (bottom) — a single unified conversation (`APIClient.chat(message:conversationId:)`, `ChatInputView`/`ChatViewModel`). Talks to the backend's NL layer, which has **five abilities** server-side (grown from two the same day, 2026-07-25): propose a calendar create/move/delete, find free time (now unrestricted — no working-hours/scheduling-rule filtering), list unscheduled tasks, assign a task to an event (existing or new), and unassign a task. Still narrow by design — habits, scheduling rules, and bulk operations remain out of chat's reach.
- **Automatic data refresh** — `APIClient.refresh()` (`POST /api/refresh`, calendar + Todoist sync combined) fires on launch and on `scenePhase` becoming `.active`. Not a user-facing button; its response isn't modeled or surfaced in the UI at all.

**Dropped in the 2026-07-25 rebuild, not present anymore**: the paged week/month calendar grid, the inbox/screenshot-capture UI (`InboxView`/`InboxViewModel`, `CalendarEvent`/`CalendarView`/`CalendarViewModel` are all deleted), and the manual Todoist-sync button. None of this was broken — it was a deliberate scope cut toward a narrower, list-based tool. The backend's `/api/capture` route still doesn't exist either, so nothing capture-related was ever fully working on either side.

## What this app talks to
- **Only the backend's API** — never Google Calendar, never Claude, never Supabase directly.
- The real configured value in `Secrets.swift` right now is the **production** URL (`https://motiondupelol.vercel.app`), not localhost — this app is currently pointed at the live deployed backend, not a local dev server. Check `Secrets.swift` directly before assuming which one is active; don't trust a comment or this doc over the actual file.
- Auth between app and backend: a shared secret (`APP_SECRET_KEY`), stored in `Secrets.swift` (`CoreLogic/`), sent as an `x-api-key` header on every request via `APIClient`. **This file holds the real secret value in plaintext and was NOT gitignored until this was caught and fixed (2026-07-25)** — `app/.gitignore` now excludes it (and Xcode's own `xcuserdata`/`.DS_Store` cruft). If a `.gitignore` for this directory is ever missing again, treat that as a live risk, not a formatting nitpick — the file was untracked purely by luck (nobody had run `git add` yet), not by protection.

**Important guardrail:** this app should never contain a Google API key, Google Sign-In SDK, service account credential, or Anthropic/Claude API key of any kind. All Google Calendar and Claude access happens exclusively in the backend. If a task seems to require calling Google or Claude directly from Swift code, that's a sign the task actually belongs in the backend as a new API route — flag it rather than adding third-party AI/Google SDKs to the Xcode project.

## Platform
- iOS 17+ / macOS 14+ (Swift 5.9+)
- SwiftUI only, `@Observable` macro — not Combine, not UIKit unless a specific gap requires it. The 25s approval-queue poll is a plain `Task { while !Task.isCancelled { ...; try? await Task.sleep(for:) } }` loop, deliberately not `Timer.publish(...)` (Combine), matching this rule.
- Architecture: MVVM (`ProposedChangesViewModel`/`TasksViewModel`/`ChatViewModel` are the current examples — `@Observable final class`, owns state + async calls into `APIClient`, views read/mutate it directly)

## Project structure
- `Shared/` — SwiftUI views: `MainView` (root, owns all three view models and coordinates refresh-after-action wiring), `TaskListView`, `ApprovalQueueView`, `ChatInputView`
- `CoreLogic/` — networking (`APIClient`) + data models (`ProposedChange`/`TaskItem`, `ChatResponse`/`ChatUsage`) + view models (`TasksViewModel`, `ProposedChangesViewModel`, `ChatViewModel`) + `APIError`. This is the only place that talks to the backend — one shared `APIClient.shared`, no ad-hoc `URLSession` calls in views.
- `Secrets.swift` — real credentials, gitignored (see above)
- There is no `docs/` folder in this project — reference docs live in the sibling `../backend/` directory (see the top of this file). Don't create one; matches `../backend/CLAUDE.md`'s own explicit "no `docs/` folder" convention for that project too.

## Data models — current known state (verified against the real backend, 2026-07-25)
- **`ChatResponse`**: `conversationId`, `reply`, `proposals: [ProposedChange]`, `usage: ChatUsage` (non-optional — the backend always sends it). No `groupId`/`clarification` fields — those were removed from this model entirely (the backend stopped sending both in the same-day chat rebuild: no tool produces a group, and ambiguity is just handled in the reply text).
- **`ProposedChange.swift`** only surfaces a subset of the real `proposed_changes` row (no `target_event_id`, `tags`, `decided_at`, `applied_at`, `updated_at`, `color_tag`, etc.) — not a bug, just means the UI doesn't currently expose those; check `../backend/backend-schema.md`'s `proposed_changes` table if a feature needs one of the missing fields. `proposedStartDate`/`proposedEndDate` computed properties centralize the ISO8601 parsing that used to be duplicated per-row-view. `priority` is `nil` on a fresh chat-created calendar-block proposal until set via the approval queue's picker (see above) — `PendingChangeRow.needsPriority` (`changeType == "create"` with both dates present and `priority == nil`) is what decides whether to show the picker instead of a plain badge, deliberately mirroring the backend's own `isCalendarCreate` gate rather than a client-invented rule.
- **`TaskItem.swift`** mirrors the real `tasks` table; `deadlineDate` computed property, same reasoning as above.
- There is no calendar-event model anymore (`CalendarEvent`/`EventOrigin`/`EventDateTime` were deleted along with the calendar grid) and no inbox-item model (`InboxItem` deleted). If a future feature needs raw calendar-event data again, re-derive the model from `../backend/backend-api-reference.md`'s `GET /api/calendar/events` section rather than assuming the old shape is still accurate.

## Conventions
- New files go in `CoreLogic` (networking/models/view-models) or `Shared` (views) — not scattered elsewhere
- One shared `APIClient` for all backend calls — no ad-hoc `URLSession` calls sprinkled through views
- Human-in-the-loop is a hard rule: the app never silently applies a change — every proposed action from the backend needs explicit user approval before it's considered "done" (this is also enforced backend-side now, not just a client convention — see `../backend/backend-api-reference.md`'s `POST /api/chat` entry for how the NL layer structurally cannot apply anything itself)

## Open items (not yet decided — flag if this matters for what you're building)
- Whether `Secrets.swift` should move to Keychain rather than a plain (now-gitignored) source file, once the app is further along
- Whether the approval queue's 25s poll should back off or stop entirely on repeated network failures (currently just silently retries next tick, same as any other refresh call)
- No task-edit UI exists (view-and-create only) since the backend has no `PATCH /api/tasks/{id}` — would need a new backend endpoint first
