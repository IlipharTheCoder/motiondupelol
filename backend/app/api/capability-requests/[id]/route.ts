import { supabase } from '@/lib/supabase';
import { isAuthorized } from '@/lib/auth';
import { CAPABILITY_REQUEST_STATUSES } from '@/lib/capabilityRequests';

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

  if (body.requested_capability !== undefined) {
    const requestedCapability =
      typeof body.requested_capability === 'string' ? body.requested_capability.trim() : '';
    if (!requestedCapability) {
      return Response.json({ error: 'requested_capability cannot be empty' }, { status: 400 });
    }
    patch.requested_capability = requestedCapability;
  }

  if (body.example_phrase !== undefined) {
    patch.example_phrase = typeof body.example_phrase === 'string' ? body.example_phrase : null;
  }

  if (body.context !== undefined) {
    patch.context = typeof body.context === 'string' ? body.context : null;
  }

  if (body.status !== undefined) {
    if (!CAPABILITY_REQUEST_STATUSES.includes(body.status)) {
      return Response.json(
        { error: `"status" must be one of ${CAPABILITY_REQUEST_STATUSES.join(', ')}` },
        { status: 400 }
      );
    }
    patch.status = body.status;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json(
      { error: 'At least one of requested_capability, example_phrase, context, status is required' },
      { status: 400 }
    );
  }

  const { data, error } = await supabase.from('capability_requests').update(patch).eq('id', id).select('*');

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return Response.json({ error: `No capability request with id "${id}"` }, { status: 404 });
  }

  return Response.json(data[0]);
}
