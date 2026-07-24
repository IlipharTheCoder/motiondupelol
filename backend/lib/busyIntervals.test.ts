import { describe, expect, it } from 'vitest';
import type { calendar_v3 } from 'googleapis';
import { DateTime } from 'luxon';
import { normalizeEventToInterval } from './busyIntervals';

const HOME_TIMEZONE = 'America/New_York';

function fakeEvent(overrides: Partial<calendar_v3.Schema$Event>): calendar_v3.Schema$Event {
  return {
    id: 'event-1',
    summary: 'Test event',
    status: 'confirmed',
    ...overrides,
  };
}

describe('normalizeEventToInterval', () => {
  it('treats a single-day all-day event as a note, not busy time', () => {
    const event = fakeEvent({
      start: { date: '2026-07-01' },
      end: { date: '2026-07-02' }, // exclusive, per Google's all-day semantics
    });

    expect(normalizeEventToInterval(event, HOME_TIMEZONE)).toBeNull();
  });

  it('treats a multi-day all-day event as a note, not busy time — never blocks its whole date range', () => {
    const event = fakeEvent({
      start: { date: '2026-07-01' },
      end: { date: '2026-07-04' },
    });

    expect(normalizeEventToInterval(event, HOME_TIMEZONE)).toBeNull();
  });

  it('resolves a timed event using its own timeZone, independent of the home timezone', () => {
    const event = fakeEvent({
      start: { dateTime: '2026-07-01T09:00:00', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-07-01T10:00:00', timeZone: 'America/Los_Angeles' },
    });

    const result = normalizeEventToInterval(event, HOME_TIMEZONE);

    const expectedStart = DateTime.fromISO('2026-07-01T09:00:00', { zone: 'America/Los_Angeles' }).toMillis();
    const expectedEnd = DateTime.fromISO('2026-07-01T10:00:00', { zone: 'America/Los_Angeles' }).toMillis();

    expect(result?.start).toBe(expectedStart);
    expect(result?.end).toBe(expectedEnd);
    // Sanity cross-check: 9am Pacific in July (PDT, UTC-7) is noon Eastern (EDT, UTC-4).
    expect(DateTime.fromMillis(expectedStart, { zone: HOME_TIMEZONE }).hour).toBe(12);
  });

  it('resolves start and end independently when they carry different timezones', () => {
    const event = fakeEvent({
      start: { dateTime: '2026-07-01T09:00:00', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-07-01T13:00:00', timeZone: 'America/New_York' },
    });

    const result = normalizeEventToInterval(event, HOME_TIMEZONE);

    const expectedStart = DateTime.fromISO('2026-07-01T09:00:00', { zone: 'America/Los_Angeles' }).toMillis();
    const expectedEnd = DateTime.fromISO('2026-07-01T13:00:00', { zone: 'America/New_York' }).toMillis();

    expect(result?.start).toBe(expectedStart);
    expect(result?.end).toBe(expectedEnd);
  });

  it('produces a zero-duration interval without crashing for a zero-duration timed event', () => {
    const event = fakeEvent({
      start: { dateTime: '2026-07-01T09:00:00', timeZone: HOME_TIMEZONE },
      end: { dateTime: '2026-07-01T09:00:00', timeZone: HOME_TIMEZONE },
    });

    const result = normalizeEventToInterval(event, HOME_TIMEZONE);

    expect(result?.start).toBe(result?.end);
  });

  it('filters out a cancelled event', () => {
    const event = fakeEvent({
      status: 'cancelled',
      start: { dateTime: '2026-07-01T09:00:00', timeZone: HOME_TIMEZONE },
      end: { dateTime: '2026-07-01T10:00:00', timeZone: HOME_TIMEZONE },
    });

    expect(normalizeEventToInterval(event, HOME_TIMEZONE)).toBeNull();
  });

  it('filters out an event missing an id', () => {
    const event = fakeEvent({
      id: undefined,
      start: { dateTime: '2026-07-01T09:00:00', timeZone: HOME_TIMEZONE },
      end: { dateTime: '2026-07-01T10:00:00', timeZone: HOME_TIMEZONE },
    });

    expect(normalizeEventToInterval(event, HOME_TIMEZONE)).toBeNull();
  });

  it('filters out an event missing start/end entirely', () => {
    expect(normalizeEventToInterval(fakeEvent({}), HOME_TIMEZONE)).toBeNull();
  });
});
