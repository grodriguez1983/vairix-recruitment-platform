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
import type { DecompositionProvider } from './provider';
import type { DecompositionResult } from './types';

export interface StubDecompositionProviderOptions {
  model?: string;
  promptVersion?: string;
  fixture?: DecompositionResult;
}

export function createStubDecompositionProvider(
  _options: StubDecompositionProviderOptions = {},
): DecompositionProvider {
  // Intentional RED stub — tests drive the implementation.
  throw new Error('createStubDecompositionProvider: not implemented');
}
