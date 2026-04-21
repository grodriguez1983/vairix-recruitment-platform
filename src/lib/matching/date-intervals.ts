/**
 * Shared date + interval helpers for the matcher (ADR-015 §1-§2).
 *
 * Isolated here because variant-merger (sub-A) and years-calculator
 * (sub-B) both need to parse partial ISO dates and reason about
 * intervals with `null` end (= present). Keeping the primitives in
 * one file avoids drift — changing what "present" means (e.g. freezing
 * to catalog_snapshot_at) is a one-line edit.
 */

export const MS_PER_YEAR = 365.2425 * 24 * 60 * 60 * 1000;

export interface Interval {
  start: number;
  end: number;
}

export function parseDate(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Builds an `Interval` from a pair of string dates. Returns null when
 * start is null/invalid or when end ≤ start. `end === null` is
 * interpreted as `now` — the caller chooses what "now" means (real
 * wallclock in production, a fixed date in tests).
 */
export function toInterval(start: string | null, end: string | null, now: Date): Interval | null {
  if (start === null) return null;
  const startMs = parseDate(start);
  if (startMs === null) return null;
  const endMs = end === null ? now.getTime() : parseDate(end);
  if (endMs === null) return null;
  if (endMs <= startMs) return null;
  return { start: startMs, end: endMs };
}

/**
 * Ratio of overlap to the shortest of the two intervals. Used by the
 * variant merger to decide if two experiences describe the same role.
 */
export function overlapRatio(a: Interval, b: Interval): number {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  if (overlap === 0) return 0;
  const shortest = Math.min(a.end - a.start, b.end - b.start);
  return shortest === 0 ? 0 : overlap / shortest;
}
