import { describe, expect, it } from 'vitest';
import { buildTasksSection, withTasksSection } from './eventTaskDescriptionFormat';

const TZ = 'America/New_York';

describe('buildTasksSection', () => {
  it('lists each task title on its own line', () => {
    const section = buildTasksSection(
      [{ title: 'Buy groceries', deadline: null }, { title: 'Call dentist', deadline: null }],
      TZ
    );
    expect(section).toContain('- Buy groceries');
    expect(section).toContain('- Call dentist');
  });

  it('appends a formatted deadline when present', () => {
    const section = buildTasksSection([{ title: 'File taxes', deadline: '2026-07-28T12:00:00Z' }], TZ);
    expect(section).toContain('- File taxes (due 2026-07-28)');
  });

  it('omits the deadline suffix when there is none', () => {
    const section = buildTasksSection([{ title: 'No deadline task', deadline: null }], TZ);
    expect(section).toContain('- No deadline task');
    expect(section).not.toContain('(due');
  });
});

describe('withTasksSection', () => {
  it('adds the section to an empty description', () => {
    const section = buildTasksSection([{ title: 'A task', deadline: null }], TZ);
    expect(withTasksSection('', section)).toBe(section);
  });

  it('preserves existing description content, appended after', () => {
    const section = buildTasksSection([{ title: 'A task', deadline: null }], TZ);
    const result = withTasksSection('Team sync notes', section);
    expect(result).toBe(`Team sync notes\n\n${section}`);
  });

  it('is idempotent — syncing twice with the same tasks does not accumulate content', () => {
    const section = buildTasksSection([{ title: 'A task', deadline: null }], TZ);
    const once = withTasksSection('Team sync notes', section);
    const twice = withTasksSection(once, section);
    expect(twice).toBe(once);
  });

  it('removes the section entirely once there are no tasks left, preserving other content', () => {
    const section = buildTasksSection([{ title: 'A task', deadline: null }], TZ);
    const withSection = withTasksSection('Team sync notes', section);
    const afterUnassign = withTasksSection(withSection, null);
    expect(afterUnassign).toBe('Team sync notes');
  });

  it('removes the section entirely when there was no other content either', () => {
    const section = buildTasksSection([{ title: 'A task', deadline: null }], TZ);
    const withSection = withTasksSection('', section);
    const afterUnassign = withTasksSection(withSection, null);
    expect(afterUnassign).toBe('');
  });

  it('regenerates the section in place when the task list changes', () => {
    const oneTask = buildTasksSection([{ title: 'First task', deadline: null }], TZ);
    const twoTasks = buildTasksSection(
      [{ title: 'First task', deadline: null }, { title: 'Second task', deadline: null }],
      TZ
    );
    const afterFirst = withTasksSection('Team sync notes', oneTask);
    const afterSecond = withTasksSection(afterFirst, twoTasks);
    expect(afterSecond).toBe(`Team sync notes\n\n${twoTasks}`);
  });
});
