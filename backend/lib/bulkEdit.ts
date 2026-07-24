import { DateTime } from 'luxon';
import { getSchedulingConfig, parseTimeOfDay, type SchedulingConfig, type TimeOfDay } from './schedulingConfig';
import { normalizeTags } from './normalizeTags';
import { EVENT_PRIORITIES, BURNER_EVENT_TYPES, type EventPriority, type BurnerEventType } from './eventMetadata';
import { fetchSchedulableEvents, type SchedulableEvent } from './autoReschedule';
import {
  createProposedChange,
  ValidationError,
  type ProposedChangeInput,
  type ProposedChangeRow,
} from './proposedChanges';

export type BulkEditAction = 'update' | 'delete' | 'move';

export interface BulkEditInput {
  // Match filters (Phase 3.5 item 29) — at least one required, AND-composed
  // when more than one is given. `tag` is the original selector and still
  // works alone, unchanged. `priority_in` (not `priority`) deliberately —
  // `priority` below is already "what to set matching events' priority to"
  // for action:'update'; reusing that name for "match events whose current
  // priority is X" would silently collide with it.
  tag?: string;
  category?: BurnerEventType[];
  priority_in?: EventPriority[];
  starts_after?: string; // "HH:mm", local to HOME_TIMEZONE, inclusive
  starts_before?: string; // "HH:mm", local to HOME_TIMEZONE, exclusive
  summary_contains?: string; // case-insensitive substring match
  exclude_event_ids?: string[]; // e.g. "cancel my meetings except the manager one"

  from: string;
  to: string;
  action: BulkEditAction;
  proposed_summary?: string;
  proposed_description?: string;
  priority?: EventPriority;
  deadline?: string;
  tags_add?: string[];
  tags_remove?: string[];
  time_delta_minutes?: number;
  reason?: string;
}

export interface BulkEditResultEntry {
  eventId: string;
  summary: string | null;
  outcome: 'proposed' | 'skipped-error';
  proposal?: ProposedChangeRow;
  reason?: string;
}

export interface BulkEditFilterEcho {
  tag: string | null;
  category: BurnerEventType[] | null;
  priority_in: EventPriority[] | null;
  starts_after: string | null;
  starts_before: string | null;
  summary_contains: string | null;
  exclude_event_ids: string[] | null;
}

export interface BulkEditSummary {
  filters: BulkEditFilterEcho;
  rangeStart: string;
  rangeEnd: string;
  action: BulkEditAction;
  eventsMatched: number;
  proposalsCreated: number;
  skippedErrors: number;
  results: BulkEditResultEntry[];
}

function buildChangeInput(input: BulkEditInput, match: SchedulableEvent): ProposedChangeInput {
  const category: BurnerEventType = match.category;

  if (input.action === 'delete') {
    return {
      change_type: 'delete',
      category,
      source_system: 'ai-engine',
      target_event_id: match.eventId,
      reason: input.reason,
    };
  }

  if (input.action === 'move') {
    const deltaMs = input.time_delta_minutes! * 60_000;
    return {
      change_type: 'move',
      category,
      source_system: 'ai-engine',
      target_event_id: match.eventId,
      proposed_start: new Date(match.interval.start + deltaMs).toISOString(),
      proposed_end: new Date(match.interval.end + deltaMs).toISOString(),
      reason: input.reason,
    };
  }

  // 'update' — add/remove specific tags rather than replacing the whole set,
  // so a bulk update never silently strips an unrelated tag (e.g. a future
  // recurring series' own series:<uuid> linking tag). Computed here, before
  // calling createProposedChange, since the underlying single-event 'update'
  // proposal is replace-if-provided (lib/proposedChanges.ts).
  const remove = new Set(normalizeTags(input.tags_remove ?? []));
  const resolvedTags = normalizeTags([
    ...match.tags.filter((t) => !remove.has(t)),
    ...(input.tags_add ?? []),
  ]);

  return {
    change_type: 'update',
    category,
    source_system: 'ai-engine',
    target_event_id: match.eventId,
    proposed_summary: input.proposed_summary,
    proposed_description: input.proposed_description,
    priority: input.priority,
    deadline: input.deadline,
    tags: resolvedTags,
    reason: input.reason,
  };
}

function timeOfDayMinutes(t: TimeOfDay): number {
  return t.hour * 60 + t.minute;
}

interface ResolvedFilters {
  tag?: string;
  category?: BurnerEventType[];
  priorityIn?: EventPriority[];
  startsAfterMinutes?: number;
  startsBeforeMinutes?: number;
  summaryContains?: string;
  excludeIds?: Set<string>;
}

function matchesFilters(event: SchedulableEvent, filters: ResolvedFilters, homeTimezone: string): boolean {
  if (filters.excludeIds?.has(event.eventId)) return false;
  if (filters.tag && !event.tags.includes(filters.tag)) return false;
  if (filters.category && !filters.category.includes(event.category)) return false;
  if (filters.priorityIn && !filters.priorityIn.includes(event.priority)) return false;
  if (filters.summaryContains) {
    const summary = (event.summary ?? '').toLowerCase();
    if (!summary.includes(filters.summaryContains.toLowerCase())) return false;
  }
  if (filters.startsAfterMinutes !== undefined || filters.startsBeforeMinutes !== undefined) {
    // Time-of-day within the day, in HOME_TIMEZONE — not an absolute
    // timestamp comparison, so "everything after 3pm" matches that time on
    // every day inside [from, to), not just the first one.
    const startLocal = DateTime.fromMillis(event.interval.start, { zone: homeTimezone });
    const startMinutes = timeOfDayMinutes({ hour: startLocal.hour, minute: startLocal.minute });
    if (filters.startsAfterMinutes !== undefined && startMinutes < filters.startsAfterMinutes) return false;
    if (filters.startsBeforeMinutes !== undefined && startMinutes >= filters.startsBeforeMinutes) return false;
  }
  return true;
}

