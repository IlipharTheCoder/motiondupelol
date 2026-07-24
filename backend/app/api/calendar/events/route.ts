import { isAuthorized } from '@/lib/auth';
import { ValidationError } from '@/lib/proposedChanges';
import { listCalendarEvents } from '@/lib/calendarEvents';

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const maxResultsRaw = searchParams.get('maxResults');

  try {
    const result = await listCalendarEvents({
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
      q: searchParams.get('q') ?? undefined,
      maxResults: maxResultsRaw !== null ? Number(maxResultsRaw) : undefined,
      pageToken: searchParams.get('pageToken') ?? undefined,
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
