/**
 * Unit tests for the content-hash helper.
 *
 * The hash is the cache key for embeddings: two inputs are
 * considered "same" iff their hash matches. It must be:
 *   - Deterministic (same input ⇒ same output)
 *   - Model-scoped (changing model name ⇒ new hash, forces regen)
 *   - Stable across process restarts (no randomness)
 */
import { describe, expect, it } from 'vitest';

import { contentHash } from './hash';

describe('contentHash', () => {
  it('is deterministic for the same (model, content) pair', () => {
    const a = contentHash('text-embedding-3-small', 'hello world');
    const b = contentHash('text-embedding-3-small', 'hello world');
    expect(a).toBe(b);
  });

  it('differs when model changes', () => {
    const a = contentHash('text-embedding-3-small', 'same text');
    const b = contentHash('text-embedding-3-large', 'same text');
    expect(a).not.toBe(b);
  });

  it('differs when content changes', () => {
    const a = contentHash('m', 'foo');
    const b = contentHash('m', 'foo ');
    expect(a).not.toBe(b);
  });

  it('returns hex strings of 64 chars (sha-256)', () => {
    const h = contentHash('m', 'x');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles empty content without throwing', () => {
    const h = contentHash('m', '');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
