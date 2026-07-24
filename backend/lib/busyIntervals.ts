import type { calendar_v3 } from 'googleapis';
import { DateTime } from 'luxon';
import { calendar } from './googleCalendar';
import { getSchedulingConfig, type SchedulingConfig } from './schedulingConfig';
import { padIntervals, type Interval } from './intervals';

const BURNER_CALENDAR_ID = process.env.GOOGLE_BURNER_CALENDAR_ID!;
const PAGE_SIZE = 2500;
const MAX_PAGES = 20;

export interface BusyInterval extends Interval {
  eventId: string;
  summary: string | null;
  isAllDay: boolean;
}

export interface FetchBusyIntervalsOptions {
  paddingMinutes?: number;
}

// Exported separately from fetchBusyIntervals so it's unit-testable against
// constructed fake Google event objects without mocking the Google client.
export function normalizeEventToInterval(
  event: calendar_v3.Schema$Event,
  homeTimezone: string
): BusyInterval | null {
  if (!event.id || event.status === 'cancelled') return null;

  const start = event.start;
  const end = event.end;
  if (!start || !end) return null;

  if (start.date && end.date) {
    // All-day events are treated as notes/markers, not real scheduled time
    // — almost every all-day entry in practice is informational ("first day
    // of classes," "orientation week"), not a commitment that should ever
    // block a free-slot search or register as a conflict. Excluded here at
    // the shared source (not per-caller) so every consumer gets this for
    // free: findFreeSlots/detectConflicts (via fetchBusyIntervals),
    // autoReschedule's conflict scan, and habitPlacement/focusTime/
    // bufferTime's own event scans. Previously this returned a full-day
    // interval, which meant a single all-day event could block every timed
    // slot for its entire date range — caught live while verifying item 24
    // (a real "Second year student orientation" all-day event blocked an
    // entire week of conflict-checking).
    return null;
  }

  if (start.dateTime && end.dateTime) {
    // Each event's own `timeZone` governs its own `dateTime` interpretation,
    // independent of the home timezone — once converted to an epoch instant
    // here, interval math never needs to know which zone an event was
    // authored in.
    return {
      eventId: event.id,
      summary: event.summary ?? null,
      isAllDay: false,
      start: DateTime.fromISO(start.dateTime, { zone: start.timeZone ?? 'UTC' }).toMillis(),
      end: DateTime.fromISO(end.dateTime, { zone: end.timeZone ?? 'UTC' }).toMillis(),
    };
  }

  return null;
}

export async function fetchBusyIntervals(
  rangeStart: Date,
  rangeEnd: Date,
  options: FetchBusyIntervalsOptions = {},
  config: SchedulingConfig = getSchedulingConfig()
): Promise<BusyInterval[]> {
  const intervals: BusyInterval[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const { data } = await calendar.events.list({
      calendarId: BURNER_CALENDAR_ID,
      singleEvents: true,
      showDeleted: false,
      timeMin: rangeStart.toISOString(),
      timeMax: rangeEnd.toISOString(),
      maxResults: PAGE_SIZE,
      pageToken,
    });

    for (const event of data.items ?? []) {
      const interval = normalizeEventToInterval(event, config.homeTimezone);
      if (interval) intervals.push(interval);
    }

    pageToken = data.nextPageToken ?? undefined;
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  if (!options.paddingMinutes) return intervals;

  // Pad each raw event interval individually, before any merge step a
  // caller applies — so two originally-separate events whose padding now
  // overlaps correctly combine into one blocked span later.
  const padded = padIntervals(intervals, options.paddingMinutes);
  return intervals.map((interval, i) => ({ ...interval, start: padded[i].start, end: padded[i].end }));
}
