/**
 * Unit tests for `extractionContentHash` (ADR-012 §4).
 *
 * The hash is the idempotency key for `candidate_extractions`:
 *   SHA256(parsed_text || NUL || model || NUL || prompt_version)
 *
 * Two properties we must preserve:
 *
 *   1. Changing ANY of the three inputs produces a different hash.
 *      This is what makes model bump / prompt-version bump / text
 *      change automatically invalidate the cache.
 *   2. Boundaries are unambiguous: concatenating "a","b","c" must
 *      not collide with "ab","","c". That's why we use NUL (\x00)
 *      as a separator — a CV with a literal NUL would still be
 *      distinguishable by the count and position of separators.
 */
import { describe, expect, it } from 'vitest';

import { extractionContentHash } from './hash';

describe('extractionContentHash — ADR-012 §4 idempotency key', () => {
  it('returns a 64-char hex string (sha-256)', () => {
    const h = extractionContentHash('some text', 'gpt-4o-mini', '2026-04-v1');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs produce same hash', () => {
    const a = extractionContentHash('some text', 'gpt-4o-mini', '2026-04-v1');
    const b = extractionContentHash('some text', 'gpt-4o-mini', '2026-04-v1');
    expect(a).toBe(b);
  });

  it('changes when parsed_text changes', () => {
    const a = extractionContentHash('text one', 'gpt-4o-mini', '2026-04-v1');
    const b = extractionContentHash('text two', 'gpt-4o-mini', '2026-04-v1');
    expect(a).not.toBe(b);
  });

  it('changes when model changes', () => {
    const a = extractionContentHash('same', 'gpt-4o-mini', '2026-04-v1');
    const b = extractionContentHash('same', 'gpt-4o', '2026-04-v1');
    expect(a).not.toBe(b);
  });

  it('changes when prompt_version changes', () => {
    const a = extractionContentHash('same', 'gpt-4o-mini', '2026-04-v1');
    const b = extractionContentHash('same', 'gpt-4o-mini', '2026-05-v2');
    expect(a).not.toBe(b);
  });

  it('does not collide across boundary shifts (NUL-separated)', () => {
    // "abc" || NUL || "def" || NUL || "ghi"  vs
    // "abcdef" || NUL || "" || NUL || "ghi"
    // Without NUL separation these would collide after naive concat.
    const a = extractionContentHash('abc', 'def', 'ghi');
    const b = extractionContentHash('abcdef', '', 'ghi');
    expect(a).not.toBe(b);
  });
});
