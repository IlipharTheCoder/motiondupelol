import { isAuthorized } from '@/lib/auth';
import { getNextTasks } from '@/lib/aiTasks';

const DEFAULT_LIMIT = 1;
const MAX_LIMIT = 20;

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const limitParam = searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    limit = Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return Response.json({ error: `"limit" must be an integer between 1 and ${MAX_LIMIT}` }, { status: 400 });
    }
  }

  try {
    const tasks = await getNextTasks(limit);
    return Response.json(tasks);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
