import { isAuthorized } from '@/lib/auth';
import { findFreeSlots } from '@/lib/freeSlots';

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

  const rangeStart = new Date(from);
  const rangeEnd = new Date(to);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime())) {
    return Response.json({ error: '"from"/"to" must be valid ISO datetimes' }, { status: 400 });
  }
  if (rangeEnd.getTime() <= rangeStart.getTime()) {
    return Response.json({ error: '"to" must be later than "from"' }, { status: 400 });
  }

  let minDurationMinutes: number | undefined;
  let paddingMinutes: number | undefined;
  try {
    minDurationMinutes = parseOptionalNonNegativeInt(searchParams.get('minDurationMinutes'), 'minDurationMinutes');
    paddingMinutes = parseOptionalNonNegativeInt(searchParams.get('paddingMinutes'), 'paddingMinutes');
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  try {
    const result = await findFreeSlots(rangeStart, rangeEnd, { minDurationMinutes, paddingMinutes });

    return Response.json({
      rangeStart: result.rangeStart,
      rangeEnd: result.rangeEnd,
      slots: result.slots.map((slot) => ({
        start: new Date(slot.start).toISOString(),
        end: new Date(slot.end).toISOString(),
      })),
    });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
