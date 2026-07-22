import { supabase } from '@/lib/supabase';
import { isAuthorized } from '@/lib/auth';

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
