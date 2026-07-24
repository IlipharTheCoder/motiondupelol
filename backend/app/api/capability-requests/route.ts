import { supabase } from '@/lib/supabase';
import { isAuthorized } from '@/lib/auth';
import { CAPABILITY_REQUEST_STATUSES, type CapabilityRequestStatus } from '@/lib/capabilityRequests';

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');
  if (status && !CAPABILITY_REQUEST_STATUSES.includes(status as CapabilityRequestStatus)) {
    return Response.json(
      { error: `"status" must be one of ${CAPABILITY_REQUEST_STATUSES.join(', ')}` },
      { status: 400 }
    );
  }

  let query = supabase.from('capability_requests').select('*').order('created_at', { ascending: false });
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

  const requestedCapability = typeof body.requested_capability === 'string' ? body.requested_capability.trim() : '';
  if (!requestedCapability) {
    return Response.json({ error: 'requested_capability is required' }, { status: 400 });
  }

  const examplePhrase = typeof body.example_phrase === 'string' ? body.example_phrase : null;
  const context = typeof body.context === 'string' ? body.context : null;

  const { data, error } = await supabase
    .from('capability_requests')
    .insert({
      requested_capability: requestedCapability,
      example_phrase: examplePhrase,
      context,
      status: 'open',
    })
    .select('*')
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data);
}
