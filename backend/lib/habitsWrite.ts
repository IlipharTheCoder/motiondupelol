import { supabase } from './supabase';
import { normalizeTags } from './normalizeTags';
import { EVENT_PRIORITIES, type EventPriority } from './eventMetadata';
import { HABIT_CADENCES, HABIT_STATUSES, type HabitCadence, type HabitStatus, type HabitRow } from './habits';
import { ValidationError, NotFoundError } from './proposedChanges';

export interface CreateHabitInput {
  title: string;
  description?: string | null;
  cadence: HabitCadence;
  interval_days?: number | null;
  target_count: number;
  occurrence_duration_minutes?: number | null;
  priority?: EventPriority | null;
  tags?: string[];
}

// Lifted verbatim from app/api/habits/route.ts's POST handler — prerequisite
// refactor for the NL chat layer's create_habit tool (see lib/tasksWrite.ts's
// comment for the shared rationale across all four "declaration" tables).
export async function createHabit(input: CreateHabitInput): Promise<HabitRow> {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) {
    throw new ValidationError('title is required');
  }

  if (!HABIT_CADENCES.includes(input.cadence)) {
    throw new ValidationError(`"cadence" must be one of ${HABIT_CADENCES.join(', ')}`);
  }

  if (!Number.isInteger(input.target_count) || input.target_count <= 0) {
    throw new ValidationError('"target_count" must be a positive integer');
  }

  if (
    input.occurrence_duration_minutes !== undefined &&
    input.occurrence_duration_minutes !== null &&
    (!Number.isInteger(input.occurrence_duration_minutes) || input.occurrence_duration_minutes <= 0)
  ) {
    throw new ValidationError('"occurrence_duration_minutes" must be a positive integer');
  }

  if (
    input.interval_days !== undefined &&
    input.interval_days !== null &&
    (!Number.isInteger(input.interval_days) || input.interval_days <= 0)
  ) {
    throw new ValidationError('"interval_days" must be a positive integer');
  }
  if (input.cadence === 'interval' && (input.interval_days === undefined || input.interval_days === null)) {
    throw new ValidationError(
      '"interval_days" is required and must be a positive integer when cadence is "interval"'
    );
  }

  if (input.priority !== undefined && input.priority !== null && !EVENT_PRIORITIES.includes(input.priority)) {
    throw new ValidationError(`"priority" must be one of ${EVENT_PRIORITIES.join(', ')}, or null`);
  }

  const description = typeof input.description === 'string' ? input.description : null;
  const tags = normalizeTags(input.tags);

  const { data, error } = await supabase
    .from('habits')
    .insert({
      title,
      description,
      cadence: input.cadence,
      interval_days: input.interval_days ?? null,
      target_count: input.target_count,
      occurrence_duration_minutes: input.occurrence_duration_minutes ?? null,
      priority: input.priority ?? null,
      tags,
      status: 'active',
    })
    .select('*')
    .single();

  if (error) throw new Error(`habits insert failed: ${error.message}`);
  return data as HabitRow;
}

export interface UpdateHabitInput {
  title?: string;
  description?: string | null;
  cadence?: HabitCadence;
  target_count?: number;
  occurrence_duration_minutes?: number | null;
  interval_days?: number | null;
  priority?: EventPriority | null;
  tags?: string[];
  status?: HabitStatus;
}

// Lifted verbatim from app/api/habits/[id]/route.ts's PATCH handler.
export async function updateHabit(id: string, input: UpdateHabitInput): Promise<HabitRow> {
  const patch: Record<string, unknown> = {};

  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) {
      throw new ValidationError('title cannot be empty');
    }
    patch.title = title;
  }

  if (input.description !== undefined) {
    patch.description = typeof input.description === 'string' ? input.description : null;
  }

  if (input.cadence !== undefined) {
    if (!HABIT_CADENCES.includes(input.cadence)) {
      throw new ValidationError(`"cadence" must be one of ${HABIT_CADENCES.join(', ')}`);
    }
    patch.cadence = input.cadence;
  }

  if (input.target_count !== undefined) {
    if (!Number.isInteger(input.target_count) || input.target_count <= 0) {
      throw new ValidationError('"target_count" must be a positive integer');
    }
    patch.target_count = input.target_count;
  }

  if (input.occurrence_duration_minutes !== undefined) {
    if (
      input.occurrence_duration_minutes !== null &&
      (!Number.isInteger(input.occurrence_duration_minutes) || input.occurrence_duration_minutes <= 0)
    ) {
      throw new ValidationError('"occurrence_duration_minutes" must be a positive integer or null');
    }
    patch.occurrence_duration_minutes = input.occurrence_duration_minutes;
  }

  if (input.interval_days !== undefined) {
    if (input.interval_days !== null && (!Number.isInteger(input.interval_days) || input.interval_days <= 0)) {
      throw new ValidationError('"interval_days" must be a positive integer or null');
    }
    patch.interval_days = input.interval_days;
  }

  if (patch.cadence === 'interval' && patch.interval_days === undefined) {
    throw new ValidationError(
      '"interval_days" is required in the same request when setting cadence to "interval"'
    );
  }

  if (input.priority !== undefined) {
    if (input.priority !== null && !EVENT_PRIORITIES.includes(input.priority)) {
      throw new ValidationError(`"priority" must be one of ${EVENT_PRIORITIES.join(', ')}, or null`);
    }
    patch.priority = input.priority;
  }

  if (input.tags !== undefined) {
    patch.tags = normalizeTags(input.tags);
  }

  if (input.status !== undefined) {
    if (!HABIT_STATUSES.includes(input.status)) {
      throw new ValidationError(`"status" must be one of ${HABIT_STATUSES.join(', ')}`);
    }
    patch.status = input.status;
  }

  if (Object.keys(patch).length === 0) {
    throw new ValidationError(
      'At least one of title, description, cadence, interval_days, target_count, occurrence_duration_minutes, priority, tags, status is required'
    );
  }

  const { data, error } = await supabase.from('habits').update(patch).eq('id', id).select('*');
  if (error) throw new Error(`habits update failed: ${error.message}`);
  if (!data || data.length === 0) throw new NotFoundError(`No habit with id "${id}"`);
  return data[0] as HabitRow;
}
