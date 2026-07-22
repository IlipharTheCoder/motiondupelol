import { isAuthorized } from '@/lib/auth';
import {
  updateProposedChangeFields,
  describeProposalOutcome,
  ValidationError,
  ConflictError,
  NotFoundError,
} from '@/lib/proposedChanges';

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
    const row = await updateProposedChangeFields(id, {
      priority: body.priority,
      tags: body.tags,
    });
    return Response.json({ ...row, message: describeProposalOutcome(row) });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof NotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof ConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
