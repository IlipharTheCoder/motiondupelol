import { isAuthorized } from '@/lib/auth';
import { suggestFocusTimeOptions } from '@/lib/focusTime';
import { ValidationError } from '@/lib/proposedChanges';

export const maxDuration = 60;

export async function POST(request: Request) {
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

  const durationParam = searchParams.get('durationMinutes');
  let durationMinutes: number | undefined;
  if (durationParam !== null) {
    durationMinutes = Number(durationParam);
    if (!Number.isFinite(durationMinutes)) {
      return Response.json({ error: '"durationMinutes" must be a number' }, { status: 400 });
    }
  }

  const maxOptionsParam = searchParams.get('maxOptions');
  let maxOptions: number | undefined;
  if (maxOptionsParam !== null) {
    maxOptions = Number(maxOptionsParam);
    if (!Number.isInteger(maxOptions)) {
      return Response.json({ error: '"maxOptions" must be an integer' }, { status: 400 });
    }
  }

  try {
    const result = await suggestFocusTimeOptions(rangeStart, rangeEnd, { durationMinutes, maxOptions });
    return Response.json(result);
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
