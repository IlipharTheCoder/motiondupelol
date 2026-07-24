import { isAuthorized } from '@/lib/auth';
import { planTaskPlacement } from '@/lib/taskPlacement';
import { ValidationError } from '@/lib/proposedChanges';

export const maxDuration = 60;

const DEFAULT_HORIZON_DAYS = 14;

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  const rangeStart = from ? new Date(from) : new Date();
  if (Number.isNaN(rangeStart.getTime())) {
    return Response.json({ error: '"from" must be a valid ISO datetime' }, { status: 400 });
  }

  const rangeEnd = to
    ? new Date(to)
    : new Date(rangeStart.getTime() + DEFAULT_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  if (Number.isNaN(rangeEnd.getTime())) {
    return Response.json({ error: '"to" must be a valid ISO datetime' }, { status: 400 });
  }
  if (rangeEnd.getTime() <= rangeStart.getTime()) {
    return Response.json({ error: '"to" must be later than "from"' }, { status: 400 });
  }

  try {
    const summary = await planTaskPlacement(rangeStart, rangeEnd);
    return Response.json(summary);
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
