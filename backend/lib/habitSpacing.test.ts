import { describe, expect, it } from 'vitest';
import { splitIntoSegments, findOccurrenceSlot } from './habitSpacing';
import type { Interval } from './intervals';

function iv(start: number, end: number): Interval {
  return { start, end };
}

describe('splitIntoSegments', () => {
  it('returns empty for zero or negative count', () => {
    expect(splitIntoSegments(0, 100, 0)).toEqual([]);
    expect(splitIntoSegments(0, 100, -1)).toEqual([]);
  });

  it('returns a single segment spanning the whole range for count 1 (degenerate case)', () => {
    expect(splitIntoSegments(0, 100, 1)).toEqual([{ start: 0, end: 100 }]);
  });

  it('splits evenly when the range divides cleanly', () => {
    expect(splitIntoSegments(0, 90, 3)).toEqual([
      { start: 0, end: 30 },
      { start: 30, end: 60 },
      { start: 60, end: 90 },
    ]);
  });

  it('covers the full range contiguously even when it does not divide evenly, with the last segment ending exactly at rangeEnd', () => {
    const segments = splitIntoSegments(0, 100, 3);
    expect(segments[0].start).toBe(0);
    expect(segments[segments.length - 1].end).toBe(100);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].start).toBe(segments[i - 1].end);
    }
  });
});

describe('findOccurrenceSlot', () => {
  it('picks the earliest fitting sub-interval inside the segment', () => {
    const fitting = [iv(10, 50)];
    expect(findOccurrenceSlot(fitting, 0, 30, 10)).toEqual(iv(10, 20));
  });

  it('falls back to a later opening when the segment itself has no room', () => {
    const fitting = [iv(40, 60)];
    expect(findOccurrenceSlot(fitting, 0, 30, 10)).toEqual(iv(40, 50));
  });

  it('never picks a slot before segStart, even if an earlier fitting interval exists', () => {
    const fitting = [iv(0, 100)];
    expect(findOccurrenceSlot(fitting, 50, 80, 10)).toEqual(iv(50, 60));
  });

  it('returns undefined when nothing fits at all', () => {
    const fitting = [iv(0, 5)];
    expect(findOccurrenceSlot(fitting, 0, 30, 10)).toBeUndefined();
  });

  it('skips a too-short first slot and finds a later one within the same segment', () => {
    const fitting = [iv(0, 5), iv(20, 40)];
    expect(findOccurrenceSlot(fitting, 0, 30, 10)).toEqual(iv(20, 30));
  });
});
