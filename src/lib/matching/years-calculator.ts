/**
 * Years-for-skill sweep-line calculator (ADR-015 §1 + ADR-020).
 *
 * For a given `skillId`, collects every experience (work or
 * side_project) that claims that skill id (resolved rows only —
 * uncataloged matches are invisible to the ranker, see ADR-015 §1
 * invariants), merges overlapping intervals by sweep-line, and returns
 * the total weighted duration in years.
 *
 * Weighting (ADR-020):
 *   - `kind='work'`         → 1.00
 *   - `kind='side_project'` → 0.25, applied to the portion that does
 *     NOT overlap with any `work` interval (set-subtraction avoids
 *     double-counting the same calendar window).
 *   - `kind='education'`    → 0 (excluded, unchanged from ADR-015).
 *
 * Contract:
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
import { MS_PER_YEAR, subtractIntervals, toInterval, type Interval } from './date-intervals';
import type { ExperienceKind, MergedExperience } from './types';

export interface YearsOptions {
  now?: Date;
}

const SIDE_PROJECT_WEIGHT = 0.25;

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

function collectIntervals(
  skillId: string,
  experiences: readonly MergedExperience[],
  kind: ExperienceKind,
  now: Date,
): Interval[] {
  const intervals: Interval[] = [];
  for (const exp of experiences) {
    if (exp.kind !== kind) continue;
    if (!hasSkill(exp, skillId)) continue;
    const iv = toInterval(exp.start_date, exp.end_date, now);
    if (iv === null) continue;
    intervals.push(iv);
  }
  return intervals;
}

function totalMs(intervals: readonly Interval[]): number {
  return intervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
}

export function yearsForSkill(
  skillId: string,
  experiences: readonly MergedExperience[],
  options: YearsOptions = {},
): number {
  const now = options.now ?? new Date();

  const workMerged = mergeIntervals(collectIntervals(skillId, experiences, 'work', now));
  const sideMerged = mergeIntervals(collectIntervals(skillId, experiences, 'side_project', now));
  const sideNet = subtractIntervals(sideMerged, workMerged);

  const workYears = totalMs(workMerged) / MS_PER_YEAR;
  const sideYears = totalMs(sideNet) / MS_PER_YEAR;

  return workYears + SIDE_PROJECT_WEIGHT * sideYears;
}
