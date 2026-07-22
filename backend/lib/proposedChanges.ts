import { calendar } from './googleCalendar';
import { supabase } from './supabase';
import {
  encodeEventMetadata,
  decodeEventMetadata,
  type BurnerEventType,
  type SourceSystem,
} from './eventMetadata';
import { detectConflicts } from './freeSlots';

const BURNER_CALENDAR_ID = process.env.GOOGLE_BURNER_CALENDAR_ID!;

export type ChangeType = 'create' | 'move' | 'update' | 'delete';
export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'failed';
export type DecidedBy = 'user' | 'auto-apply-policy';

export class ValidationError extends Error {}
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export interface ProposedChangeInput {
  change_type: ChangeType;
  category: BurnerEventType;
  flexible?: 'true' | 'false';
  source_system: SourceSystem;
  source_id?: string;
  target_event_id?: string;
  proposed_start?: string;
  proposed_end?: string;
  proposed_summary?: string;
  proposed_description?: string;
  priority?: '1' | '2' | '3' | '4' | '5';
  color_tag?: string;
  reason?: string;
}

export interface ProposedChangeRow extends ProposedChangeInput {
  id: string;
  status: ProposalStatus;
  decided_by: DecidedBy | null;
  decided_at: string | null;
  applied_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

const CHANGE_TYPES: ChangeType[] = ['create', 'move', 'update', 'delete'];
const BURNER_EVENT_TYPES: BurnerEventType[] = ['task', 'habit', 'focusTime', 'meeting', 'fixed', 'buffer'];

export function validateProposalInput(input: ProposedChangeInput): void {
  if (!CHANGE_TYPES.includes(input.change_type)) {
    throw new ValidationError(`"change_type" must be one of ${CHANGE_TYPES.join(', ')}`);
  }
  if (!BURNER_EVENT_TYPES.includes(input.category)) {
    throw new ValidationError(`"category" must be one of ${BURNER_EVENT_TYPES.join(', ')}`);
  }

  switch (input.change_type) {
    case 'create':
      if (input.target_event_id) {
        throw new ValidationError('"target_event_id" must not be set for a "create" change_type');
      }
      if (!input.proposed_start || !input.proposed_end || !input.proposed_summary) {
        throw new ValidationError(
          '"create" requires "proposed_start", "proposed_end", and "proposed_summary"'
        );
      }
      break;
    case 'move':
      if (!input.target_event_id) {
        throw new ValidationError('"move" requires "target_event_id"');
      }
      if (!input.proposed_start || !input.proposed_end) {
        throw new ValidationError('"move" requires "proposed_start" and "proposed_end"');
      }
      break;
    case 'update':
      if (!input.target_event_id) {
        throw new ValidationError('"update" requires "target_event_id"');
      }
      if (
        !input.proposed_start &&
        !input.proposed_end &&
        !input.proposed_summary &&
        !input.proposed_description &&
        !input.priority &&
        !input.color_tag
      ) {
        throw new ValidationError(
          '"update" requires at least one of "proposed_start", "proposed_end", "proposed_summary", "proposed_description", "priority", or "color_tag"'
        );
      }
      break;
    case 'delete':
      if (!input.target_event_id) {
        throw new ValidationError('"delete" requires "target_event_id"');
      }
      break;
  }
}

// Empty/unset = nothing auto-applies — same "safe default on unset, throw on
// malformed" convention as lib/schedulingConfig.ts.
export function getAutoApplyCategories(): Set<BurnerEventType> {
  const raw = process.env.AUTO_APPLY_CATEGORIES ?? '';
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const result = new Set<BurnerEventType>();
  for (const entry of entries) {
    if (!BURNER_EVENT_TYPES.includes(entry as BurnerEventType)) {
      throw new Error(
        `AUTO_APPLY_CATEGORIES entry "${entry}" is not a valid category (${BURNER_EVENT_TYPES.join(', ')})`
      );
    }
    result.add(entry as BurnerEventType);
  }
  return result;
}

async function getProposedChange(id: string): Promise<ProposedChangeRow> {
  const { data, error } = await supabase.from('proposed_changes').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`proposed_changes read failed: ${error.message}`);
  if (!data) throw new NotFoundError(`No proposed change with id "${id}"`);
  return data as ProposedChangeRow;
}

async function updateProposedChange(
  id: string,
  patch: Partial<ProposedChangeRow>
): Promise<ProposedChangeRow> {
  const { data, error } = await supabase
    .from('proposed_changes')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`proposed_changes update failed: ${error.message}`);
  return data as ProposedChangeRow;
}

