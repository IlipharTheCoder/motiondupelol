import { calendar } from '@/lib/googleCalendar';
import { isAuthorized } from '@/lib/auth';
import { decodeEventMetadata } from '@/lib/eventMetadata';

const DEFAULT_MAX_RESULTS = 50;
const MAX_MAX_RESULTS = 2500; // Google's own ceiling

function parseOptionalPositiveInt(raw: string | null, name: string): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`"${name}" must be a positive integer`);
  }
  return value;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const q = searchParams.get('q');
  const pageToken = searchParams.get('pageToken');

  let rangeStart: Date | undefined;
  let rangeEnd: Date | undefined;

  if (from !== null) {
    rangeStart = new Date(from);
    if (Number.isNaN(rangeStart.getTime())) {
      return Response.json({ error: '"from" must be a valid ISO datetime' }, { status: 400 });
    }
  }
  if (to !== null) {
    rangeEnd = new Date(to);
    if (Number.isNaN(rangeEnd.getTime())) {
      return Response.json({ error: '"to" must be a valid ISO datetime' }, { status: 400 });
    }
  }
  if (rangeStart && rangeEnd && rangeEnd.getTime() <= rangeStart.getTime()) {
    return Response.json({ error: '"to" must be later than "from"' }, { status: 400 });
  }

  let maxResults: number;
  try {
    maxResults = parseOptionalPositiveInt(searchParams.get('maxResults'), 'maxResults') ?? DEFAULT_MAX_RESULTS;
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
  if (maxResults > MAX_MAX_RESULTS) {
    return Response.json({ error: `"maxResults" cannot exceed ${MAX_MAX_RESULTS}` }, { status: 400 });
  }

  try {
    const { data } = await calendar.events.list({
      calendarId: process.env.GOOGLE_BURNER_CALENDAR_ID,
      singleEvents: true,
      orderBy: 'startTime',
      timeMin: (rangeStart ?? new Date()).toISOString(),
      timeMax: rangeEnd?.toISOString(),
      q: q ?? undefined,
      maxResults,
      pageToken: pageToken ?? undefined,
    });

    const events = (data.items ?? []).map((event) => {
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
        origin: {
          sourceSystem: meta.sourceSystem ?? null,
          sourceLabel: meta.sourceLabel ? meta.sourceLabel : null,
        },
      };
    });

    return Response.json({ events, nextPageToken: data.nextPageToken ?? null });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
