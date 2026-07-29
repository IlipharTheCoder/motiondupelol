import { describe, expect, it } from 'vitest';
import { formatDeadline, formatTimeRange } from './dateFormat';

// Deliberately timezone-agnostic: expected values are derived from the same
// local-time Date getters the implementation uses, not hardcoded strings —
// formatDeadline/formatTimeRange render in the viewer's local time (matching
// the Swift app's own default-local-time `.formatted(.dateTime...)`
// behavior), so a test hardcoded against one timezone would be flaky on any
// machine/CI runner in a different one.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

describe('formatDeadline', () => {
  it('formats as "Mon D" in local time', () => {
    const iso = '2026-07-28T23:59:59Z';
    const d = new Date(iso);
    expect(formatDeadline(iso)).toBe(`${MONTHS[d.getMonth()]} ${d.getDate()}`);
  });
});

describe('formatTimeRange', () => {
  it('formats a start-only range as "Weekday Mon D HH:MM"', () => {
    const iso = '2026-07-28T14:00:00Z';
    const d = new Date(iso);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    expect(formatTimeRange(iso, null)).toBe(
      `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`
    );
  });

  it('appends "– HH:MM" for the end time when present, without repeating the date', () => {
    const startIso = '2026-07-28T14:00:00Z';
    const endIso = '2026-07-28T15:30:00Z';
    const end = new Date(endIso);
    const hh = end.getHours().toString().padStart(2, '0');
    const mm = end.getMinutes().toString().padStart(2, '0');
    const result = formatTimeRange(startIso, endIso);
    expect(result.endsWith(`– ${hh}:${mm}`)).toBe(true);
    expect(result.startsWith(formatTimeRange(startIso, null))).toBe(true);
  });
});
