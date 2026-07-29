import { describe, expect, it } from 'vitest';
import { sortTasks } from './sort';
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

describe('sortTasks — status', () => {
  it('orders exactly unscheduled < scheduled < completed < discarded', () => {
    const tasks = [
      task({ id: 'd', status: 'discarded' }),
      task({ id: 'c', status: 'completed' }),
      task({ id: 'u', status: 'unscheduled' }),
      task({ id: 's', status: 'scheduled' }),
    ];
    expect(sortTasks(tasks, 'status').map((t) => t.id)).toEqual(['u', 's', 'c', 'd']);
  });
});

describe('sortTasks — dueDate', () => {
  it('sorts ascending by deadline', () => {
    const tasks = [
      task({ id: 'late', deadline: '2026-08-01T00:00:00Z' }),
      task({ id: 'early', deadline: '2026-07-28T00:00:00Z' }),
    ];
    expect(sortTasks(tasks, 'dueDate').map((t) => t.id)).toEqual(['early', 'late']);
  });

  it('sorts a task with no deadline last, regardless of the other tasks present', () => {
    const tasks = [
      task({ id: 'none', deadline: null }),
      task({ id: 'has', deadline: '2026-07-28T00:00:00Z' }),
    ];
    expect(sortTasks(tasks, 'dueDate').map((t) => t.id)).toEqual(['has', 'none']);
  });

  it('two tasks with no deadline stay in a stable relative order, both last', () => {
    const tasks = [
      task({ id: 'none-a', deadline: null }),
      task({ id: 'has', deadline: '2026-07-28T00:00:00Z' }),
      task({ id: 'none-b', deadline: null }),
    ];
    const result = sortTasks(tasks, 'dueDate').map((t) => t.id);
    expect(result[0]).toBe('has');
    expect(result.slice(1).sort()).toEqual(['none-a', 'none-b']);
  });
});

describe('sortTasks — priority', () => {
  it('orders exactly critical < high < medium < low', () => {
    const tasks = [
      task({ id: 'l', priority: 'low' }),
      task({ id: 'c', priority: 'critical' }),
      task({ id: 'm', priority: 'medium' }),
      task({ id: 'h', priority: 'high' }),
    ];
    expect(sortTasks(tasks, 'priority').map((t) => t.id)).toEqual(['c', 'h', 'm', 'l']);
  });

  it('sorts a task with no priority last', () => {
    const tasks = [task({ id: 'none', priority: null }), task({ id: 'has', priority: 'low' })];
    expect(sortTasks(tasks, 'priority').map((t) => t.id)).toEqual(['has', 'none']);
  });
});

describe('sortTasks — tag', () => {
  it('sorts by each task\'s LOWEST tag, not its first/insertion-order tag', () => {
    // 'b-tag' has tags in insertion order ['b','a'] — must sort under 'a', not 'b'.
    const tasks = [
      task({ id: 'b-tag', tags: ['b', 'a'] }),
      task({ id: 'c-tag', tags: ['c'] }),
    ];
    expect(sortTasks(tasks, 'tag').map((t) => t.id)).toEqual(['b-tag', 'c-tag']);
  });

  it('sorts an untagged task last', () => {
    const tasks = [task({ id: 'none', tags: [] }), task({ id: 'has', tags: ['work'] })];
    expect(sortTasks(tasks, 'tag').map((t) => t.id)).toEqual(['has', 'none']);
  });
});

describe('sortTasks — general', () => {
  it('does not mutate the input array', () => {
    const tasks = [task({ id: 'b', priority: 'low' }), task({ id: 'a', priority: 'critical' })];
    const original = [...tasks];
    sortTasks(tasks, 'priority');
    expect(tasks).toEqual(original);
  });
});
