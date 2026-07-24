import { getSchedulingConfig, type SchedulingConfig } from './schedulingConfig';
import { normalizeTags } from './normalizeTags';
import type { EventPriority, BurnerEventType } from './eventMetadata';
import { fetchSchedulableEvents, type SchedulableEvent } from './autoReschedule';
import {
  createProposedChange,
  ValidationError,
  type ProposedChangeInput,
  type ProposedChangeRow,
} from './proposedChanges';

export type BulkEditAction = 'update' | 'delete' | 'move';

export interface BulkEditInput {
  tag: string;
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

export interface BulkEditSummary {
  tag: string;
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
  const tag = normalizeTags([input.tag])[0];
  if (!tag) {
    throw new ValidationError('"tag" is required');
  }

  const rangeStart = new Date(input.from);
  const rangeEnd = new Date(input.to);
  if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime())) {
    throw new ValidationError('"from"/"to" must be valid ISO datetimes');
  }
  if (rangeEnd.getTime() <= rangeStart.getTime()) {
    throw new ValidationError('"to" must be later than "from"');
  }

  const events = await fetchSchedulableEvents(rangeStart, rangeEnd, config);
  const matches = events.filter((e) => e.tags.includes(tag));

  const summary: BulkEditSummary = {
    tag,
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
