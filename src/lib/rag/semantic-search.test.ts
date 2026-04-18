/**
 * Unit tests for the deduplication helper.
 *
 * `dedupeByCandidate` collapses multiple hits per candidate into
 * a single "best match" row. Keeps the source ordering stable so
 * UI layers can show which source types matched.
 */
import { describe, expect, it } from 'vitest';

import { dedupeByCandidate, type SemanticSearchHit } from './semantic-search';

describe('dedupeByCandidate', () => {
  it('returns [] for empty input', () => {
    expect(dedupeByCandidate([])).toEqual([]);
  });

  it('keeps the highest score per candidate', () => {
    const hits: SemanticSearchHit[] = [
      { candidateId: 'c1', sourceType: 'profile', score: 0.6 },
      { candidateId: 'c1', sourceType: 'notes', score: 0.9 },
      { candidateId: 'c2', sourceType: 'profile', score: 0.75 },
    ];
    const out = dedupeByCandidate(hits);
    const c1 = out.find((m) => m.candidateId === 'c1');
    const c2 = out.find((m) => m.candidateId === 'c2');
    expect(c1?.bestScore).toBe(0.9);
    expect(c2?.bestScore).toBe(0.75);
  });

  it('collects all matched source types per candidate', () => {
    const hits: SemanticSearchHit[] = [
      { candidateId: 'c1', sourceType: 'profile', score: 0.6 },
      { candidateId: 'c1', sourceType: 'notes', score: 0.9 },
    ];
    const out = dedupeByCandidate(hits);
    expect(out[0]?.matchedSources).toEqual(expect.arrayContaining(['profile', 'notes']));
    expect(out[0]?.matchedSources).toHaveLength(2);
  });

  it('orders results by best score descending', () => {
    const hits: SemanticSearchHit[] = [
      { candidateId: 'a', sourceType: 'profile', score: 0.3 },
      { candidateId: 'b', sourceType: 'profile', score: 0.8 },
      { candidateId: 'c', sourceType: 'profile', score: 0.5 },
    ];
    const out = dedupeByCandidate(hits);
    expect(out.map((m) => m.candidateId)).toEqual(['b', 'c', 'a']);
  });

  it('is deterministic: same input ⇒ same output', () => {
    const hits: SemanticSearchHit[] = [
      { candidateId: 'x', sourceType: 'notes', score: 0.5 },
      { candidateId: 'y', sourceType: 'profile', score: 0.5 },
    ];
    expect(dedupeByCandidate(hits)).toEqual(dedupeByCandidate([...hits]));
  });
});
