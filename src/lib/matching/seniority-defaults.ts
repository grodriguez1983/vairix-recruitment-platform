/**
 * ADR-022 — canonical `min_years` baseline derived from the JD's
 * seniority when a requirement does not carry an explicit
 * `min_years`. Matches the existing seniority bucketing in
 * `score-aggregator.ts` (<2 junior, 2–5 semi_senior, 5–10 senior,
 * 10+ lead) by picking the lower bound of each bucket as the
 * "competent at this bucket" piso.
 *
 * `unspecified` returns `null` on purpose: the JD gave no seniority
 * signal, so the binary presence fallback stays (ADR-015 §3). A
 * caller that reads `null` must NOT divide by it; the score-
 * aggregator branches on that.
 */
import type { Seniority } from '../rag/decomposition/types';

const DEFAULTS: Record<Exclude<Seniority, 'unspecified'>, number> = {
  junior: 1,
  semi_senior: 2,
  senior: 3,
  lead: 5,
};

export function defaultMinYearsFor(seniority: Seniority): number | null {
  if (seniority === 'unspecified') return null;
  return DEFAULTS[seniority];
}
