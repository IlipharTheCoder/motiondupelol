import { supabase } from '@/lib/supabase';
import { isAuthorized } from '@/lib/auth';
import { normalizeTags } from '@/lib/normalizeTags';
import { InboxStatus } from '@/lib/inboxStatus';
import { EVENT_PRIORITIES } from '@/lib/eventMetadata';

const VALID_STATUSES: number[] = Object.values(InboxStatus);

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

  if (body.tags !== undefined) {
    patch.tags = normalizeTags(body.tags);
  }

  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) {
      return Response.json({ error: `"status" must be one of ${VALID_STATUSES.join(', ')}` }, { status: 400 });
    }
    patch.status = body.status;
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

  if (Object.keys(patch).length === 0) {
    return Response.json(
      { error: 'At least one of title, description, tags, status, priority is required' },
      { status: 400 }
    );
  }

  const { data, error } = await supabase.from('inbox_items').update(patch).eq('id', id).select('*');

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return Response.json({ error: `No inbox item with id "${id}"` }, { status: 404 });
  }

  return Response.json(data[0]);
}
