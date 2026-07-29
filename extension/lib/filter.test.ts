import { describe, expect, it } from 'vitest';
import { applyTaskFilter, deriveTagOptions, emptyFilterState, isFilterActive } from './filter';
import type { Task } from './types';

function task(overrides: Partial<Task>): Task {
  return {
    id: 'x',
    title: 'x',
    description: null,
    deadline: null,
    priority: null,
    tags: [],
    sourceSystem: null,
    status: 'unscheduled',
    scheduledEventId: null,
    durationMinutes: null,
    createdAt: null,
    ...overrides,
  };
}

const tasks: Task[] = [
  task({ id: 'a', status: 'unscheduled', priority: 'critical', tags: ['work'] }),
  task({ id: 'b', status: 'scheduled', priority: 'high', tags: ['personal'] }),
  task({ id: 'c', status: 'completed', priority: 'low', tags: ['work', 'urgent'] }),
];

describe('applyTaskFilter', () => {
  it('passes everything when the filter is empty', () => {
    expect(applyTaskFilter(tasks, emptyFilterState())).toHaveLength(3);
  });

  it('applies OR semantics within one category', () => {
    const state = emptyFilterState();
    state.priorities.add('critical');
    state.priorities.add('high');
    expect(applyTaskFilter(tasks, state).map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('applies AND semantics across categories — a task matching status but not priority is excluded', () => {
    const state = emptyFilterState();
    state.statuses.add('unscheduled');
    state.priorities.add('low'); // task 'a' is unscheduled but not low priority
    expect(applyTaskFilter(tasks, state)).toEqual([]);
  });

  it('filters by tag using OR-within-tags semantics too', () => {
    const state = emptyFilterState();
    state.tags.add('urgent');
    expect(applyTaskFilter(tasks, state).map((t) => t.id)).toEqual(['c']);
  });

  it('a task with no priority never matches a non-empty priority filter', () => {
    const untagged = [task({ id: 'none', priority: null })];
    const state = emptyFilterState();
    state.priorities.add('critical');
    expect(applyTaskFilter(untagged, state)).toEqual([]);
  });
});

describe('deriveTagOptions', () => {
  it('dedupes and sorts tags across the full task list', () => {
    expect(deriveTagOptions(tasks)).toEqual(['personal', 'urgent', 'work']);
  });
});

describe('isFilterActive', () => {
  it('is false only when all three categories are empty', () => {
    expect(isFilterActive(emptyFilterState())).toBe(false);
    const state = emptyFilterState();
    state.tags.add('work');
    expect(isFilterActive(state)).toBe(true);
  });
});