// Phase 4 items 13/14 ("Labels" + "Bulk actions"), built together as prep
// for item 25's Option B recurring events — a future recurring series would
// tag every instance with a shared series:<uuid>, making "edit/cancel the
// whole series" just a bulk-edit-by-tag call instead of needing a bespoke
// tracking table. Mirrors lib/habitPlacement.ts's planHabitPlacement shape:
// fetch candidates, then a per-item try/catch loop that records each
// outcome and never lets one item's failure abort the batch.
export async function planBulkEdit(
  input: BulkEditInput,
  config: SchedulingConfig = getSchedulingConfig()
): Promise<BulkEditSummary> {
  const tag = input.tag !== undefined ? normalizeTags([input.tag])[0] : undefined;
  if (input.tag !== undefined && !tag) {
    throw new ValidationError('"tag" must be a non-empty string if provided');
  }

  const category = input.category && input.category.length > 0 ? input.category : undefined;
  if (category?.some((c) => !BURNER_EVENT_TYPES.includes(c))) {
    throw new ValidationError(`"category" must only contain ${BURNER_EVENT_TYPES.join(', ')}`);
  }
  const priorityIn = input.priority_in && input.priority_in.length > 0 ? input.priority_in : undefined;
  if (priorityIn?.some((p) => !EVENT_PRIORITIES.includes(p))) {
    throw new ValidationError(`"priority_in" must only contain ${EVENT_PRIORITIES.join(', ')}`);
  }
  const summaryContains = input.summary_contains?.trim() || undefined;

  // exclude_event_ids never counts toward "at least one filter" on its own —
  // "everything in range except these ids" is still an unbounded selector,
  // just narrowed. It only makes sense layered on top of a real filter
  // (e.g. "cancel my meetings except the manager one" = category + this).
  const hasPositiveFilter =
    !!tag ||
    !!category ||
    !!priorityIn ||
    input.starts_after !== undefined ||
    input.starts_before !== undefined ||
    !!summaryContains;
  if (!hasPositiveFilter) {
    throw new ValidationError(
      'At least one match filter is required: "tag", "category", "priority_in", "starts_after", "starts_before", or "summary_contains" ("exclude_event_ids" alone only narrows another filter, it can\'t stand in for one)'
    );
  }

  // parseTimeOfDay is built for startup env-var parsing, where throwing a
  // plain Error (crashing the process on bad config) is correct — here it's
  // parsing a request field instead, so a malformed value needs to surface
  // as a 400, not a 500. Caught and re-thrown as ValidationError below
  // (caught live: without this, a bad "starts_after" 500'd instead of 400'ing).
  const parseTimeField = (raw: string, field: string) => {
    try {
      return parseTimeOfDay(raw, field);
    } catch (err) {
      throw new ValidationError(err instanceof Error ? err.message : String(err));
    }
  };
  const startsAfterMinutes =
    input.starts_after !== undefined ? timeOfDayMinutes(parseTimeField(input.starts_after, 'starts_after')) : undefined;
  const startsBeforeMinutes =
    input.starts_before !== undefined ? timeOfDayMinutes(parseTimeField(input.starts_before, 'starts_before')) : undefined;
  if (startsAfterMinutes !== undefined && startsBeforeMinutes !== undefined && startsBeforeMinutes <= startsAfterMinutes) {
    throw new ValidationError(
      '"starts_before" must be later than "starts_after" (overnight time-of-day windows are not supported, same as WORKING_HOURS_END/START)'
    );
  }

  const rangeStart = new Date(input.from);
  const rangeEnd = new Date(input.to);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime())) {
    throw new ValidationError('"from"/"to" must be valid ISO datetimes');
  }
  if (rangeEnd.getTime() <= rangeStart.getTime()) {
    throw new ValidationError('"to" must be later than "from"');
  }

  const excludeIds = input.exclude_event_ids && input.exclude_event_ids.length > 0 ? new Set(input.exclude_event_ids) : undefined;

  const events = await fetchSchedulableEvents(rangeStart, rangeEnd, config);
  const matches = events.filter((e) =>
    matchesFilters(e, { tag, category, priorityIn, startsAfterMinutes, startsBeforeMinutes, summaryContains, excludeIds }, config.homeTimezone)
  );

  const summary: BulkEditSummary = {
    filters: {
      tag: tag ?? null,
      category: category ?? null,
      priority_in: priorityIn ?? null,
      starts_after: input.starts_after ?? null,
      starts_before: input.starts_before ?? null,
      summary_contains: summaryContains ?? null,
      exclude_event_ids: excludeIds ? [...excludeIds] : null,
    },
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
    action: input.action,
    eventsMatched: matches.length,
    proposalsCreated: 0,
    skippedErrors: 0,
    results: [],
  };

  for (const match of matches) {
    try {
      const proposal = await createProposedChange(buildChangeInput(input, match));
      summary.proposalsCreated++;
      summary.results.push({
        eventId: match.eventId,
        summary: match.summary,
        outcome: 'proposed',
        proposal,
      });
    } catch (err) {
      // One event's failure (e.g. this specific update fails validation, or
      // auto-applies and hits a conflict) shouldn't abort the rest of the
      // batch — same principle as planHabitPlacement's per-habit try/catch.
      summary.skippedErrors++;
      summary.results.push({
        eventId: match.eventId,
        summary: match.summary,
        outcome: 'skipped-error',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
