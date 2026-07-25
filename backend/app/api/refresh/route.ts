import { isAuthorized } from '@/lib/auth';
import { runRefresh } from '@/lib/refresh';

export const maxDuration = 60;

// Also reachable from chat (see lib/nlToolDispatch.ts's refresh_data tool),
// which calls lib/refresh.ts's runRefresh() directly rather than hitting
// this route — same logic, same result shape either way.
export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runRefresh();
  return Response.json(result);
}
