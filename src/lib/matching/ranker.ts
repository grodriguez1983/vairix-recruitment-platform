/**
 * DeterministicRanker placeholder (ADR-015, F4-007 sub-D).
 *
 * RED phase — throws. GREEN implementation lands in the next commit.
 */
import type { Ranker, RankResult, RankerInput } from './types';

export class DeterministicRanker implements Ranker {
  async rank(_input: RankerInput): Promise<RankResult> {
    throw new Error('not implemented');
  }
}
