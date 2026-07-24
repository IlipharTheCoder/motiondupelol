import { isAuthorized } from '@/lib/auth';
import { rebalanceWorkload } from '@/lib/dayRebalance';

export const maxDuration = 60;

const DEFAULT_SEARCH_HORIZON_DAYS = 7;

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const maxBusyMinutesRaw = searchParams.get('maxBusyMinutes');
  const searchTo = searchParams.get('searchTo');

  if (!from || !to) {
    return Response.json({ error: '"from" and "to" are required' }, { status: 400 });
  }

  const rangeStart = new Date(from);
  if (Number.isNaN(rangeStart.getTime())) {
    return Response.json({ error: '"from" must be a valid ISO datetime' }, { status: 400 });
  }

  const rangeEnd = new Date(to);
  if (Number.isNaN(rangeEnd.getTime())) {
    return Response.json({ error: '"to" must be a valid ISO datetime' }, { status: 400 });
  }
  if (rangeEnd.getTime() <= rangeStart.getTime()) {
    return Response.json({ error: '"to" must be later than "from"' }, { status: 400 });
  }

  const maxBusyMinutes = maxBusyMinutesRaw === null ? NaN : Number(maxBusyMinutesRaw);
  if (!Number.isFinite(maxBusyMinutes) || maxBusyMinutes < 0) {
    return Response.json({ error: '"maxBusyMinutes" is required and must be a non-negative number' }, { status: 400 });
  }

  const searchEnd = searchTo
    ? new Date(searchTo)
    : new Date(rangeEnd.getTime() + DEFAULT_SEARCH_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  if (Number.isNaN(searchEnd.getTime())) {
    return Response.json({ error: '"searchTo" must be a valid ISO datetime' }, { status: 400 });
  }
  if (searchEnd.getTime() <= rangeEnd.getTime()) {
    return Response.json({ error: '"searchTo" must be later than "to"' }, { status: 400 });
  }

  try {
    const summary = await rebalanceWorkload(rangeStart, rangeEnd, maxBusyMinutes, searchEnd);
    return Response.json(summary);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
