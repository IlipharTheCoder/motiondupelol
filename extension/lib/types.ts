// Domain models — camelCase, field lists matching the Swift app's own models
// (app/motiondupelol/CoreLogic/ProposedChange.swift, TaskItem.swift) so both
// clients stay conceptually aligned against the same backend contract
// (../backend/backend-api-reference.md). The wire format is snake_case;
// caseConvert.ts is what bridges the two.

export type TaskStatus = 'unscheduled' | 'scheduled' | 'completed' | 'discarded';
export type Priority = 'critical' | 'high' | 'medium' | 'low';
export type ChangeType = 'create' | 'move' | 'update' | 'delete';
export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'failed';

export interface Task {
  id: string;
  title: string;
  description: string | null;
  deadline: string | null; // ISO datetime
  priority: Priority | null;
  tags: string[];
  sourceSystem: string | null;
  status: TaskStatus;
  scheduledEventId: string | null;
  durationMinutes: number | null;
  createdAt: string | null;
}

export interface ProposedChange {
  id: string;
  status: ProposalStatus;
  changeType: ChangeType | null;
  proposedSummary: string | null;
  proposedStart: string | null; // ISO datetime
  proposedEnd: string | null; // ISO datetime
  category: string | null;
  priority: Priority | null;
  reason: string | null;
  errorMessage: string | null;
  message: string | null;
  proposalGroupId: string | null;
  createdAt: string | null;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
}

export interface ChatResponse {
  conversationId: string;
  reply: string;
  proposals: ProposedChange[];
  usage: ChatUsage;
  tasksChanged: boolean;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  deadline?: string;
  priority?: Priority | null;
  durationMinutes?: number;
  tags?: string[];
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  deadline?: string | null;
  priority?: Priority | null;
  durationMinutes?: number;
  tags?: string[];
}

export interface PatchProposedChangeInput {
  priority?: Priority;
  tags?: string[];
  durationMinutes?: number;
}

// POST /api/calendar/resync's response shape — mirrors SyncRunResult in
// backend/lib/calendarSync.ts. Only the fields the panel actually displays
// (a per-calendar summary count, and whether a follow-up call is needed)
// are modeled precisely; the rest pass through camelizeKeys untyped.
export interface CalendarResyncResult {
  truncatedByTimeBudget: boolean;
  calendars: {
    calendarSummary: string;
    status: 'complete' | 'in_progress' | 'error';
    created: number;
    updated: number;
    deleted: number;
    errorMessage: string | null;
  }[];
}
