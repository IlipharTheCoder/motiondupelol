import { isAuthorized } from '@/lib/auth';
import { createProposedChangesBatch, ValidationError, type ProposedChangeInput } from '@/lib/proposedChanges';

export const maxDuration = 60;

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }
  if (!Array.isArray(body.proposals)) {
    return Response.json({ error: '"proposals" must be an array' }, { status: 400 });
  }
  if (body.reason !== undefined && typeof body.reason !== 'string') {
    return Response.json({ error: '"reason" must be a string' }, { status: 400 });
  }

  try {
    const summary = await createProposedChangesBatch(body.proposals as ProposedChangeInput[], body.reason);
    return Response.json(summary);
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
