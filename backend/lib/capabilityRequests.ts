export type CapabilityRequestStatus = 'open' | 'planned' | 'built' | 'wontfix';
export const CAPABILITY_REQUEST_STATUSES: CapabilityRequestStatus[] = ['open', 'planned', 'built', 'wontfix'];

export interface CapabilityRequestRow {
  id: string;
  requested_capability: string;
  example_phrase: string | null;
  context: string | null;
  status: CapabilityRequestStatus;
  created_at: string;
  updated_at: string;
}
