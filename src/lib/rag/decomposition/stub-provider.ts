/**
 * Deterministic stub `DecompositionProvider` (ADR-014 §3).
 *
 * Mirrors `createStubExtractionProvider` (ADR-012 §3). Integration
 * tests use it to exercise the decompose service end-to-end against
 * Supabase without burning OpenAI tokens or needing an API key.
 *
 * Invariants (matched by stub-provider.test.ts):
 *   - Same rawText ⇒ same DecompositionResult (content_hash
 *     idempotency tests are reproducible).
 *   - Different rawText ⇒ different result (no cross-test collisions).
 *   - Injected `fixture` short-circuits the deterministic branch.
 *
 * The stub does NOT implement real decomposition. The one synthetic
 * requirement is keyed by SHA-256 of input so the output shape is
 * schema-valid but the content is meaningless. Never use for
 * behavior that depends on decomposition semantics.
 */
import { createHash } from 'node:crypto';

import type { DecompositionProvider } from './provider';
import type { DecompositionResult } from './types';

export interface StubDecompositionProviderOptions {
  model?: string;
  promptVersion?: string;
  fixture?: DecompositionResult;
}

function deterministicResult(rawText: string): DecompositionResult {
  const hash = createHash('sha256').update(rawText).digest('hex');
  // Use a portable prefix of the input as the evidence_snippet so the
  // schema's "must be a literal substring" contract stays true even
  // for the stub. Falls back to the input itself when shorter than 8
  // chars. An input the test suite reliably provides is non-empty; an
  // empty string would violate schema invariants and the stub is not
  // intended for that path (the service rejects empty input upstream).
  const snippet = rawText.length >= 8 ? rawText.slice(0, 8) : rawText;
  return {
    requirements: [
      {
        skill_raw: `stub-skill-${hash.slice(0, 8)}`,
        min_years: null,
        max_years: null,
        must_have: true,
        evidence_snippet: snippet,
        category: 'technical',
      },
    ],
    seniority: 'unspecified',
    languages: [],
    notes: null,
  };
}

export function createStubDecompositionProvider(
  options: StubDecompositionProviderOptions = {},
): DecompositionProvider {
  const model = options.model ?? 'stub-decomp-v1';
  const promptVersion = options.promptVersion ?? 'stub-decomp-prompt-v1';
  const fixture = options.fixture;

  return {
    model,
    promptVersion,
    decompose(rawText: string): Promise<DecompositionResult> {
      if (fixture !== undefined) return Promise.resolve(fixture);
      return Promise.resolve(deterministicResult(rawText));
    },
  };
}
