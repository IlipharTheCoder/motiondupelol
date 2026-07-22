import { dedupeBurnerEvents } from '@/lib/calendarSync';
import { isAuthorized } from '@/lib/auth';

export const maxDuration = 60;

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await dedupeBurnerEvents();
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
