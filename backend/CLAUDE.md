# Project: AI Calendar Manager — Backend

## What this is
The backend for a personal AI calendar manager. Holds all real logic and all sensitive credentials. The Mac/iOS client (separate Xcode project) is a thin display/approval layer that only talks to this backend's API — it has no Google or Claude credentials of its own.

Full system design: `docs/architecture-plan.md`
Feature list + algorithmic-vs-API classification: `docs/ai-calendar-manager-spec.md`
Build order / what's next: `docs/backend-build-order.md`
Current API surface: `docs/api-reference.md`
Current database schema: `docs/schema.md`

**Read the relevant doc above before starting a task** — don't infer architecture decisions from scratch when they're already written down.

## Stack
- Next.js (App Router), TypeScript, deployed on Vercel (Hobby/free tier)
- Supabase (Postgres + Storage) — free tier
- Google Calendar API via a service account (no OAuth — calendars are shared directly with the service account's email; see `docs/architecture-plan.md` section 2a)
- Claude API (`@anthropic-ai/sdk`) for the one AI-required feature (screenshot parsing)

## Conventions
- Every route except `/api/health` must call `isAuthorized(request)` from `lib/auth.ts` as the first line of the handler, returning 401 immediately if it fails
- Error responses are always `Response.json({ error: message }, { status: code })` — keep this shape consistent across every route
- One shared Supabase client (`lib/supabase.ts`) — don't instantiate a new client per route
- Table and column names: lowercase `snake_case`, always
- Tags are always normalized (trimmed, lowercased) before being written to the database — see `normalizeTags()` if it exists, or flag if this logic needs to be added to a new route that writes tags
- Prefer plain algorithmic code over an AI/LLM call wherever possible — check `docs/ai-calendar-manager-spec.md` section 12 before assuming something needs Claude. Most scheduling logic does not.
- Nothing writes directly to the calendar without going through the proposed-changes/review-queue mechanism once it exists (see `docs/backend-build-order.md` Phase 2) — scheduling features propose, they don't apply

## Guardrails
- Never put real secret values in any `.md` file, including this one — describe what a credential is for, not its value
- Never add a frontend/UI framework to this project — it's API-only; the Xcode app is the only UI
- Don't guess at ambiguous architecture decisions — flag and ask, per the pattern established throughout this project's planning

## Environment variables in use
See `.env.example` for the full list of names (no real values there either — check `.env.local`, which is gitignored).
