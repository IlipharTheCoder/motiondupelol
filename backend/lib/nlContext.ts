// Pure formatting only — no Supabase/Google import, by the same rule
// lib/schedulingRules.ts documents at its own top (see that file's comment):
// lib/workingHours.test.ts broke once already when a Supabase-touching
// function got pulled into a file vitest expects to be side-effect-free.
// Kept import-free here for an additional, Phase-5-specific reason too: the
// NL chat loop's cache_control breakpoint sits right after the *stable*
// system-prompt content (behavioral rules + tools) — nothing in this file
// may ever be pulled into that stable block, since every formatter here
// (especially formatTimeAnchors) recomputes something that changes on
// literally every request. See lib/nlContextQuery.ts for the IO half that
// fetches the raw data these functions format, and app/api/chat/route.ts
// for where the stable/volatile split actually happens.
//
// Complete rebuild (2026-07-25): trimmed to just the two formatters the
// 2-tool surface (lib/nlToolManifest.ts) actually needs — time anchors and
// the calendar digest. formatOpenState/formatSyncFreshness were removed
// along with the tools/context they supported (open state — pending
// proposals/groups/recent actions — and data freshness/refresh_data), since
// neither is actionable information for a model that can only
// propose_calendar_change/find_free_time.
import { DateTime } from 'luxon';
import type { SchedulingConfig } from './schedulingConfig';
import type { CalendarEventSummary } from './calendarEvents';

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Never cache this output — see the file-level comment above. `now` is
// resolved fresh from the caller's Date, never from Date.now() internally,
// so this stays trivially unit-testable with a fixed clock.
export function formatTimeAnchors(now: Date, config: SchedulingConfig): string {
  const local = DateTime.fromJSDate(now, { zone: config.homeTimezone });
  const weekStart = local.startOf('week'); // Luxon week starts Monday
  const weekEnd = weekStart.plus({ days: 6 }).endOf('day');
  const workingDayNames = config.workingDays.map((d) => WEEKDAY_NAMES[d - 1]).join(', ');

  return [
    `Current time: ${local.toFormat('EEEE, yyyy-LL-dd HH:mm')} (${config.homeTimezone})`,
    `Today: ${local.toFormat('yyyy-LL-dd')}`,
    `Tomorrow: ${local.plus({ days: 1 }).toFormat('yyyy-LL-dd')}`,
    `This week: ${weekStart.toFormat('yyyy-LL-dd')} to ${weekEnd.toFormat('yyyy-LL-dd')}`,
    `Working hours: ${String(config.workingHoursStart.hour).padStart(2, '0')}:${String(config.workingHoursStart.minute).padStart(2, '0')}-${String(config.workingHoursEnd.hour).padStart(2, '0')}:${String(config.workingHoursEnd.minute).padStart(2, '0')} local, on ${workingDayNames}`,
  ].join('\n');
}

function formatEventLine(event: CalendarEventSummary): string {
  const start = (event.start as { dateTime?: string; date?: string } | undefined)?.dateTime
    ?? (event.start as { dateTime?: string; date?: string } | undefined)?.date
    ?? '?';
  const end = (event.end as { dateTime?: string; date?: string } | undefined)?.dateTime
    ?? (event.end as { dateTime?: string; date?: string } | undefined)?.date
    ?? '?';
  const tagsStr = event.tags.length > 0 ? ` [${event.tags.join(', ')}]` : '';
  return `- ${event.id}: "${event.summary ?? '(untitled)'}" ${start} → ${end} (category: ${event.category ?? '?'}, priority: ${event.priority ?? '?'})${tagsStr}`;
}

// Given an already-fetched near-term event list (lib/nlContextQuery.ts's
// fetchCalendarDigest) — pure string formatting, no fetch of its own. This
// is also the only source of existing event ids for a move/delete
// propose_calendar_change call — there's no dedicated lookup tool.
export function formatCalendarDigest(events: CalendarEventSummary[]): string {
  if (events.length === 0) return 'No upcoming events in the digest window.';
  return events.map(formatEventLine).join('\n');
}
