/**
 * Years-for-skill sweep-line calculator (ADR-015 §1, F4-007 sub-B).
 *
 * For a given `skillId`, collects every `kind='work'` experience that
 * claims that skill id (resolved rows only — uncataloged matches are
 * invisible to the ranker, see ADR-015 §1 invariants), converts each
 * experience to a millisecond interval, merges overlapping intervals
 * by sweep-line, and returns the total duration in years.
 *
 * Contract:
 *   - Only `kind='work'` contributes. Side projects + education are
 *     excluded at source.
 *   - Experiences with `skill_id IS NULL` in `skills[]` never count,
 *     even if `skill_raw` matches a resolved canonical name — the
 *     catalog is the only source of truth.
 *   - `start_date = null` or invalid → experience is skipped silently
 *     (logged upstream via `match_runs.diagnostics`).
 *   - `end_date = null` → present, treated as `options.now`.
 *   - `end <= start` → skipped (data bug defense).
 *
 * Pure: `now` is injectable; same inputs → same output.
 */
import { MS_PER_YEAR, toInterval, type Interval } from './date-intervals';
import type { MergedExperience } from './types';

export interface YearsOptions {
  now?: Date;
}

function hasSkill(experience: MergedExperience, skillId: string): boolean {
  return experience.skills.some((s) => s.skill_id === skillId);
}

function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (curr.start <= last.end) {
      last.end = Math.max(last.end, curr.end);
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}

export function yearsForSkill(
  skillId: string,
  experiences: readonly MergedExperience[],
  options: YearsOptions = {},
): number {
  const now = options.now ?? new Date();

  const intervals: Interval[] = [];
  for (const exp of experiences) {
    if (exp.kind !== 'work') continue;
    if (!hasSkill(exp, skillId)) continue;
    const iv = toInterval(exp.start_date, exp.end_date, now);
    if (iv === null) continue;
    intervals.push(iv);
  }

  const merged = mergeIntervals(intervals);
  const totalMs = merged.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
  return totalMs / MS_PER_YEAR;
}
