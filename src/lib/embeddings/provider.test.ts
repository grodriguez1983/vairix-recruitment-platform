/**
 * Unit tests for the stub embedding provider.
 *
 * The stub exists so integration tests (worker against real
 * Supabase) don't need OpenAI credentials. It must:
 *   - Return a vector of the declared dimension.
 *   - Be deterministic per input so hash-based caching behaves.
 *   - Be distinguishable per input (different text ⇒ different vec).
 */
import { describe, expect, it } from 'vitest';

import { createStubProvider } from './stub-provider';

describe('createStubProvider', () => {
  it('returns the declared dimension', async () => {
    const p = createStubProvider({ dim: 1536 });
    const [vec] = await p.embed(['hello']);
    expect(vec).toHaveLength(1536);
  });

  it('is deterministic for the same input', async () => {
    const p = createStubProvider();
    const [a] = await p.embed(['same input']);
    const [b] = await p.embed(['same input']);
    expect(a).toEqual(b);
  });

  it('produces different vectors for different inputs', async () => {
    const p = createStubProvider();
    const [a] = await p.embed(['foo']);
    const [b] = await p.embed(['bar']);
    expect(a).not.toEqual(b);
  });

  it('handles batches: returns one vector per input, in order', async () => {
    const p = createStubProvider();
    const out = await p.embed(['a', 'b', 'c']);
    expect(out).toHaveLength(3);
    const solo = await p.embed(['b']);
    expect(out[1]).toEqual(solo[0]);
  });

  it('exposes model + dim metadata', () => {
    const p = createStubProvider({ model: 'stub-v1', dim: 8 });
    expect(p.model).toBe('stub-v1');
    expect(p.dim).toBe(8);
  });
});
