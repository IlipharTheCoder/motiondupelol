import { isAuthorized } from '@/lib/auth';
import { ValidationError } from '@/lib/proposedChanges';
import { createSchedulingRule, listSchedulingRules } from '@/lib/schedulingRulesQuery';

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const activeParam = searchParams.get('active');
  if (activeParam !== null && activeParam !== 'true' && activeParam !== 'false') {
    return Response.json({ error: '"active" must be "true" or "false"' }, { status: 400 });
  }

  try {
    const rows = await listSchedulingRules(activeParam === null ? undefined : activeParam === 'true');
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
    const row = await createSchedulingRule(body);
    return Response.json(row);
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
