import { supabase } from './supabase';
import { getSchedulingConfig } from './schedulingConfig';
import { mergeIntervals, subtractIntervals, filterByMinDuration, type Interval } from './intervals';
import { findFreeSlots } from './freeSlots';
import { sortTasksByPriorityScore, resolveTaskDurationMinutes, scheduleTaskToNewEvent, type TaskRow } from './aiTasks';
import { ValidationError, type ProposedChangeRow } from './proposedChanges';

interface PendingTaskProposal {
  sourceId: string | null;
  interval: Interval;
}

// Existing pending/failed task-create proposals — used two ways: skip a
// task that already has one awaiting approval, and treat their (not yet
// real) time as claimed so a different task in this same run doesn't get
// placed on top of them.
async function fetchPendingTaskProposals(): Promise<PendingTaskProposal[]> {
  const { data, error } = await supabase
    .from('proposed_changes')
    .select('source_id, proposed_start, proposed_end')
    .eq('change_type', 'create')
    .eq('category', 'task')
    .eq('source_system', 'ai-engine')
    .in('status', ['pending', 'failed']);
  if (error) throw new Error(`proposed_changes read failed: ${error.message}`);

  return ((data ?? []) as { source_id: string | null; proposed_start: string | null; proposed_end: string | null }[])
    .filter((row) => row.proposed_start && row.proposed_end)
    .map((row) => ({
      sourceId: row.source_id,
      interval: { start: Date.parse(row.proposed_start!), end: Date.parse(row.proposed_end!) },
    }));
}

export type TaskPlacementOutcome = 'proposed' | 'skipped-already-pending' | 'skipped-no-slot' | 'skipped-error';

export interface TaskPlacementResult {
  taskId: string;
  title: string;
  outcome: TaskPlacementOutcome;
  proposal?: ProposedChangeRow;
  reason?: string;
}

export interface TaskPlacementSummary {
  rangeStart: string;
  rangeEnd: string;
  tasksScanned: number;
  proposalsCreated: number;
  skippedAlreadyPending: number;
  skippedNoSlot: number;
  results: TaskPlacementResult[];
}

// Auto-placement + deadline-aware backward planning (architecture-plan.md
// section 4e). Processes unscheduled tasks in priority-score order
// (lib/aiTasks.ts's sortTasksByPriorityScore) so if the range's free time
// runs out mid-run, higher-ranked tasks claimed it first. Every call to
// lib/aiTasks.ts's scheduleTaskToNewEvent still goes through the normal
// proposed_changes review queue — this only decides *where*, never writes
// to the calendar itself.
export async function planTaskPlacement(
  rangeStart: Date,
  rangeEnd: Date,
  now: Date = new Date()
): Promise<TaskPlacementSummary> {
  if (rangeEnd.getTime() <= rangeStart.getTime()) {
    throw new ValidationError('rangeEnd must be later than rangeStart');
  }

  const config = getSchedulingConfig();

  const { data: taskRows, error: tasksError } = await supabase
    .from('tasks')
    .select('*')
    .eq('status', 'unscheduled');
  if (tasksError) throw new Error(`tasks read failed: ${tasksError.message}`);

  const tasks = sortTasksByPriorityScore((taskRows ?? []) as TaskRow[], now);
  const pendingProposals = await fetchPendingTaskProposals();
  const pendingTaskIds = new Set(pendingProposals.map((p) => p.sourceId).filter((id): id is string => !!id));

  const result: TaskPlacementSummary = {
    rangeStart: rangeStart.toISOString(),
    rangeEnd: rangeEnd.toISOString(),
    tasksScanned: tasks.length,
    proposalsCreated: 0,
    skippedAlreadyPending: 0,
    skippedNoSlot: 0,
    results: [],
  };

  const searchStart = new Date(Math.max(rangeStart.getTime(), now.getTime()));
  if (searchStart.getTime() >= rangeEnd.getTime()) {
    for (const task of tasks) {
      result.skippedNoSlot++;
      result.results.push({
        taskId: task.id,
        title: task.title,
        outcome: 'skipped-no-slot',
        reason: 'Range has already elapsed',
      });
    }
    return result;
  }

  let claimedIntervals: Interval[] = mergeIntervals(pendingProposals.map((p) => p.interval));

  for (const task of tasks) {
    if (pendingTaskIds.has(task.id)) {
      result.skippedAlreadyPending++;
      result.results.push({
        taskId: task.id,
        title: task.title,
        outcome: 'skipped-already-pending',
        reason: 'Already has a pending or failed proposal awaiting approval',
      });
      continue;
    }

    try {
      const durationMinutes = resolveTaskDurationMinutes(task);
      const durationMs = durationMinutes * 60_000;

      const deadlineMs = task.deadline ? Date.parse(task.deadline) : NaN;
      const useBackwardPlanning =
        !Number.isNaN(deadlineMs) && deadlineMs > searchStart.getTime() && deadlineMs <= rangeEnd.getTime();

      let chosen: Interval | undefined;
      let noSlotReason: string;

      const windowLabel = useBackwardPlanning ? 'before deadline' : 'in range';
      const windowEnd = useBackwardPlanning ? new Date(deadlineMs) : rangeEnd;

      // minDurationMinutes here means `slots` already only contains openings
      // at least this big on the *live* calendar — if that comes back
      // empty, no single opening exists anywhere regardless of this run's
      // own claims (the genuine "task too big" / future-session-splitting
      // case). Only after that do we subtract this run's already-claimed
      // picks, which can shrink or remove otherwise-fitting slots — that's
      // a different situation (a higher-priority task in this same run
      // already took the room), not "too big."
      const { slots } = await findFreeSlots(searchStart, windowEnd, {
        minDurationMinutes: durationMinutes,
        config,
        category: 'task',
        tags: task.tags ?? [],
      });

      if (slots.length === 0) {
        noSlotReason = `No single opening of ${durationMinutes}m found ${windowLabel} — session-splitting not yet supported`;
      } else {
        const openSlots = subtractIntervals(slots, claimedIntervals);
        const fitting = filterByMinDuration(openSlots, durationMinutes);
        if (fitting.length > 0) {
          const target = useBackwardPlanning ? fitting[fitting.length - 1] : fitting[0];
          chosen = useBackwardPlanning
            ? { start: target.end - durationMs, end: target.end }
            : { start: target.start, end: target.start + durationMs };
        } else {
          noSlotReason = `No room left ${windowLabel} — already claimed by a higher-priority task this run`;
        }
      }

      if (!chosen) {
        result.skippedNoSlot++;
        result.results.push({
          taskId: task.id,
          title: task.title,
          outcome: 'skipped-no-slot',
          reason: noSlotReason!,
        });
        continue;
      }

      const { proposal } = await scheduleTaskToNewEvent(
        task.id,
        new Date(chosen.start).toISOString(),
        new Date(chosen.end).toISOString()
      );

      result.proposalsCreated++;
      result.results.push({ taskId: task.id, title: task.title, outcome: 'proposed', proposal });
      claimedIntervals = mergeIntervals([...claimedIntervals, chosen]);
    } catch (err) {
      // One bad task shouldn't abort the whole batch.
      result.results.push({
        taskId: task.id,
        title: task.title,
        outcome: 'skipped-error',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
