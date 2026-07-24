import { isAuthorized } from '@/lib/auth';
import { rejectProposalGroup, NotFoundError } from '@/lib/proposedChanges';

export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ groupId: string }> }) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { groupId } = await params;

  try {
    const summary = await rejectProposalGroup(groupId);
    return Response.json(summary);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
