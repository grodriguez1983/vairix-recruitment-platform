/**
 * Recency decay on skill years (ADR-026).
 *
 * The matcher (ADR-015 §3) used to consume `yearsForSkill` directly,
 * collapsing two distinct signals: "how much time worked with X" and
 * "how recently". A candidate with 5 years of Java between 2005-2010
 * scored the same as one with 5 years between 2020-2025 against a
 * `senior` JD. This module introduces a multiplicative decay factor
 * that penalises stale skills.
 *
 * Formula:
 *   yearsSinceLastUse = max(0, (asOf − lastUsed) / MS_PER_YEAR)
 *   decayFactor       = 0.5 ^ (yearsSinceLastUse / HALF_LIFE_YEARS)
 *   effectiveYears    = rawYears × decayFactor
 *
 * `lastUsed`:
 *   - MAX(end_date ?? asOf) over `work` + `side_project` experiences
 *     that mention the resolved `skill_id`. Education excluded
 *     (consistent with ADR-015 / ADR-020).
 *   - `end_date = null` → ongoing → treated as `asOf` → factor 1.
 *   - `null` when no contributing experience exists.
 *
 * `asOf` is REQUIRED (no wallclock default) — determinism is part of
 * the API contract (ADR-026 §asOf determinístico). Callers in the
 * matcher pass `catalogSnapshotAt`, the same persisted snapshot
 * already used by `ranker.ts` as `now`.
 *
 * Pure: same inputs → same output, no side effects.
 */
import { parseDate } from './date-intervals';
import type { ExperienceKind, MergedExperience } from './types';
import { yearsForSkill } from './years-calculator';

export const HALF_LIFE_YEARS = 4;
const MS_PER_YEAR = 365.2425 * 24 * 60 * 60 * 1000;
const RECENCY_KINDS: ReadonlySet<ExperienceKind> = new Set(['work', 'side_project']);

export interface EffectiveYearsResult {
  rawYears: number;
  effectiveYears: number;
  lastUsed: Date | null;
  yearsSinceLastUse: number;
  decayFactor: number;
}

export interface EffectiveYearsOptions {
  asOf: Date;
  halfLifeYears?: number;
}

export function decayFactor(yearsSinceLastUse: number, halfLife: number = HALF_LIFE_YEARS): number {
  if (yearsSinceLastUse <= 0) return 1;
  if (halfLife <= 0) return 1;
  return Math.pow(0.5, yearsSinceLastUse / halfLife);
}

function hasResolvedSkill(experience: MergedExperience, skillId: string): boolean {
  return experience.skills.some((s) => s.skill_id === skillId);
}

export function lastUsedFor(
  skillId: string,
  experiences: readonly MergedExperience[],
  asOf: Date,
): Date | null {
  let maxMs: number | null = null;
  for (const exp of experiences) {
    if (!RECENCY_KINDS.has(exp.kind)) continue;
    if (!hasResolvedSkill(exp, skillId)) continue;
    if (exp.start_date === null) continue;
    const startMs = parseDate(exp.start_date);
    if (startMs === null) continue;
    const endMs = exp.end_date === null ? asOf.getTime() : parseDate(exp.end_date);
    if (endMs === null) continue;
    if (endMs <= startMs) continue; // data bug: end ≤ start, skip (matches yearsForSkill)
    if (maxMs === null || endMs > maxMs) maxMs = endMs;
  }
  return maxMs === null ? null : new Date(maxMs);
}

export function effectiveYearsForSkill(
  skillId: string,
  experiences: readonly MergedExperience[],
  options: EffectiveYearsOptions,
): EffectiveYearsResult {
  const halfLife = options.halfLifeYears ?? HALF_LIFE_YEARS;
  const rawYears = yearsForSkill(skillId, experiences, { now: options.asOf });
  const lastUsed = lastUsedFor(skillId, experiences, options.asOf);

  if (rawYears === 0 || lastUsed === null) {
    return {
      rawYears,
      effectiveYears: 0,
      lastUsed,
      yearsSinceLastUse: 0,
      decayFactor: 1,
    };
  }

  const elapsedMs = options.asOf.getTime() - lastUsed.getTime();
  const yearsSinceLastUse = elapsedMs > 0 ? elapsedMs / MS_PER_YEAR : 0;
  const factor = decayFactor(yearsSinceLastUse, halfLife);
  return {
    rawYears,
    effectiveYears: rawYears * factor,
    lastUsed,
    yearsSinceLastUse,
    decayFactor: factor,
  };
}
