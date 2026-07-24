import { supabase } from './supabase';
import { createProposedChange } from './proposedChanges';

interface CanvasSubmission {
  workflow_state: string;
}

interface CanvasAssignment {
  id: number;
  course_id: number;
  name: string;
  description: string | null;
  due_at: string | null;
  submission_types: string[];
  submission?: CanvasSubmission | null;
}

interface CanvasCourse {
  id: number;
  name: string;
}

interface SyncedTaskRow {
  source_system: string;
  source_id: string;
  proposed_change_id: string | null;
  task_id: string | null;
  source_updated_at: string | null;
}

export interface CanvasSyncResult {
  proposed: number;
  skippedExisting: number;
  withdrawnUnscheduled: number;
  proposedDeletes: number;
  errors: string[];
}

// Graded discussions surface as assignments with this submission type — per
// the user's choice, only real assignments/quizzes are synced, not discussions.
const DISCUSSION_SUBMISSION_TYPE = 'discussion_topic';

function isSyncableAssignment(assignment: CanvasAssignment): boolean {
  return !assignment.submission_types?.includes(DISCUSSION_SUBMISSION_TYPE);
}

// Canvas has no Todoist-style "marked complete" flag on the assignment
// itself — the closest equivalent is the current user's own submission
// state, requested via `include[]=submission`. No submission record at all
// (the field is absent) counts the same as `'unsubmitted'`.
function isResolved(assignment: CanvasAssignment | undefined): boolean {
  if (!assignment) return true;
  const state = assignment.submission?.workflow_state;
  return !!state && state !== 'unsubmitted';
}

function canvasDeadline(dueAt: string | null): string | undefined {
  return dueAt ?? undefined;
}

function stripHtml(html: string | null): string | undefined {
  if (!html) return undefined;
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || undefined;
}

