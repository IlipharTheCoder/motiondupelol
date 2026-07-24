import { isAuthorized } from '@/lib/auth';
import { relocateEvent } from '@/lib/relocateEvent';
import { ValidationError, NotFoundError } from '@/lib/proposedChanges';

export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (typeof body !== 'object' || body === null) {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }

  if (body.search_from !== undefined && typeof body.search_from !== 'string') {
    return Response.json({ error: '"search_from" must be a string' }, { status: 400 });
  }
  if (body.search_to !== undefined && typeof body.search_to !== 'string') {
    return Response.json({ error: '"search_to" must be a string' }, { status: 400 });
  }
  if (body.bump_if_movable !== undefined && typeof body.bump_if_movable !== 'boolean') {
    return Response.json({ error: '"bump_if_movable" must be a boolean' }, { status: 400 });
  }

  try {
    const result = await relocateEvent(id, body.search_from, body.search_to, body.bump_if_movable === true);
    return Response.json(result);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof ValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
