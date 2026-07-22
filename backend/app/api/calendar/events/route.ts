import { calendar } from '@/lib/googleCalendar';
import { isAuthorized } from '@/lib/auth';

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { data } = await calendar.events.list({
      calendarId: process.env.GOOGLE_BURNER_CALENDAR_ID,
      singleEvents: true,
      orderBy: 'startTime',
      timeMin: new Date().toISOString(),
      maxResults: 50,
    });

    const events = (data.items ?? []).map((event) => ({
      id: event.id,
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: event.start,
      end: event.end,
      status: event.status,
      htmlLink: event.htmlLink,
    }));

    return Response.json(events);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
