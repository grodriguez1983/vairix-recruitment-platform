/**
 * DeterministicRanker (ADR-015, F4-007 sub-D).
 *
 * Pure orchestrator: scores every candidate with `aggregateScore`
 * (using `catalogSnapshotAt` as the temporal anchor) and emits the
 * results sorted by (total_score desc, candidate_id asc). No side
 * effects, no I/O — persistence lives one layer above in
 * `match_runs` / `match_results` per ADR-015 §5.
 *
 * Determinism contract (ADR test 21): same `RankerInput` ⇒ same
 * `RankResult` bit-for-bit. Diagnostics is currently an empty array;
 * downstream sub-blocks will wire in variant-merge diagnostics and
 * fallback/FTS signals (ADR-016).
 */
import { aggregateScore } from './score-aggregator';
import type { Ranker, RankResult, RankerInput } from './types';

function compareCandidates(
  a: { total_score: number; candidate_id: string },
  b: { total_score: number; candidate_id: string },
): number {
  if (a.total_score !== b.total_score) return b.total_score - a.total_score;
  return a.candidate_id.localeCompare(b.candidate_id);
}

export class DeterministicRanker implements Ranker {
  async rank(input: RankerInput): Promise<RankResult> {
    const { jobQuery, candidates, catalogSnapshotAt } = input;

    const results = candidates
      .map((candidate) => aggregateScore(jobQuery, candidate, { now: catalogSnapshotAt }))
      .sort(compareCandidates);

    return { results, diagnostics: [] };
  }
}
