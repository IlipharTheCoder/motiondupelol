// The IO half of lib/nlContext.ts's split — every function here is volatile,
// per app/api/chat/route.ts's cache-prefix design (see lib/nlContext.ts's
// top comment): re-fetched and re-inserted fresh on every /api/chat call,
// after the cache_control breakpoint, never baked into the long-lived
// cached system-prompt prefix.
import { getSchedulingConfig, type SchedulingConfig } from './schedulingConfig';
import { listProposedChanges, type ProposedChangeRow } from './proposedChanges';
import { listCalendarEvents, type CalendarEventSummary } from './calendarEvents';
import { listSchedulingRules } from './schedulingRulesQuery';
import type { SchedulingRuleRow } from './schedulingRules';
import type { RecentActionSummary } from './nlContext';

const DIGEST_WINDOW_DAYS = 7;
const DIGEST_MAX_EVENTS = 50;
const RECENT_ACTIONS_LIMIT = 10;

export interface OpenState {
  pendingProposals: ProposedChangeRow[];
  pendingGroupIds: string[];
  recentActions: RecentActionSummary[];
}

// Pending proposals + the distinct group ids among them + a short window of
// recently-decided ones (so "undo that" has something to point at) — always
// recomputed fresh from proposed_changes, never replayed from
// chat_messages history, per the confirmed persistence design.
export async function fetchOpenState(): Promise<OpenState> {
  const [pending, decided] = await Promise.all([
    listProposedChanges('pending'),
    listProposedChanges(),
  ]);

  const pendingGroupIds = [...new Set(pending.map((p) => p.proposal_group_id).filter((id): id is string => !!id))];

  const recentActions: RecentActionSummary[] = decided
    .filter((p) => p.status === 'applied' || p.status === 'rejected')
    .slice(0, RECENT_ACTIONS_LIMIT)
    .map((p) => ({
      id: p.id,
      change_type: p.change_type,
      category: p.category,
      summary: p.proposed_summary ?? p.target_event_id ?? null,
      status: p.status,
      decided_at: p.decided_at,
    }));

  return { pendingProposals: pending, pendingGroupIds, recentActions };
}

// A bounded near-term window — the point of a "digest" is a quick glance,
// not a full listing (get_calendar_events is the tool for anything wider).
export async function fetchCalendarDigest(now: Date = new Date()): Promise<CalendarEventSummary[]> {
  const from = now.toISOString();
  const to = new Date(now.getTime() + DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { events } = await listCalendarEvents({ from, to, maxResults: DIGEST_MAX_EVENTS });
  return events;
}

export interface SchedulingConfigAndRules {
  config: SchedulingConfig;
  rules: SchedulingRuleRow[];
}

// Deliberately re-fetched every request even though it changes rarely in
// practice — a mid-session PATCH /api/scheduling-rules/{id} must be visible
// on the very next /api/chat call, so this can never live in the long-lived
// cached prefix (Correction 2 in the Phase 5 plan).
export async function fetchSchedulingConfigAndRules(): Promise<SchedulingConfigAndRules> {
  const config = getSchedulingConfig();
  const rules = await listSchedulingRules(true);
  return { config, rules };
}
