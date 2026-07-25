// The IO half of lib/nlContext.ts's split — every function here is volatile,
// per app/api/chat/route.ts's cache-prefix design (see lib/nlContext.ts's
// top comment): re-fetched and re-inserted fresh on every /api/chat call,
// after the cache_control breakpoint, never baked into the long-lived
// cached system-prompt prefix.
//
// Complete rebuild (2026-07-25): trimmed to just fetchCalendarDigest — the
// only context the 2-tool surface (lib/nlToolManifest.ts) needs.
// fetchOpenState/fetchSchedulingConfigAndRules/fetchLastCalendarSyncedAt
// were removed along with the tools/context they supported.
import { listCalendarEvents, type CalendarEventSummary } from './calendarEvents';

const DIGEST_WINDOW_DAYS = 7;
const DIGEST_MAX_EVENTS = 50;

// A bounded near-term window — the point of a "digest" is a quick glance,
// not a full listing.
export async function fetchCalendarDigest(now: Date = new Date()): Promise<CalendarEventSummary[]> {
  const from = now.toISOString();
  const to = new Date(now.getTime() + DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { events } = await listCalendarEvents({ from, to, maxResults: DIGEST_MAX_EVENTS });
  return events;
}
