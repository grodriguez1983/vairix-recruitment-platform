/**
 * Score aggregator (ADR-015 §3, F4-007 sub-C).
 *
 * Pure function: given a resolved job query and a candidate's merged
 * experiences + languages, compute the per-requirement breakdown, the
 * must-have gate, the language/seniority adjustments and the final
 * clamped `[0, 100]` score.
 *
 * Determinism: `now` is injectable. No side effects.
 *
 * Gate rule (tests + ADR §3.1 + ADR-021): must-have requirements
 * are evaluated per group (see `alternative_group_id`). A group
 * fails the gate when every resolved alternative in the group has
 * `years_ratio === 0`. A group whose alternatives are ALL
 * unresolved does NOT fail the gate (catalog drift must not
 * silently hide candidates — ADR-015 §Consecuencias).
 *
 * Score aggregation (ADR-021): alternatives inside a group
 * collapse to a single contribution = `max` of the per-alternative
 * contributions, and the group's weight is ONE alternative's
 * weight (2.0 for a must-have group, 1.0 for a nice group), not
 * N×weight. This keeps the denominator the same as if the group
 * were a single requirement; otherwise OR groups would be
 * undernormalized against singletons.
 *
 * Language delta:
 *   - `-10` if any must_have language is missing on the candidate.
 *   - `+5` if all required languages are matched (and no must_have
 *     missing).
 *   - `0` otherwise.
 *
 * Seniority delta (only when job query is not `unspecified`):
 *   - `+5` candidate bucket == job bucket
 *   - `-5` candidate bucket is below the job bucket
 *   - `0` candidate bucket is above the job bucket (overqualified
 *     shouldn't be penalized; not explicitly tested).
 *
 * Seniority buckets are derived from total work years (sweep-line of
 * all `kind='work'` experiences): <2 junior, 2–5 semi_senior, 5–10
 * senior, 10+ lead.
 */
import type { ResolvedDecomposition } from '../rag/decomposition/resolve-requirements';
import type { Seniority } from '../rag/decomposition/types';

import { MS_PER_YEAR, toInterval, type Interval } from './date-intervals';
import { defaultMinYearsFor } from './seniority-defaults';
import type {
  CandidateAggregate,
  CandidateScore,
  MatchStatus,
  MergedExperience,
  MustHaveGate,
  RequirementBreakdown,
  SeniorityMatch,
} from './types';
import { yearsForSkill } from './years-calculator';

export interface AggregateScoreOptions {
  now?: Date;
}

const WEIGHT_MUST_HAVE = 2.0;
const WEIGHT_NICE = 1.0;
const LANGUAGE_BONUS = 5;
const LANGUAGE_MUST_HAVE_PENALTY = 10;
const SENIORITY_MATCH_BONUS = 5;
const SENIORITY_BELOW_PENALTY = 5;

const SENIORITY_RANK: Record<Exclude<Seniority, 'unspecified'>, number> = {
  junior: 0,
  semi_senior: 1,
  senior: 2,
  lead: 3,
};

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

function totalWorkYears(experiences: readonly MergedExperience[], now: Date): number {
  const intervals: Interval[] = [];
  for (const exp of experiences) {
    if (exp.kind !== 'work') continue;
    const iv = toInterval(exp.start_date, exp.end_date, now);
    if (iv !== null) intervals.push(iv);
  }
  const merged = mergeIntervals(intervals);
  const totalMs = merged.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
  return totalMs / MS_PER_YEAR;
}

function candidateSeniorityBucket(totalYears: number): Exclude<Seniority, 'unspecified'> {
  if (totalYears >= 10) return 'lead';
  if (totalYears >= 5) return 'senior';
  if (totalYears >= 2) return 'semi_senior';
  return 'junior';
}

function formatDateRange(exp: MergedExperience): string {
  const start = exp.start_date ?? '?';
  const end = exp.end_date ?? 'present';
  return `${start} → ${end}`;
}

function collectEvidence(
  skillId: string,
  experiences: readonly MergedExperience[],
): RequirementBreakdown['evidence'] {
  const evidence: RequirementBreakdown['evidence'] = [];
  for (const exp of experiences) {
    if (exp.kind !== 'work') continue;
    if (!exp.skills.some((s) => s.skill_id === skillId)) continue;
    evidence.push({
      experience_id: exp.id,
      company: exp.company,
      date_range: formatDateRange(exp),
    });
  }
  return evidence;
}

function statusFor(ratio: number): MatchStatus {
  if (ratio >= 1) return 'match';
  if (ratio > 0) return 'partial';
  return 'missing';
}

function computeLanguageMatch(
  jobQuery: ResolvedDecomposition,
  candidate: CandidateAggregate,
): { required: number; matched: number; mustHaveMissing: boolean } {
  const candidateNames = new Set(candidate.languages.map((l) => l.name.toLowerCase()));
  let matched = 0;
  let mustHaveMissing = false;
  for (const lang of jobQuery.languages) {
    const has = candidateNames.has(lang.name.toLowerCase());
    if (has) matched++;
    else if (lang.must_have) mustHaveMissing = true;
  }
  return { required: jobQuery.languages.length, matched, mustHaveMissing };
}

