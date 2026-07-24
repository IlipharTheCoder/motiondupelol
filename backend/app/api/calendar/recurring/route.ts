import { isAuthorized } from '@/lib/auth';
import { BURNER_EVENT_TYPES, EVENT_PRIORITIES } from '@/lib/eventMetadata';
import { planRecurringSeries, type RecurringSeriesInput } from '@/lib/recurringEvents';
import { MAX_OCCURRENCES } from '@/lib/recurringOccurrences';

export const maxDuration = 60;

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }

  if (!BURNER_EVENT_TYPES.includes(body.category)) {
    return Response.json({ error: `"category" must be one of ${BURNER_EVENT_TYPES.join(', ')}` }, { status: 400 });
  }
  if (typeof body.proposed_summary !== 'string' || !body.proposed_summary.trim()) {
    return Response.json({ error: '"proposed_summary" is required' }, { status: 400 });
  }
  if (typeof body.first_start !== 'string' || typeof body.first_end !== 'string') {
    return Response.json({ error: '"first_start" and "first_end" are required' }, { status: 400 });
  }
  if (body.priority !== undefined && body.priority !== null && !EVENT_PRIORITIES.includes(body.priority)) {
    return Response.json({ error: `"priority" must be one of ${EVENT_PRIORITIES.join(', ')}` }, { status: 400 });
  }
  if (body.flexible !== undefined && body.flexible !== 'true' && body.flexible !== 'false') {
    return Response.json({ error: '"flexible" must be "true" or "false"' }, { status: 400 });
  }

  const intervalWeeks = body.interval_weeks ?? 1;
  if (!Number.isInteger(intervalWeeks) || intervalWeeks <= 0) {
    return Response.json({ error: '"interval_weeks" must be a positive integer' }, { status: 400 });
  }

  const hasCount = body.count !== undefined && body.count !== null;
  const hasUntil = body.until !== undefined && body.until !== null;
  if (hasCount === hasUntil) {
    return Response.json({ error: 'Provide exactly one of "count" or "until"' }, { status: 400 });
  }
  if (hasCount && (!Number.isInteger(body.count) || body.count <= 0 || body.count > MAX_OCCURRENCES)) {
    return Response.json(
      { error: `"count" must be a positive integer, at most ${MAX_OCCURRENCES}` },
      { status: 400 }
    );
  }
  if (hasUntil && typeof body.until !== 'string') {
    return Response.json({ error: '"until" must be a valid ISO datetime' }, { status: 400 });
  }

  if (body.tags !== undefined && !Array.isArray(body.tags)) {
    return Response.json({ error: '"tags" must be an array of strings' }, { status: 400 });
  }
  if (body.bump_if_movable !== undefined && typeof body.bump_if_movable !== 'boolean') {
    return Response.json({ error: '"bump_if_movable" must be a boolean' }, { status: 400 });
  }
  if (
    body.weekdays !== undefined &&
    (!Array.isArray(body.weekdays) ||
      body.weekdays.length === 0 ||
      body.weekdays.some((d: unknown) => !Number.isInteger(d) || (d as number) < 1 || (d as number) > 7))
  ) {
    return Response.json(
      { error: '"weekdays" must be a non-empty array of integers 1-7 (1=Monday..7=Sunday)' },
      { status: 400 }
    );
  }
  if (
    body.skip_dates !== undefined &&
    (!Array.isArray(body.skip_dates) || body.skip_dates.some((d: unknown) => typeof d !== 'string'))
  ) {
    return Response.json({ error: '"skip_dates" must be an array of ISO date strings' }, { status: 400 });
  }

  const input: RecurringSeriesInput = {
    category: body.category,
    proposed_summary: body.proposed_summary,
    proposed_description: body.proposed_description,
    priority: body.priority ?? undefined,
    flexible: body.flexible,
    first_start: body.first_start,
    first_end: body.first_end,
    interval_weeks: intervalWeeks,
    count: hasCount ? body.count : undefined,
    until: hasUntil ? body.until : undefined,
    weekdays: body.weekdays,
    skip_dates: body.skip_dates,
    tags: body.tags,
    bump_if_movable: body.bump_if_movable,
    reason: body.reason,
  };

  try {
    const summary = await planRecurringSeries(input);
    return Response.json(summary);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
