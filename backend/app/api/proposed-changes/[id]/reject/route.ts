import { isAuthorized } from '@/lib/auth';
import { rejectProposedChange, ConflictError, NotFoundError } from '@/lib/proposedChanges';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    const row = await rejectProposedChange(id);
    return Response.json(row);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof ConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
