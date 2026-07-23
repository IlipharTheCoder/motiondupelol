import { isAuthorized } from '@/lib/auth';
import { getDeepWorkIndex } from '@/lib/focusTime';

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const stats = await getDeepWorkIndex();
    return Response.json(stats);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
