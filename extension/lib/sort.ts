// Mirrors app/motiondupelol/Shared/TaskListView.swift's `TaskSortOption`
// exactly — same four options, same nil-last semantics, same tag-min (not
// tag-first) rule. See lib/sort.test.ts for the specific edge cases this
// must preserve.
import type { Task } from './types';

export type TaskSortOption = 'status' | 'dueDate' | 'priority' | 'tag';

const STATUS_RANK: Record<string, number> = {
  unscheduled: 0,
  scheduled: 1,
  completed: 2,
  discarded: 3,
};

const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function lowestTag(tags: string[]): string | null {
  if (tags.length === 0) return null;
  return tags.reduce((min, t) => (t < min ? t : min), tags[0]);
}

// Shared nil-last comparator shape: a null/undefined key never sorts before
// a present one, regardless of comparison direction — matches Swift's
// explicit (nil, nil) -> false / (nil, _) -> false / (_, nil) -> true
// pattern in TaskSortOption.sorted, rather than the more common "nil sorts
// as smallest" default.
function compareNilLast<K>(a: K | null, b: K | null, compare: (a: K, b: K) => number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compare(a, b);
}

export function sortTasks(tasks: Task[], option: TaskSortOption): Task[] {
  const copy = [...tasks];
  switch (option) {
    case 'status':
      return copy.sort((a, b) => (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99));
    case 'dueDate':
      return copy.sort((a, b) => compareNilLast(a.deadline, b.deadline, (x, y) => x.localeCompare(y)));
    case 'priority':
      return copy.sort((a, b) =>
        compareNilLast(a.priority, b.priority, (x, y) => (PRIORITY_RANK[x] ?? 99) - (PRIORITY_RANK[y] ?? 99))
      );
    case 'tag':
      return copy.sort((a, b) =>
        compareNilLast(lowestTag(a.tags), lowestTag(b.tags), (x, y) => x.localeCompare(y))
      );
  }
}
