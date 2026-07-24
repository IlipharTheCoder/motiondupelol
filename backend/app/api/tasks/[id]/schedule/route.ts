import { isAuthorized } from '@/lib/auth';
import { linkTaskToExistingEvent, scheduleTaskToNewEvent } from '@/lib/aiTasks';
import { ValidationError, ConflictError, NotFoundError } from '@/lib/proposedChanges';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }

  const hasEventId = typeof body.event_id === 'string' && body.event_id.length > 0;
  const hasNewTimes = typeof body.proposed_start === 'string' && typeof body.proposed_end === 'string';

  if (hasEventId === hasNewTimes) {
    return Response.json(
      { error: 'Provide exactly one of "event_id" or ("proposed_start" and "proposed_end")' },
      { status: 400 }
    );
  }

  if (body.bumpIfMovable !== undefined && typeof body.bumpIfMovable !== 'boolean') {
    return Response.json({ error: '"bumpIfMovable" must be a boolean' }, { status: 400 });
  }

  try {
    if (hasEventId) {
      const actor = body.actor;
      if (actor !== 'user' && actor !== 'ai-engine') {
        return Response.json(
          { error: '"actor" must be "user" or "ai-engine" when linking to an existing event' },
          { status: 400 }
        );
      }
      const result = await linkTaskToExistingEvent(id, body.event_id, actor);
      return Response.json(result);
    }

    const result = await scheduleTaskToNewEvent(
      id,
      body.proposed_start,
      body.proposed_end,
      body.bumpIfMovable === true
    );
    return Response.json(result);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof ConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
