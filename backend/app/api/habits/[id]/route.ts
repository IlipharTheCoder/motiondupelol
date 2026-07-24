import { supabase } from '@/lib/supabase';
import { isAuthorized } from '@/lib/auth';
import { normalizeTags } from '@/lib/normalizeTags';
import { EVENT_PRIORITIES } from '@/lib/eventMetadata';
import { HABIT_CADENCES, HABIT_STATUSES } from '@/lib/habits';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};

  if (body.title !== undefined) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      return Response.json({ error: 'title cannot be empty' }, { status: 400 });
    }
    patch.title = title;
  }

  if (body.description !== undefined) {
    patch.description = typeof body.description === 'string' ? body.description : null;
  }

  if (body.cadence !== undefined) {
    if (!HABIT_CADENCES.includes(body.cadence)) {
      return Response.json({ error: `"cadence" must be one of ${HABIT_CADENCES.join(', ')}` }, { status: 400 });
    }
    patch.cadence = body.cadence;
  }

  if (body.target_count !== undefined) {
    if (!Number.isInteger(body.target_count) || body.target_count <= 0) {
      return Response.json({ error: '"target_count" must be a positive integer' }, { status: 400 });
    }
    patch.target_count = body.target_count;
  }

  if (body.occurrence_duration_minutes !== undefined) {
    if (
      body.occurrence_duration_minutes !== null &&
      (!Number.isInteger(body.occurrence_duration_minutes) || body.occurrence_duration_minutes <= 0)
    ) {
      return Response.json(
        { error: '"occurrence_duration_minutes" must be a positive integer or null' },
        { status: 400 }
      );
    }
    patch.occurrence_duration_minutes = body.occurrence_duration_minutes;
  }

  if (body.interval_days !== undefined) {
    if (body.interval_days !== null && (!Number.isInteger(body.interval_days) || body.interval_days <= 0)) {
      return Response.json({ error: '"interval_days" must be a positive integer or null' }, { status: 400 });
    }
    patch.interval_days = body.interval_days;
  }

  if (patch.cadence === 'interval' && patch.interval_days === undefined) {
    return Response.json(
      { error: '"interval_days" is required in the same request when setting cadence to "interval"' },
      { status: 400 }
    );
  }

  if (body.priority !== undefined) {
    if (body.priority !== null && !EVENT_PRIORITIES.includes(body.priority)) {
      return Response.json(
        { error: `"priority" must be one of ${EVENT_PRIORITIES.join(', ')}, or null` },
        { status: 400 }
      );
    }
    patch.priority = body.priority;
  }

  if (body.tags !== undefined) {
    patch.tags = normalizeTags(body.tags);
  }

  if (body.status !== undefined) {
    if (!HABIT_STATUSES.includes(body.status)) {
      return Response.json({ error: `"status" must be one of ${HABIT_STATUSES.join(', ')}` }, { status: 400 });
    }
    patch.status = body.status;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json(
      {
        error:
          'At least one of title, description, cadence, interval_days, target_count, occurrence_duration_minutes, priority, tags, status is required',
      },
      { status: 400 }
    );
  }

  const { data, error } = await supabase.from('habits').update(patch).eq('id', id).select('*');

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return Response.json({ error: `No habit with id "${id}"` }, { status: 404 });
  }

  return Response.json(data[0]);
}
