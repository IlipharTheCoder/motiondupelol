import { supabase } from '@/lib/supabase';

export async function GET() {
  const { data, error } = await supabase
    .from('inbox_items')
    .select('*');

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data);
}