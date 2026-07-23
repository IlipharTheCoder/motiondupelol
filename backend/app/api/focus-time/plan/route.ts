import { isAuthorized } from '@/lib/auth';
import { planFocusTime } from '@/lib/focusTime';

export const maxDuration = 60;

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const summary = await planFocusTime();
    return Response.json(summary);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
