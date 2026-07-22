import { supabase } from '@/lib/supabase';
import { isAuthorized } from '@/lib/auth';
import { normalizeTags } from '@/lib/normalizeTags';
import { InboxStatus } from '@/lib/inboxStatus';

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data, error } = await supabase
    .from('inbox_items')
    .select('*');

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
  const title = typeof body?.title === 'string' ? body.title.trim() : '';

  if (!title) {
    return Response.json({ error: 'title is required' }, { status: 400 });
  }

  const description = typeof body?.description === 'string' ? body.description : null;
  const tags = normalizeTags(body?.tags);

  const { data, error } = await supabase
    .from('inbox_items')
    .insert({ title, description, tags, image_url: null, status: InboxStatus.NEW })
    .select('*');

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data);
}