export async function applyProposedChange(
  row: ProposedChangeRow,
  decidedBy: DecidedBy
): Promise<ProposedChangeRow> {
  const now = new Date().toISOString();

  try {
    if (row.change_type === 'create' || row.change_type === 'move') {
      const { hasConflict, conflicts } = await detectConflicts(
        new Date(row.proposed_start!),
        new Date(row.proposed_end!),
        { excludeEventId: row.target_event_id ?? undefined }
      );
      if (hasConflict) {
        const summaries = conflicts.map((c) => c.summary ?? c.eventId).join(', ');
        throw new Error(`Conflicts with existing event(s): ${summaries}`);
      }
    }

    let resultingEventId = row.target_event_id ?? null;

    if (row.change_type === 'create') {
      const { data } = await calendar.events.insert({
        calendarId: BURNER_CALENDAR_ID,
        requestBody: {
          summary: row.proposed_summary,
          description: row.proposed_description,
          start: { dateTime: row.proposed_start },
          end: { dateTime: row.proposed_end },
          extendedProperties: {
            private: encodeEventMetadata({
              schemaVersion: '1',
              type: row.category,
              flexible: row.flexible ?? 'true',
              sourceSystem: row.source_system,
              sourceId: row.source_id ?? row.id,
              sourceCalendarId: '',
              sourceLabel: '',
              priority: row.priority ?? '3',
              colorTag: row.color_tag ?? '',
            }),
          },
        },
      });
      resultingEventId = data.id!;
    } else if (row.change_type === 'move') {
      await calendar.events.patch({
        calendarId: BURNER_CALENDAR_ID,
        eventId: row.target_event_id!,
        requestBody: {
          start: { dateTime: row.proposed_start },
          end: { dateTime: row.proposed_end },
        },
      });
    } else if (row.change_type === 'update') {
      const { data: existing } = await calendar.events.get({
        calendarId: BURNER_CALENDAR_ID,
        eventId: row.target_event_id!,
      });
      const existingMeta = decodeEventMetadata(existing.extendedProperties);

      await calendar.events.patch({
        calendarId: BURNER_CALENDAR_ID,
        eventId: row.target_event_id!,
        requestBody: {
          ...(row.proposed_summary ? { summary: row.proposed_summary } : {}),
          ...(row.proposed_description ? { description: row.proposed_description } : {}),
          ...(row.proposed_start ? { start: { dateTime: row.proposed_start } } : {}),
          ...(row.proposed_end ? { end: { dateTime: row.proposed_end } } : {}),
          extendedProperties: {
            private: encodeEventMetadata({
              schemaVersion: '1',
              type: existingMeta.type ?? row.category,
              flexible: row.flexible ?? existingMeta.flexible ?? 'true',
              sourceSystem: existingMeta.sourceSystem ?? row.source_system,
              sourceId: existingMeta.sourceId ?? row.source_id ?? row.id,
              sourceCalendarId: existingMeta.sourceCalendarId ?? '',
              sourceLabel: existingMeta.sourceLabel ?? '',
              priority: row.priority ?? existingMeta.priority ?? '3',
              colorTag: row.color_tag ?? existingMeta.colorTag ?? '',
            }),
          },
        },
      });
    } else if (row.change_type === 'delete') {
      await calendar.events.delete({
        calendarId: BURNER_CALENDAR_ID,
        eventId: row.target_event_id!,
      });
    }

    return await updateProposedChange(row.id, {
      status: 'applied',
      decided_by: decidedBy,
      decided_at: now,
      applied_at: now,
      error_message: null,
      target_event_id: resultingEventId ?? undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return await updateProposedChange(row.id, {
      status: 'failed',
      decided_by: decidedBy,
      decided_at: now,
      error_message: message,
    });
  }
}

export async function createProposedChange(input: ProposedChangeInput): Promise<ProposedChangeRow> {
  validateProposalInput(input);

  const { data, error } = await supabase
    .from('proposed_changes')
    .insert({ ...input, status: 'pending' })
    .select('*')
    .single();
  if (error) throw new Error(`proposed_changes insert failed: ${error.message}`);

  const row = data as ProposedChangeRow;
  const autoApplyCategories = getAutoApplyCategories();
  if (autoApplyCategories.has(row.category)) {
    return applyProposedChange(row, 'auto-apply-policy');
  }
  return row;
}

export async function approveProposedChange(id: string): Promise<ProposedChangeRow> {
  const row = await getProposedChange(id);
  if (row.status !== 'pending' && row.status !== 'failed') {
    throw new ConflictError(`Cannot approve a proposed change with status "${row.status}"`);
  }
  return applyProposedChange(row, 'user');
}

export async function rejectProposedChange(id: string): Promise<ProposedChangeRow> {
  const row = await getProposedChange(id);
  if (row.status !== 'pending' && row.status !== 'failed') {
    throw new ConflictError(`Cannot reject a proposed change with status "${row.status}"`);
  }
  return updateProposedChange(id, {
    status: 'rejected',
    decided_by: 'user',
    decided_at: new Date().toISOString(),
  });
}

export async function listProposedChanges(status?: ProposalStatus): Promise<ProposedChangeRow[]> {
  let query = supabase.from('proposed_changes').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new Error(`proposed_changes read failed: ${error.message}`);
  return data as ProposedChangeRow[];
}
