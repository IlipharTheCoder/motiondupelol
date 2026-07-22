import { isAuthorized } from '@/lib/auth';
import {
  createProposedChange,
  listProposedChanges,
  describeProposalOutcome,
  ValidationError,
  type ProposalStatus,
} from '@/lib/proposedChanges';

const VALID_STATUSES: ProposalStatus[] = ['pending', 'applied', 'rejected', 'failed'];

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');
  if (status && !VALID_STATUSES.includes(status as ProposalStatus)) {
    return Response.json({ error: `"status" must be one of ${VALID_STATUSES.join(', ')}` }, { status: 400 });
  }

  try {
    const rows = await listProposedChanges(status as ProposalStatus | undefined);
    return Response.json(rows);
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }

  try {
    const row = await createProposedChange(body);
    return Response.json({ ...row, message: describeProposalOutcome(row) });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
