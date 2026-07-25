import { describe, expect, it } from 'vitest';
import { formatTimeAnchors, formatCalendarDigest } from './nlContext';
import type { SchedulingConfig } from './schedulingConfig';
import type { CalendarEventSummary } from './calendarEvents';

const config: SchedulingConfig = {
  homeTimezone: 'America/New_York',
  workingHoursStart: { hour: 10, minute: 0 },
  workingHoursEnd: { hour: 18, minute: 0 },
  workingDays: [1, 2, 3, 4, 5],
};

describe('formatTimeAnchors', () => {
  it('resolves today/tomorrow/this-week against a fixed clock, not wall-clock time', () => {
    // A Thursday, per the same fixed-date convention as
    // lib/recurringOccurrences.test.ts — this must never call Date.now()
    // internally, since its whole reason for existing is to stay outside the
    // cacheable prompt prefix (see this file's own top-of-file comment).
    const now = new Date('2026-08-06T19:00:00-04:00');
    const output = formatTimeAnchors(now, config);

    expect(output).toContain('Today: 2026-08-06');
    expect(output).toContain('Tomorrow: 2026-08-07');
    expect(output).toContain('This week: 2026-08-03 to 2026-08-09');
    expect(output).toContain('10:00-18:00');
    expect(output).toContain('Monday, Tuesday, Wednesday, Thursday, Friday');
  });
});

describe('formatCalendarDigest', () => {
  it('reports an empty digest plainly', () => {
    expect(formatCalendarDigest([])).toBe('No upcoming events in the digest window.');
  });

  it('formats a timed event with tags', () => {
    const events: CalendarEventSummary[] = [
      {
        id: 'evt1',
        summary: 'Dentist',
        description: null,
        location: null,
        start: { dateTime: '2026-08-06T14:00:00-04:00' },
        end: { dateTime: '2026-08-06T15:00:00-04:00' },
        status: 'confirmed',
        htmlLink: null,
        category: 'personal',
        priority: 'medium',
        deadline: null,
        colorTag: null,
        tags: ['health'],
        origin: { sourceSystem: 'manual', sourceLabel: null },
      },
    ];

    const output = formatCalendarDigest(events);
    expect(output).toContain('evt1');
    expect(output).toContain('Dentist');
    expect(output).toContain('2026-08-06T14:00:00-04:00');
    expect(output).toContain('[health]');
  });
});
