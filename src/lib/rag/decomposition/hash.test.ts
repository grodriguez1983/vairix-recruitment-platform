/**
 * Unit tests for `decompositionContentHash` (ADR-014 §1 / §4).
 *
 *   content_hash = SHA256(normalized_text || NUL || model || NUL ||
 *                         prompt_version)
 *
 * The hash is the `UNIQUE` key of `job_queries`. Identical invariants
 * as the CV extraction hash (ADR-012 §4): any change in the three
 * inputs yields a different hash; NUL separators prevent
 * boundary-shift collisions.
 */
import { describe, expect, it } from 'vitest';

import { decompositionContentHash } from './hash';

describe('decompositionContentHash', () => {
  it('returns a 64-char lowercase hex SHA-256', () => {
    const h = decompositionContentHash('some text', 'gpt-4o-mini', '2026-04-v1');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs', () => {
    const a = decompositionContentHash('same', 'gpt-4o-mini', '2026-04-v1');
    const b = decompositionContentHash('same', 'gpt-4o-mini', '2026-04-v1');
    expect(a).toBe(b);
  });

  it('differs when normalized_text changes', () => {
    const a = decompositionContentHash('text a', 'gpt-4o-mini', '2026-04-v1');
    const b = decompositionContentHash('text b', 'gpt-4o-mini', '2026-04-v1');
    expect(a).not.toBe(b);
  });

  it('differs when model changes', () => {
    const a = decompositionContentHash('text', 'gpt-4o-mini', '2026-04-v1');
    const b = decompositionContentHash('text', 'gpt-4o', '2026-04-v1');
    expect(a).not.toBe(b);
  });

  it('differs when prompt_version changes', () => {
    const a = decompositionContentHash('text', 'gpt-4o-mini', '2026-04-v1');
    const b = decompositionContentHash('text', 'gpt-4o-mini', '2026-05-v1');
    expect(a).not.toBe(b);
  });

  it('prevents boundary-shift collisions via NUL separators', () => {
    // Without NUL separators these would collide (concat = "abdefghi"
    // for both). With NUL separators they must not.
    const a = decompositionContentHash('ab', 'def', 'ghi');
    const b = decompositionContentHash('abdef', '', 'ghi');
    expect(a).not.toBe(b);
  });
});
