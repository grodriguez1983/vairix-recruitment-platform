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
 * Gate rule (tests + ADR §3.1): a must-have requirement with a
 * resolved `skill_id` fails the gate when its `years_ratio === 0`.
 * Unresolved (`skill_id = null`) must-haves do NOT fail the gate —
 * catalog drift should not silently hide candidates (ADR §Consecuencias).
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

  const breakdown: RequirementBreakdown[] = jobQuery.requirements.map((req) => {
    const years =
      req.skill_id !== null
        ? yearsForSkill(req.skill_id, candidate.merged_experiences, { now })
        : 0;
    let ratio: number;
    if (req.skill_id === null) {
      ratio = 0;
    } else if (req.min_years === null) {
      ratio = years > 0 ? 1 : 0;
    } else if (req.min_years === 0) {
      ratio = years > 0 ? 1 : 0;
    } else {
      ratio = Math.min(years / req.min_years, 1);
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

  const gateFailed = breakdown.some(
    (b) => b.requirement.must_have && b.requirement.skill_id !== null && b.years_ratio === 0,
  );
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
  if (breakdown.length > 0) {
    const totalWeight = breakdown.reduce(
      (sum, b) => sum + (b.requirement.must_have ? WEIGHT_MUST_HAVE : WEIGHT_NICE),
      0,
    );
    const totalContribution = breakdown.reduce((sum, b) => sum + b.contribution, 0);
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
