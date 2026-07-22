import { isAuthorized } from '@/lib/auth';
import { detectConflicts } from '@/lib/freeSlots';

function parseOptionalNonNegativeInt(raw: string | null, name: string): number | undefined {
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`"${name}" must be a non-negative number`);
  }
  return value;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  if (!from || !to) {
    return Response.json({ error: '"from" and "to" query params are required (ISO datetime)' }, { status: 400 });
  }

  const candidateStart = new Date(from);
  const candidateEnd = new Date(to);
  if (Number.isNaN(candidateStart.getTime()) || Number.isNaN(candidateEnd.getTime())) {
    return Response.json({ error: '"from"/"to" must be valid ISO datetimes' }, { status: 400 });
  }
  if (candidateEnd.getTime() <= candidateStart.getTime()) {
    return Response.json({ error: '"to" must be later than "from"' }, { status: 400 });
  }

  let paddingMinutes: number | undefined;
  try {
    paddingMinutes = parseOptionalNonNegativeInt(searchParams.get('paddingMinutes'), 'paddingMinutes');
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  const excludeEventId = searchParams.get('excludeEventId') ?? undefined;

  try {
    const result = await detectConflicts(candidateStart, candidateEnd, { excludeEventId, paddingMinutes });

    return Response.json({
      hasConflict: result.hasConflict,
      conflicts: result.conflicts.map((conflict) => ({
        eventId: conflict.eventId,
        summary: conflict.summary,
        start: new Date(conflict.start).toISOString(),
        end: new Date(conflict.end).toISOString(),
        isAllDay: conflict.isAllDay,
      })),
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
