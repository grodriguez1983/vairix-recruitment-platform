/**
 * Score aggregator placeholder (ADR-015 §3, F4-007 sub-C).
 *
 * RED phase — throws. GREEN implementation lands in the next commit.
 */
import type { ResolvedDecomposition } from '../rag/decomposition/resolve-requirements';
import type { CandidateAggregate, CandidateScore } from './types';

export interface AggregateScoreOptions {
  now?: Date;
}

export function aggregateScore(
  _jobQuery: ResolvedDecomposition,
  _candidate: CandidateAggregate,
  _options: AggregateScoreOptions = {},
): CandidateScore {
  throw new Error('not implemented');
}
