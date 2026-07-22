import { isAuthorized } from '@/lib/auth';
import { runSync } from '@/lib/calendarSync';

export const maxDuration = 60;

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runSync();
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
