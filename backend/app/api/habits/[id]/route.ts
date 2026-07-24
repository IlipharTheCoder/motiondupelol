import { isAuthorized } from '@/lib/auth';
import { ValidationError, NotFoundError } from '@/lib/proposedChanges';
import { updateHabit } from '@/lib/habitsWrite';

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }

  try {
    const row = await updateHabit(id, body);
    return Response.json(row);
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof NotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
