import { isAuthorized } from '@/lib/auth';
import { EVENT_PRIORITIES, BURNER_EVENT_TYPES, type EventPriority, type BurnerEventType } from '@/lib/eventMetadata';
import { planBulkEdit, type BulkEditAction, type BulkEditInput } from '@/lib/bulkEdit';
import { ValidationError } from '@/lib/proposedChanges';

export const maxDuration = 60;

const ACTIONS: BulkEditAction[] = ['update', 'delete', 'move'];

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'Request body must be JSON' }, { status: 400 });
  }

  // "tag" is no longer the only way to select events (item 29) — it stays
  // valid alone, but planBulkEdit is what actually enforces "at least one
  // filter is required" now that there are several to choose from.
  if (body.tag !== undefined && (typeof body.tag !== 'string' || !body.tag.trim())) {
    return Response.json({ error: '"tag" must be a non-empty string if provided' }, { status: 400 });
  }
  if (typeof body.from !== 'string' || typeof body.to !== 'string') {
    return Response.json({ error: '"from" and "to" are required' }, { status: 400 });
  }
  if (!ACTIONS.includes(body.action)) {
    return Response.json({ error: `"action" must be one of ${ACTIONS.join(', ')}` }, { status: 400 });
  }

  if (body.priority !== undefined && body.priority !== null && !EVENT_PRIORITIES.includes(body.priority)) {
    return Response.json(
      { error: `"priority" must be one of ${EVENT_PRIORITIES.join(', ')}` },
      { status: 400 }
    );
  }

  if (
    body.category !== undefined &&
    (!Array.isArray(body.category) ||
      body.category.length === 0 ||
      body.category.some((c: unknown) => typeof c !== 'string' || !BURNER_EVENT_TYPES.includes(c as BurnerEventType)))
  ) {
    return Response.json(
      { error: `"category" must be a non-empty array of ${BURNER_EVENT_TYPES.join(', ')}` },
      { status: 400 }
    );
  }
  if (
    body.priority_in !== undefined &&
    (!Array.isArray(body.priority_in) ||
      body.priority_in.length === 0 ||
      body.priority_in.some((p: unknown) => typeof p !== 'string' || !EVENT_PRIORITIES.includes(p as EventPriority)))
  ) {
    return Response.json(
      { error: `"priority_in" must be a non-empty array of ${EVENT_PRIORITIES.join(', ')}` },
      { status: 400 }
    );
  }
  if (body.starts_after !== undefined && typeof body.starts_after !== 'string') {
    return Response.json({ error: '"starts_after" must be a string' }, { status: 400 });
  }
  if (body.starts_before !== undefined && typeof body.starts_before !== 'string') {
    return Response.json({ error: '"starts_before" must be a string' }, { status: 400 });
  }
  if (
    body.summary_contains !== undefined &&
    (typeof body.summary_contains !== 'string' || !body.summary_contains.trim())
  ) {
    return Response.json({ error: '"summary_contains" must be a non-empty string if provided' }, { status: 400 });
  }
  if (
    body.exclude_event_ids !== undefined &&
    (!Array.isArray(body.exclude_event_ids) || body.exclude_event_ids.some((id: unknown) => typeof id !== 'string'))
  ) {
    return Response.json({ error: '"exclude_event_ids" must be an array of strings' }, { status: 400 });
  }

  if (body.action === 'update') {
    const hasField =
      body.proposed_summary !== undefined ||
      body.proposed_description !== undefined ||
      body.priority !== undefined ||
      body.deadline !== undefined ||
      body.tags_add !== undefined ||
      body.tags_remove !== undefined;
    if (!hasField) {
      return Response.json(
        {
          error:
            'action "update" requires at least one of proposed_summary, proposed_description, priority, deadline, tags_add, tags_remove',
        },
        { status: 400 }
      );
    }
  }

  if (body.action === 'move') {
    if (!Number.isFinite(body.time_delta_minutes) || body.time_delta_minutes === 0) {
      return Response.json(
        { error: '"time_delta_minutes" is required and must be a nonzero finite number for action "move"' },
        { status: 400 }
      );
    }
  }

  const input: BulkEditInput = {
    tag: body.tag,
    category: body.category,
    priority_in: body.priority_in,
    starts_after: body.starts_after,
    starts_before: body.starts_before,
    summary_contains: body.summary_contains,
    exclude_event_ids: body.exclude_event_ids,
    from: body.from,
    to: body.to,
    action: body.action,
    proposed_summary: body.proposed_summary,
    proposed_description: body.proposed_description,
    priority: body.priority,
    deadline: body.deadline,
    tags_add: body.tags_add,
    tags_remove: body.tags_remove,
    time_delta_minutes: body.time_delta_minutes,
    reason: body.reason,
  };

  try {
    const summary = await planBulkEdit(input);
    return Response.json(summary);
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
