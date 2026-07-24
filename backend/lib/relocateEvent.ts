import { calendar } from './googleCalendar';
import { getSchedulingConfig, type SchedulingConfig } from './schedulingConfig';
import { findFreeSlots } from './freeSlots';
import { decodeEventMetadata, decodeEventTags } from './eventMetadata';
import { createProposedChange, ValidationError, NotFoundError, type ProposedChangeRow } from './proposedChanges';

const BURNER_CALENDAR_ID = process.env.GOOGLE_BURNER_CALENDAR_ID!;
// Same horizon as lib/proposedChanges.ts's attemptBump (item 24) — no
// particular reason to diverge, both are "find this specific thing a new
// home" searches.
const DEFAULT_SEARCH_HORIZON_DAYS = 14;

export interface RelocateEventResult {
  eventId: string;
  searchFrom: string;
  searchTo: string;
  outcome: 'proposed' | 'no-slot-available';
  proposal?: ProposedChangeRow;
}

// Phase 3.5 item 31 ("relocate a specific event") — collapses the
// get_events -> find_free_slots -> propose_change three-call NL pattern for
// "push my dentist thing to next week, whenever's free" into one call. The
// actual search logic already existed (lib/autoReschedule.ts's mover
// relocation, lib/proposedChanges.ts's attemptBump) — this just makes it
// addressable for one specific, named event rather than only ever running
// across a whole conflict scan or a bump's occupant list.
export async function relocateEvent(
  eventId: string,
  searchFrom: string | undefined,
  searchTo: string | undefined,
  bumpIfMovable = false,
  config: SchedulingConfig = getSchedulingConfig()
): Promise<RelocateEventResult> {
  let event;
  try {
    ({ data: event } = await calendar.events.get({ calendarId: BURNER_CALENDAR_ID, eventId }));
  } catch (err) {
    const status = (err as { code?: number; response?: { status?: number } }).code;
    if (status === 404 || status === 410) {
      throw new NotFoundError(`No calendar event with id "${eventId}"`);
    }
    throw err;
  }

  if (!event.start?.dateTime || !event.end?.dateTime) {
    // All-day events never participate in scheduling (lib/busyIntervals.ts
    // treats them as notes, not busy time) — "relocate" doesn't have a
    // meaningful timed destination to search for.
    throw new ValidationError(`Event "${eventId}" is all-day — relocate only applies to timed events`);
  }

  const currentStart = new Date(event.start.dateTime);
  const currentEnd = new Date(event.end.dateTime);
  const durationMs = currentEnd.getTime() - currentStart.getTime();
  const durationMinutes = Math.max(1, Math.round(durationMs / 60_000));

  const meta = decodeEventMetadata(event.extendedProperties);
  const category = meta.type ?? 'meeting';
  const tags = decodeEventTags(meta.tags);

  const rangeStart = searchFrom ? new Date(searchFrom) : new Date();
  const rangeEnd = searchTo
    ? new Date(searchTo)
    : new Date(rangeStart.getTime() + DEFAULT_SEARCH_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime())) {
    throw new ValidationError('"search_from"/"search_to" must be valid ISO datetimes');
  }
  if (rangeEnd.getTime() <= rangeStart.getTime()) {
    throw new ValidationError('"search_to" must be later than "search_from"');
  }

  const effectiveStart = new Date(Math.max(rangeStart.getTime(), Date.now()));

  const result: RelocateEventResult = {
    eventId,
    searchFrom: rangeStart.toISOString(),
    searchTo: rangeEnd.toISOString(),
    outcome: 'no-slot-available',
  };

  if (effectiveStart.getTime() >= rangeEnd.getTime()) {
    return result;
  }

  const { slots } = await findFreeSlots(effectiveStart, rangeEnd, {
    minDurationMinutes: durationMinutes,
    config,
    category,
    tags,
  });
  if (slots.length === 0) {
    return result;
  }

  const chosenStart = slots[0].start;
  const chosenEnd = chosenStart + durationMs;

  const proposal = await createProposedChange({
    change_type: 'move',
    category,
    source_system: 'ai-engine',
    target_event_id: eventId,
    proposed_start: new Date(chosenStart).toISOString(),
    proposed_end: new Date(chosenEnd).toISOString(),
    tags,
    bump_if_movable: bumpIfMovable,
    reason: `Relocated within [${result.searchFrom}, ${result.searchTo})`,
  });

  result.outcome = 'proposed';
  result.proposal = proposal;
  return result;
}
