// Pure string logic behind lib/eventTaskDescription.ts's generated tasks
// section — split out with zero I/O imports so it's unit-testable without
// constructing real Supabase/Google Calendar clients (same "pure math in its
// own module" convention as lib/intervals.ts relative to lib/freeSlots.ts).
import { DateTime } from 'luxon';
import type { TaskRow } from './aiTasks';

export const SECTION_START = '--- Tasks on this event (auto-generated, do not edit below) ---';
export const SECTION_END = '--- End tasks ---';
// Matches the start/end markers and everything between them, including the
// markers themselves and up to two adjacent newlines on either side.
const SECTION_RE = new RegExp(
  `\\n?\\n?${escapeRegExp(SECTION_START)}[\\s\\S]*?${escapeRegExp(SECTION_END)}\\n?\\n?`,
  'g'
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTasksSection(tasks: Pick<TaskRow, 'title' | 'deadline'>[], homeTimezone: string): string {
  const lines = tasks.map((task) => {
    const deadline = task.deadline
      ? ` (due ${DateTime.fromISO(task.deadline, { zone: homeTimezone }).toFormat('yyyy-LL-dd')})`
      : '';
    return `- ${task.title}${deadline}`;
  });
  return [SECTION_START, ...lines, SECTION_END].join('\n');
}

// tasksSection: null means "no tasks currently linked" — removes the
// section entirely rather than leaving an empty one.
export function withTasksSection(existingDescription: string, tasksSection: string | null): string {
  const withoutSection = existingDescription.replace(SECTION_RE, '').trimEnd();
  if (!tasksSection) return withoutSection;
  return withoutSection.length > 0 ? `${withoutSection}\n\n${tasksSection}` : tasksSection;
}
