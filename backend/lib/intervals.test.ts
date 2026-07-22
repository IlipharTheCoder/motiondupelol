import { describe, expect, it } from 'vitest';
import {
  mergeIntervals,
  subtractIntervals,
  padIntervals,
  filterByMinDuration,
  intervalsOverlap,
  type Interval,
} from './intervals';

function iv(start: number, end: number): Interval {
  return { start, end };
}

describe('mergeIntervals', () => {
  it('returns empty for empty input', () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  it('passes through a single interval', () => {
    expect(mergeIntervals([iv(0, 10)])).toEqual([iv(0, 10)]);
  });

  it('keeps two disjoint intervals separate', () => {
    expect(mergeIntervals([iv(0, 10), iv(20, 30)])).toEqual([iv(0, 10), iv(20, 30)]);
  });

  it('merges two overlapping intervals', () => {
    expect(mergeIntervals([iv(0, 10), iv(5, 15)])).toEqual([iv(0, 15)]);
  });

  it('merges two back-to-back (zero-gap) intervals', () => {
    expect(mergeIntervals([iv(0, 10), iv(10, 20)])).toEqual([iv(0, 20)]);
  });

  it('transitively merges a chain of three intervals', () => {
    expect(mergeIntervals([iv(0, 10), iv(9, 20), iv(19, 30)])).toEqual([iv(0, 30)]);
  });

  it('drops a zero-duration interval', () => {
    expect(mergeIntervals([iv(0, 10), iv(5, 5)])).toEqual([iv(0, 10)]);
  });

  it('drops an inverted (end < start) interval', () => {
    expect(mergeIntervals([iv(0, 10), iv(8, 3)])).toEqual([iv(0, 10)]);
  });

  it('is order-independent (unsorted input)', () => {
    const sorted = mergeIntervals([iv(0, 10), iv(20, 30), iv(9, 21)]);
    const unsorted = mergeIntervals([iv(20, 30), iv(9, 21), iv(0, 10)]);
    expect(unsorted).toEqual(sorted);
  });

  it('collapses duplicate identical intervals', () => {
    expect(mergeIntervals([iv(0, 10), iv(0, 10)])).toEqual([iv(0, 10)]);
  });
});

describe('subtractIntervals', () => {
  it('returns the window unchanged when subtracting nothing', () => {
    expect(subtractIntervals([iv(0, 100)], [])).toEqual([iv(0, 100)]);
  });

  it('removes the window entirely when fully covered', () => {
    expect(subtractIntervals([iv(0, 100)], [iv(-10, 110)])).toEqual([]);
  });

  it('carves a gap from the middle, producing two remainders', () => {
    expect(subtractIntervals([iv(0, 100)], [iv(40, 60)])).toEqual([iv(0, 40), iv(60, 100)]);
  });

  it('carves from the start edge, producing one remainder', () => {
    expect(subtractIntervals([iv(0, 100)], [iv(0, 30)])).toEqual([iv(30, 100)]);
  });

  it('carves from the end edge, producing one remainder', () => {
    expect(subtractIntervals([iv(0, 100)], [iv(70, 100)])).toEqual([iv(0, 70)]);
  });

  it('leaves the window untouched when the busy interval only touches the boundary', () => {
    expect(subtractIntervals([iv(0, 100)], [iv(100, 150)])).toEqual([iv(0, 100)]);
    expect(subtractIntervals([iv(0, 100)], [iv(-50, 0)])).toEqual([iv(0, 100)]);
  });

  it('carves multiple non-overlapping busy intervals independently', () => {
    expect(subtractIntervals([iv(0, 100)], [iv(10, 20), iv(50, 60)])).toEqual([
      iv(0, 10),
      iv(20, 50),
      iv(60, 100),
    ]);
  });

  it('ignores busy intervals entirely outside the window', () => {
    expect(subtractIntervals([iv(0, 100)], [iv(200, 300)])).toEqual([iv(0, 100)]);
  });

  it('returns empty for an empty base list', () => {
    expect(subtractIntervals([], [iv(0, 10)])).toEqual([]);
  });
});

describe('padIntervals', () => {
  it('is a no-op at zero padding', () => {
    expect(padIntervals([iv(0, 10)], 0)).toEqual([iv(0, 10)]);
  });

  it('expands both ends by the correct ms amount', () => {
    expect(padIntervals([iv(60_000, 120_000)], 1)).toEqual([iv(0, 180_000)]);
  });

  it('throws on negative padding', () => {
    expect(() => padIntervals([iv(0, 10)], -1)).toThrow();
  });
});

describe('filterByMinDuration', () => {
  it('passes an interval exactly equal to the minimum', () => {
    expect(filterByMinDuration([iv(0, 600_000)], 10)).toEqual([iv(0, 600_000)]);
  });

  it('drops an interval one minute under the minimum', () => {
    expect(filterByMinDuration([iv(0, 540_000)], 10)).toEqual([]);
  });

  it('passes everything when minDurationMinutes is 0', () => {
    expect(filterByMinDuration([iv(0, 1)], 0)).toEqual([iv(0, 1)]);
  });
});

describe('intervalsOverlap', () => {
  it('detects identical intervals as overlapping', () => {
    expect(intervalsOverlap(iv(0, 10), iv(0, 10))).toBe(true);
  });

  it('does not count back-to-back intervals as overlapping', () => {
    expect(intervalsOverlap(iv(0, 10), iv(10, 20))).toBe(false);
  });

  it('detects partial overlap on each side', () => {
    expect(intervalsOverlap(iv(0, 10), iv(5, 15))).toBe(true);
    expect(intervalsOverlap(iv(5, 15), iv(0, 10))).toBe(true);
  });

  it('detects one interval fully containing another', () => {
    expect(intervalsOverlap(iv(0, 100), iv(40, 60))).toBe(true);
  });

  it('does not count fully disjoint intervals as overlapping', () => {
    expect(intervalsOverlap(iv(0, 10), iv(20, 30))).toBe(false);
  });
});
