import { randomUUID } from 'crypto';
import { getSchedulingConfig, type SchedulingConfig } from './schedulingConfig';
import { normalizeTags } from './normalizeTags';
import type { BurnerEventType, EventPriority } from './eventMetadata';
import { createProposedChange, type ProposedChangeRow } from './proposedChanges';
import { generateWeeklyOccurrences } from './recurringOccurrences';

export interface RecurringSeriesInput {
  category: BurnerEventType;
  proposed_summary: string;
  proposed_description?: string;
  priority?: EventPriority;
  flexible?: 'true' | 'false';
  first_start: string;
  first_end: string;
  interval_weeks?: number;
  count?: number;
  until?: string;
  tags?: string[];
  bump_if_movable?: boolean;
  reason?: string;
}

export interface RecurringOccurrenceResult {
  index: number;
  start: string;
  end: string;
  outcome: 'proposed' | 'skipped-error';
  proposal?: ProposedChangeRow;
  reason?: string;
}

export interface RecurringSeriesSummary {
  seriesTag: string;
  occurrencesRequested: number;
  truncated: boolean;
  proposalsCreated: number;
  skippedErrors: number;
  results: RecurringOccurrenceResult[];
}

// Phase 4/5 item 25 ("Recurring events"), Option B — of the two shapes
// weighed (native Google `recurrence`/RRULE vs. synthesizing N individual
// `create` proposals), this backend chose synthesis specifically because
// items 13/14 (event tags + bulk-edit) already solve Option B's weakness:
// every occurrence shares one system-generated `series:<uuid>` tag, so
// "edit/cancel the whole series" later is just POST /api/calendar/bulk-edit
// with that tag — no bespoke tracking table. Each occurrence is an ordinary
// create proposal, so it gets the exact same per-instance conflict check at
// apply time as any other create (`applyProposedChange`'s existing
// `detectConflicts` call) — no new batch conflict-checking logic needed,
// which is the other half of why Option B was chosen over RRULE here.
// Confirmed with the user: count/until is required (no default horizon), so
// there's no "silently ran out, who regenerates" gap to solve either — a
// still-wanted indefinite series just means calling this again later.
export async function planRecurringSeries(
  input: RecurringSeriesInput,
  config: SchedulingConfig = getSchedulingConfig()
): Promise<RecurringSeriesSummary> {
  const seriesTag = `series:${randomUUID()}`;
  const intervalWeeks = input.interval_weeks ?? 1;

  const { occurrences, truncated } = generateWeeklyOccurrences(
    input.first_start,
    input.first_end,
    intervalWeeks,
    config,
    input.count,
    input.until
  );

  const tags = normalizeTags([seriesTag, ...(input.tags ?? [])]);

  const summary: RecurringSeriesSummary = {
    seriesTag,
    occurrencesRequested: occurrences.length,
    truncated,
    proposalsCreated: 0,
    skippedErrors: 0,
    results: [],
  };

  for (let i = 0; i < occurrences.length; i++) {
    const occ = occurrences[i];
    try {
      const proposal = await createProposedChange({
        change_type: 'create',
        category: input.category,
        // Same as lib/bulkEdit.ts's fan-out — this engine's own writes, not
        // caller-attributed, so source_system is fixed rather than a
        // request field.
        source_system: 'ai-engine',
        flexible: input.flexible,
        priority: input.priority,
        proposed_summary: input.proposed_summary,
        proposed_description: input.proposed_description,
        proposed_start: occ.start,
        proposed_end: occ.end,
        tags,
        bump_if_movable: input.bump_if_movable,
        reason: input.reason,
      });
      summary.proposalsCreated++;
      summary.results.push({ index: i + 1, start: occ.start, end: occ.end, outcome: 'proposed', proposal });
    } catch (err) {
      // One occurrence's failure (e.g. it auto-applies and hits a conflict)
      // shouldn't abort the rest of the series — same principle as every
      // other fan-out engine in this codebase.
      summary.skippedErrors++;
      summary.results.push({
        index: i + 1,
        start: occ.start,
        end: occ.end,
        outcome: 'skipped-error',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