function computeSeniorityMatch(
  jobQuery: ResolvedDecomposition,
  candidate: CandidateAggregate,
  now: Date,
): SeniorityMatch {
  if (jobQuery.seniority === 'unspecified') return 'unknown';
  const years = totalWorkYears(candidate.merged_experiences, now);
  const candidateBucket = candidateSeniorityBucket(years);
  const jobRank = SENIORITY_RANK[jobQuery.seniority];
  const candRank = SENIORITY_RANK[candidateBucket];
  if (candRank === jobRank) return 'match';
  if (candRank < jobRank) return 'below';
  return 'above';
}

export function aggregateScore(
  jobQuery: ResolvedDecomposition,
  candidate: CandidateAggregate,
  options: AggregateScoreOptions = {},
): CandidateScore {
  const now = options.now ?? new Date();

  // ADR-022: if the JD carries a concrete seniority, its canonical
  // baseline (junior=1, semi_senior=2, senior=3, lead=5) becomes the
  // implicit piso for any requirement with `min_years: null`. When
  // the JD is silent on seniority (`unspecified`) the legacy binary
  // presence fallback stays in effect — no seniority signal, no
  // justified baseline.
  const seniorityBaseline = defaultMinYearsFor(jobQuery.seniority);

  const breakdown: RequirementBreakdown[] = jobQuery.requirements.map((req) => {
    const years =
      req.skill_id !== null
        ? yearsForSkill(req.skill_id, candidate.merged_experiences, { now })
        : 0;
    const effectiveMinYears = req.min_years ?? seniorityBaseline;
    let ratio: number;
    if (req.skill_id === null) {
      ratio = 0;
    } else if (effectiveMinYears === null || effectiveMinYears === 0) {
      // Binary presence fallback: either the JD has no seniority
      // signal (min_years explicitly null + seniority=unspecified)
      // or the JD explicitly set min_years=0.
      ratio = years > 0 ? 1 : 0;
    } else {
      ratio = Math.min(years / effectiveMinYears, 1);
    }
    const weight = req.must_have ? WEIGHT_MUST_HAVE : WEIGHT_NICE;
    const contribution = weight * ratio;
    const evidence =
      req.skill_id !== null ? collectEvidence(req.skill_id, candidate.merged_experiences) : [];
    return {
      requirement: req,
      candidate_years: years,
      years_ratio: ratio,
      contribution,
      status: statusFor(ratio),
      evidence,
    };
  });

  // ADR-021: collapse the breakdown into groups for the gate + score.
  // Singletons (alternative_group_id = null) become unique groups so
  // they behave exactly as before.
  interface ScoreGroup {
    entries: RequirementBreakdown[];
    must_have: boolean;
  }
  const groupsByKey = new Map<string, ScoreGroup>();
  let syntheticSingletonIdx = 0;
  for (const entry of breakdown) {
    const id = entry.requirement.alternative_group_id;
    const key = id === null ? `__singleton_${syntheticSingletonIdx++}` : `g:${id}`;
    const existing = groupsByKey.get(key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      groupsByKey.set(key, {
        entries: [entry],
        must_have: entry.requirement.must_have,
      });
    }
  }
  const groups = [...groupsByKey.values()];

  const gateFailed = groups.some((g) => {
    if (!g.must_have) return false;
    // A group with every alternative unresolved does NOT fail the
    // gate (ADR-015). Only groups with ≥1 resolved alternative are
    // held to the years_ratio check.
    const hasResolved = g.entries.some((b) => b.requirement.skill_id !== null);
    if (!hasResolved) return false;
    // Fail iff every resolved alternative has years_ratio === 0.
    const anySatisfied = g.entries.some(
      (b) => b.requirement.skill_id !== null && b.years_ratio > 0,
    );
    return !anySatisfied;
  });
  const must_have_gate: MustHaveGate = gateFailed ? 'failed' : 'passed';

  const langStats = computeLanguageMatch(jobQuery, candidate);
  const language_match = { required: langStats.required, matched: langStats.matched };
  const seniority_match = computeSeniorityMatch(jobQuery, candidate, now);

  if (must_have_gate === 'failed') {
    return {
      candidate_id: candidate.candidate_id,
      total_score: 0,
      must_have_gate,
      breakdown,
      language_match,
      seniority_match,
    };
  }

  let baseScore = 0;
  if (groups.length > 0) {
    let totalWeight = 0;
    let totalContribution = 0;
    for (const g of groups) {
      const groupWeight = g.must_have ? WEIGHT_MUST_HAVE : WEIGHT_NICE;
      // max contribution across alternatives in the group. Using
      // max (not sum) keeps the group's contribution bounded by the
      // group weight.
      let maxContribution = 0;
      for (const entry of g.entries) {
        if (entry.contribution > maxContribution) maxContribution = entry.contribution;
      }
      totalWeight += groupWeight;
      totalContribution += maxContribution;
    }
    baseScore = totalWeight > 0 ? (totalContribution / totalWeight) * 100 : 0;
  }

  let langDelta = 0;
  if (langStats.mustHaveMissing) {
    langDelta = -LANGUAGE_MUST_HAVE_PENALTY;
  } else if (langStats.required > 0 && langStats.matched === langStats.required) {
    langDelta = LANGUAGE_BONUS;
  }

  let senDelta = 0;
  if (seniority_match === 'match') senDelta = SENIORITY_MATCH_BONUS;
  else if (seniority_match === 'below') senDelta = -SENIORITY_BELOW_PENALTY;

  const total = Math.max(0, Math.min(100, baseScore + langDelta + senDelta));

  return {
    candidate_id: candidate.candidate_id,
    total_score: total,
    must_have_gate,
    breakdown,
    language_match,
    seniority_match,
  };
}