function requireCanvasConfig(): { baseUrl: string; token: string } {
  const baseUrl = process.env.CANVAS_BASE_URL;
  if (!baseUrl) throw new Error('CANVAS_BASE_URL is not set');
  const token = process.env.CANVAS_API_TOKEN;
  if (!token) throw new Error('CANVAS_API_TOKEN is not set');
  return { baseUrl: baseUrl.replace(/\/$/, ''), token };
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function fetchAllPages<T>(url: string, token: string): Promise<T[]> {
  const results: T[] = [];
  let next: string | null = url;
  while (next) {
    const res: Response = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Canvas API error ${res.status}: ${await res.text()}`);
    }
    results.push(...((await res.json()) as T[]));
    next = parseNextLink(res.headers.get('Link'));
  }
  return results;
}

async function fetchActiveCourses(baseUrl: string, token: string): Promise<CanvasCourse[]> {
  return fetchAllPages<CanvasCourse>(`${baseUrl}/api/v1/courses?enrollment_state=active&per_page=100`, token);
}

async function fetchCourseAssignments(baseUrl: string, token: string, courseId: number): Promise<CanvasAssignment[]> {
  return fetchAllPages<CanvasAssignment>(
    `${baseUrl}/api/v1/courses/${courseId}/assignments?per_page=100&include[]=submission`,
    token
  );
}

// Full-list diff against `synced_tasks`, same as Todoist sync (`lib/todoistSync.ts`)
// — a personal course/assignment list is small enough not to need an
// incremental sync token. Per-course assignments endpoint chosen over
// `planner/items` for completeness (catches assignments with no due date
// too); resolution is detected via the current user's own submission state,
// not list-membership, since Canvas never drops an assignment from this
// endpoint the way Todoist drops a completed task from its active list.
export async function runCanvasSync(): Promise<CanvasSyncResult> {
  const result: CanvasSyncResult = {
    proposed: 0,
    skippedExisting: 0,
    withdrawnUnscheduled: 0,
    proposedDeletes: 0,
    errors: [],
  };

  const { baseUrl, token } = requireCanvasConfig();

  const courses = await fetchActiveCourses(baseUrl, token);
  const courseNameById = new Map(courses.map((c) => [c.id, c.name]));

  const assignments: CanvasAssignment[] = [];
  for (const course of courses) {
    const courseAssignments = await fetchCourseAssignments(baseUrl, token, course.id);
    assignments.push(...courseAssignments);
  }
  const assignmentById = new Map(assignments.map((a) => [String(a.id), a]));

  const { data: existingRows, error: existingError } = await supabase
    .from('synced_tasks')
    .select('*')
    .eq('source_system', 'canvas');
  if (existingError) throw new Error(`synced_tasks read failed: ${existingError.message}`);

  const existingBySourceId = new Map<string, SyncedTaskRow>();
  for (const row of (existingRows ?? []) as SyncedTaskRow[]) {
    existingBySourceId.set(row.source_id, row);
  }

  // New assignments — propose a task-list intake, same review-queue
  // principle as everywhere else. Priority/tags deliberately left unset,
  // same as Todoist sync — set at review time.
  for (const assignment of assignments) {
    const sourceId = String(assignment.id);
    if (existingBySourceId.has(sourceId)) {
      result.skippedExisting++;
      continue;
    }
    if (!isSyncableAssignment(assignment) || isResolved(assignment)) continue;

    try {
      const courseName = courseNameById.get(assignment.course_id);
      const title = courseName ? `${courseName}: ${assignment.name}` : assignment.name;

      const proposal = await createProposedChange({
        change_type: 'create',
        category: 'task',
        source_system: 'canvas',
        source_id: sourceId,
        proposed_summary: title,
        proposed_description: stripHtml(assignment.description),
        deadline: canvasDeadline(assignment.due_at),
      });

      const { error: upsertError } = await supabase.from('synced_tasks').upsert(
        {
          source_system: 'canvas',
          source_id: sourceId,
          proposed_change_id: proposal.id,
          task_id: null,
          source_updated_at: null,
        },
        { onConflict: 'source_system,source_id' }
      );
      if (upsertError) throw new Error(`synced_tasks upsert failed: ${upsertError.message}`);

      result.proposed++;
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // Assignments that resolved (submitted/graded) or disappeared entirely
  // (unenrolled/deleted) since last sync — same withdrawal branches as
  // Todoist sync: never-reviewed proposals are silently withdrawn,
  // already-scheduled tasks get a delete proposal, everything else is
  // marked discarded directly.
  for (const row of existingBySourceId.values()) {
    if (!isResolved(assignmentById.get(row.source_id))) continue;

    try {
      if (!row.task_id) {
        if (row.proposed_change_id) {
          await supabase
            .from('proposed_changes')
            .update({
              status: 'rejected',
              decided_by: 'auto-apply-policy',
              decided_at: new Date().toISOString(),
            })
            .eq('id', row.proposed_change_id)
            .in('status', ['pending', 'failed']);
        }
        await supabase.from('synced_tasks').delete().eq('source_system', 'canvas').eq('source_id', row.source_id);
        result.withdrawnUnscheduled++;
        continue;
      }

      const { data: taskRow, error: taskError } = await supabase
        .from('tasks')
        .select('*')
        .eq('id', row.task_id)
        .maybeSingle();
      if (taskError) throw new Error(`tasks read failed: ${taskError.message}`);

      if (taskRow?.scheduled_event_id) {
        await createProposedChange({
          change_type: 'delete',
          category: 'task',
          source_system: 'canvas',
          source_id: row.source_id,
          target_event_id: taskRow.scheduled_event_id,
        });
        result.proposedDeletes++;
      } else if (taskRow) {
        await supabase.from('tasks').update({ status: 'discarded' }).eq('id', row.task_id);
      }

      await supabase.from('synced_tasks').delete().eq('source_system', 'canvas').eq('source_id', row.source_id);
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return result;
}
