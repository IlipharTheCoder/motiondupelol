// Epoch milliseconds throughout — the one universal, DST-proof
// representation for interval comparison. Callers convert to/from a Luxon
// DateTime or an ISO string at the boundary; nothing in this module ever
// touches a timezone.
export interface Interval {
  start: number; // inclusive
  end: number; // exclusive
}

export function isValidInterval(interval: Interval): boolean {
  return interval.end > interval.start;
}

export function mergeIntervals(intervals: Interval[]): Interval[] {
  const valid = intervals.filter(isValidInterval).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];

  for (const interval of valid) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      // Overlapping or exactly adjacent (zero-gap) — extend the run.
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  return merged;
}

// `base` and `subtract` are each assumed already merged/sorted — this keeps
// the function single-purpose and independently testable rather than
// re-sorting inputs a caller may have already prepared.
export function subtractIntervals(base: Interval[], subtract: Interval[]): Interval[] {
  const result: Interval[] = [];

  for (const window of base) {
    let remainderStart = window.start;

    for (const busy of subtract) {
      if (busy.end <= remainderStart || busy.start >= window.end) {
        continue; // no overlap with the remaining window
      }

      if (busy.start > remainderStart) {
        result.push({ start: remainderStart, end: busy.start });
      }

      remainderStart = Math.max(remainderStart, busy.end);
      if (remainderStart >= window.end) break;
    }

    if (remainderStart < window.end) {
      result.push({ start: remainderStart, end: window.end });
    }
  }

  return result;
}

export function padIntervals(intervals: Interval[], paddingMinutes: number): Interval[] {
  if (paddingMinutes < 0) {
    throw new Error(`paddingMinutes must not be negative (got ${paddingMinutes})`);
  }
  if (paddingMinutes === 0) return intervals;

  const paddingMs = paddingMinutes * 60_000;
  return intervals.map((interval) => ({
    start: interval.start - paddingMs,
    end: interval.end + paddingMs,
  }));
}

export function filterByMinDuration(intervals: Interval[], minDurationMinutes: number): Interval[] {
  if (!minDurationMinutes) return intervals;
  const minDurationMs = minDurationMinutes * 60_000;
  return intervals.filter((interval) => interval.end - interval.start >= minDurationMs);
}

// Half-open overlap test. Back-to-back (a.end === b.start) is deliberately
// NOT an overlap — two meetings touching edge-to-edge isn't a conflict,
// even though mergeIntervals treats that same adjacency as contiguous busy
// time. Different questions, deliberately different answers.
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}
