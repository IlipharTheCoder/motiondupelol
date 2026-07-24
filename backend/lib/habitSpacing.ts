import type { Interval } from './intervals';

export interface OccurrenceSegment {
  start: number;
  end: number;
}

// Splits [rangeStart, rangeEnd) into `count` equal-length segments — how a
// habit's remaining occurrences get spread across what's left of its
// period, rather than clustering together in whatever free time comes
// first. Degenerates correctly for count === 1 (one segment spanning the
// whole range — plain forward-fill), no special-casing needed.
export function splitIntoSegments(rangeStart: number, rangeEnd: number, count: number): OccurrenceSegment[] {
  if (count <= 0) return [];

  const totalMs = rangeEnd - rangeStart;
  const segments: OccurrenceSegment[] = [];
  for (let i = 0; i < count; i++) {
    const start = rangeStart + Math.round((totalMs * i) / count);
    const end = i === count - 1 ? rangeEnd : rangeStart + Math.round((totalMs * (i + 1)) / count);
    segments.push({ start, end });
  }
  return segments;
}

// Finds where one occurrence should land: the earliest sub-interval of
// `fitting` (assumed already sorted ascending, non-overlapping — same
// contract as lib/intervals.ts's functions) that fits `durationMs`,
// preferring one inside [segStart, segEnd). If the segment itself has no
// room, falls back to the earliest fit anywhere from segStart through the
// end of `fitting`'s range — but never before segStart. Letting an
// occurrence backfill into an earlier segment's leftover slack would work
// against the spacing goal (it's supposed to land after the previous
// occurrence, not next to it); slipping later is fine, slipping earlier
// isn't.
export function findOccurrenceSlot(
  fitting: Interval[],
  segStart: number,
  segEnd: number,
  durationMs: number
): Interval | undefined {
  for (const slot of fitting) {
    if (slot.start >= segEnd) break; // fitting is ascending — nothing earlier left in-segment
    const effectiveStart = Math.max(slot.start, segStart);
    const cappedEnd = Math.min(slot.end, segEnd);
    if (effectiveStart + durationMs <= cappedEnd) {
      return { start: effectiveStart, end: effectiveStart + durationMs };
    }
  }

  for (const slot of fitting) {
    if (slot.end < segStart) continue;
    const effectiveStart = Math.max(slot.start, segStart);
    if (effectiveStart + durationMs <= slot.end) {
      return { start: effectiveStart, end: effectiveStart + durationMs };
    }
  }

  return undefined;
}
