import { supabase } from './supabase';
import { ValidationError } from './proposedChanges';
import { CAPABILITY_REQUEST_STATUSES, type CapabilityRequestStatus, type CapabilityRequestRow } from './capabilityRequests';

export interface CreateCapabilityRequestInput {
  requested_capability: string;
  example_phrase?: string | null;
  context?: string | null;
}

// Lifted verbatim from app/api/capability-requests/route.ts's POST handler.
// This is the NL chat layer's log_capability_gap tool — the deliberate
// fallback for any request that maps to nothing else in the tool surface
// (see backend-build-order.md's framing of this route as "the correct v1
// fallback for the NL layer").
export async function createCapabilityRequest(input: CreateCapabilityRequestInput): Promise<CapabilityRequestRow> {
  const requestedCapability =
    typeof input.requested_capability === 'string' ? input.requested_capability.trim() : '';
  if (!requestedCapability) {
    throw new ValidationError('requested_capability is required');
  }

  const examplePhrase = typeof input.example_phrase === 'string' ? input.example_phrase : null;
  const context = typeof input.context === 'string' ? input.context : null;

  const { data, error } = await supabase
    .from('capability_requests')
    .insert({
      requested_capability: requestedCapability,
      example_phrase: examplePhrase,
      context,
      status: 'open',
    })
    .select('*')
    .single();

  if (error) throw new Error(`capability_requests insert failed: ${error.message}`);
  return data as CapabilityRequestRow;
}

// Lifted verbatim from app/api/capability-requests/route.ts's GET handler.
export async function listCapabilityRequests(status?: CapabilityRequestStatus): Promise<CapabilityRequestRow[]> {
  if (status && !CAPABILITY_REQUEST_STATUSES.includes(status)) {
    throw new ValidationError(`"status" must be one of ${CAPABILITY_REQUEST_STATUSES.join(', ')}`);
  }

  let query = supabase.from('capability_requests').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new Error(`capability_requests read failed: ${error.message}`);
  return data as CapabilityRequestRow[];
}
