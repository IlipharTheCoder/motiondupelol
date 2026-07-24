import { calendar } from './googleCalendar';
import { decodeEventMetadata, decodeEventTags, type BurnerEventType, type EventPriority } from './eventMetadata';
import { ValidationError } from './proposedChanges';

const BURNER_CALENDAR_ID = process.env.GOOGLE_BURNER_CALENDAR_ID!;
const DEFAULT_MAX_RESULTS = 50;
const MAX_MAX_RESULTS = 2500; // Google's own ceiling

export interface CalendarEventSummary {
  id: string | null | undefined;
  summary: string | null | undefined;
  description: string | null | undefined;
  location: string | null | undefined;
  start: unknown;
  end: unknown;
  status: string | null | undefined;
  htmlLink: string | null | undefined;
  category: BurnerEventType | null;
  priority: EventPriority | null;
  deadline: string | null;
  colorTag: string | null;
  tags: string[];
  origin: { sourceSystem: string | null; sourceLabel: string | null };
}

export interface ListCalendarEventsInput {
  from?: string;
  to?: string;
  q?: string;
  maxResults?: number;
  pageToken?: string;
}

export interface ListCalendarEventsResult {
  events: CalendarEventSummary[];
  nextPageToken: string | null;
}

// Lifted verbatim from app/api/calendar/events/route.ts's GET handler — this
// is the one read tool in the Phase 5 NL chat layer (get_calendar_events)
// with no prior lib wrapper at all: every internal planner uses
// lib/busyIntervals.ts's fetchSchedulableEvents instead, which returns a
// different, planning-oriented shape (no origin/colorTag/htmlLink) — not a
// fit for a human-readable chat listing.
export async function listCalendarEvents(input: ListCalendarEventsInput): Promise<ListCalendarEventsResult> {
  let rangeStart: Date | undefined;
  let rangeEnd: Date | undefined;

  if (input.from !== undefined) {
    rangeStart = new Date(input.from);
    if (Number.isNaN(rangeStart.getTime())) {
      throw new ValidationError('"from" must be a valid ISO datetime');
    }
  }
  if (input.to !== undefined) {
    rangeEnd = new Date(input.to);
    if (Number.isNaN(rangeEnd.getTime())) {
      throw new ValidationError('"to" must be a valid ISO datetime');
    }
  }
  if (rangeStart && rangeEnd && rangeEnd.getTime() <= rangeStart.getTime()) {
    throw new ValidationError('"to" must be later than "from"');
  }

  const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    throw new ValidationError('"maxResults" must be a positive integer');
  }
  if (maxResults > MAX_MAX_RESULTS) {
    throw new ValidationError(`"maxResults" cannot exceed ${MAX_MAX_RESULTS}`);
  }

  const { data } = await calendar.events.list({
    calendarId: BURNER_CALENDAR_ID,
    singleEvents: true,
    orderBy: 'startTime',
    timeMin: (rangeStart ?? new Date()).toISOString(),
    timeMax: rangeEnd?.toISOString(),
    q: input.q,
    maxResults,
    pageToken: input.pageToken,
  });

  const events = (data.items ?? []).map((event): CalendarEventSummary => {
    const meta = decodeEventMetadata(event.extendedProperties);
    return {
      id: event.id,
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: event.start,
      end: event.end,
      status: event.status,
      htmlLink: event.htmlLink,
      category: meta.type ?? null,
      priority: meta.priority ?? null,
      deadline: meta.deadline ? meta.deadline : null,
      colorTag: meta.colorTag ? meta.colorTag : null,
      tags: decodeEventTags(meta.tags),
      origin: {
        sourceSystem: meta.sourceSystem ?? null,
        sourceLabel: meta.sourceLabel ? meta.sourceLabel : null,
      },
    };
  });

  return { events, nextPageToken: data.nextPageToken ?? null };
}
