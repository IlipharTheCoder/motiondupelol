import { supabase } from '@/lib/supabase';
import { isAuthorized } from '@/lib/auth';
import { normalizeTags } from '@/lib/normalizeTags';
import { EVENT_PRIORITIES } from '@/lib/eventMetadata';
import { HABIT_CADENCES, HABIT_STATUSES, type HabitStatus } from '@/lib/habits';

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');
  if (status && !HABIT_STATUSES.includes(status as HabitStatus)) {
    return Response.json({ error: `"status" must be one of ${HABIT_STATUSES.join(', ')}` }, { status: 400 });
  }

  let query = supabase.from('habits').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data);
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    return Response.json({ error: 'title is required' }, { status: 400 });
  }

  if (!HABIT_CADENCES.includes(body.cadence)) {
    return Response.json({ error: `"cadence" must be one of ${HABIT_CADENCES.join(', ')}` }, { status: 400 });
  }

  if (!Number.isInteger(body.target_count) || body.target_count <= 0) {
    return Response.json({ error: '"target_count" must be a positive integer' }, { status: 400 });
  }

  if (
    body.occurrence_duration_minutes !== undefined &&
    body.occurrence_duration_minutes !== null &&
    (!Number.isInteger(body.occurrence_duration_minutes) || body.occurrence_duration_minutes <= 0)
  ) {
    return Response.json({ error: '"occurrence_duration_minutes" must be a positive integer' }, { status: 400 });
  }

  if (
    body.interval_days !== undefined &&
    body.interval_days !== null &&
    (!Number.isInteger(body.interval_days) || body.interval_days <= 0)
  ) {
    return Response.json({ error: '"interval_days" must be a positive integer' }, { status: 400 });
  }
  if (body.cadence === 'interval' && (body.interval_days === undefined || body.interval_days === null)) {
    return Response.json(
      { error: '"interval_days" is required and must be a positive integer when cadence is "interval"' },
      { status: 400 }
    );
  }

  if (body.priority !== undefined && body.priority !== null && !EVENT_PRIORITIES.includes(body.priority)) {
    return Response.json(
      { error: `"priority" must be one of ${EVENT_PRIORITIES.join(', ')}, or null` },
      { status: 400 }
    );
  }

  const description = typeof body.description === 'string' ? body.description : null;
  const tags = normalizeTags(body.tags);

  const { data, error } = await supabase
    .from('habits')
    .insert({
      title,
      description,
      cadence: body.cadence,
      interval_days: body.interval_days ?? null,
      target_count: body.target_count,
      occurrence_duration_minutes: body.occurrence_duration_minutes ?? null,
      priority: body.priority ?? null,
      tags,
      status: 'active',
    })
    .select('*')
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data);
}
