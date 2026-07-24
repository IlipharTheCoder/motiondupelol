import { supabase } from '@/lib/supabase';
import { isAuthorized } from '@/lib/auth';
import { normalizeTags } from '@/lib/normalizeTags';
import { EVENT_PRIORITIES } from '@/lib/eventMetadata';

const VALID_STATUSES = ['unscheduled', 'scheduled', 'completed', 'discarded'];

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');
  if (status && !VALID_STATUSES.includes(status)) {
    return Response.json({ error: `"status" must be one of ${VALID_STATUSES.join(', ')}` }, { status: 400 });
  }

  let query = supabase.from('tasks').select('*').order('created_at', { ascending: false });
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

  let deadline: string | null = null;
  if (body.deadline !== undefined && body.deadline !== null) {
    if (typeof body.deadline !== 'string' || Number.isNaN(Date.parse(body.deadline))) {
      return Response.json({ error: '"deadline" must be a valid date string' }, { status: 400 });
    }
    deadline = body.deadline;
  }

  if (body.priority !== undefined && body.priority !== null && !EVENT_PRIORITIES.includes(body.priority)) {
    return Response.json(
      { error: `"priority" must be one of ${EVENT_PRIORITIES.join(', ')}, or null` },
      { status: 400 }
    );
  }

  if (
    body.duration_minutes !== undefined &&
    body.duration_minutes !== null &&
    (!Number.isInteger(body.duration_minutes) || body.duration_minutes <= 0)
  ) {
    return Response.json({ error: '"duration_minutes" must be a positive integer' }, { status: 400 });
  }

  const description = typeof body.description === 'string' ? body.description : null;
  const tags = normalizeTags(body.tags);

  const { data, error } = await supabase
    .from('tasks')
    .insert({
      title,
      description,
      deadline,
      priority: body.priority ?? null,
      tags,
      duration_minutes: body.duration_minutes ?? null,
      source_system: 'manual',
      status: 'unscheduled',
    })
    .select('*')
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data);
}
