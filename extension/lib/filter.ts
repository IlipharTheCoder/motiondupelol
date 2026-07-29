// Mirrors app/motiondupelol/Shared/TaskListView.swift's `TaskFilterState`
// exactly — three independent multi-select categories, OR-within/AND-across.
import type { Task, TaskStatus, Priority } from './types';

export interface TaskFilterState {
  statuses: Set<TaskStatus>;
  priorities: Set<Priority>;
  tags: Set<string>;
}

export function emptyFilterState(): TaskFilterState {
  return { statuses: new Set(), priorities: new Set(), tags: new Set() };
}

export function isFilterActive(state: TaskFilterState): boolean {
  return state.statuses.size > 0 || state.priorities.size > 0 || state.tags.size > 0;
}

// An empty set for a category imposes no constraint for that category (not
// "show nothing") — a task passes iff, for every NON-empty category, it
// matches at least one selected value in that category. Categories
// themselves are AND-composed.
export function applyTaskFilter(tasks: Task[], state: TaskFilterState): Task[] {
  return tasks.filter((task) => {
    if (state.statuses.size > 0 && !state.statuses.has(task.status)) return false;
    if (state.priorities.size > 0 && (!task.priority || !state.priorities.has(task.priority))) return false;
    if (state.tags.size > 0 && !task.tags.some((tag) => state.tags.has(tag))) return false;
    return true;
  });
}

export function deriveTagOptions(tasks: Task[]): string[] {
  const all = new Set<string>();
  for (const task of tasks) {
    for (const tag of task.tags) all.add(tag);
  }
  return [...all].sort();
}
