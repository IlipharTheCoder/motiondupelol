import { supabase } from './supabase';
import { ValidationError } from './proposedChanges';
import { HABIT_STATUSES, type HabitStatus, type HabitRow } from './habits';

// Lifted verbatim from app/api/habits/route.ts's GET handler.
export async function listHabits(status?: HabitStatus): Promise<HabitRow[]> {
  if (status && !HABIT_STATUSES.includes(status)) {
    throw new ValidationError(`"status" must be one of ${HABIT_STATUSES.join(', ')}`);
  }

  let query = supabase.from('habits').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new Error(`habits read failed: ${error.message}`);
  return data as HabitRow[];
}
