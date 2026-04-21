/**
 * Deterministic stub `ExtractionProvider` (ADR-012 §3).
 *
 * Mirrors `createStubProvider` in `src/lib/embeddings/stub-provider.ts`.
 * Integration tests use it to exercise the worker end-to-end against
 * a real Supabase without burning OpenAI tokens or needing an API
 * key. Two properties we rely on:
 *
 *   - Same parsedText ⇒ same `ExtractionResult` (so `content_hash`
 *     idempotency tests are reproducible).
 *   - Different parsedText ⇒ different result (so the test suite can
 *     seed distinct rows without collisions).
 *
 * A test can inject `fixture` to force an exact shape — useful when
 * asserting on downstream derivation (F4-005) that expects specific
 * experience/skill tuples.
 *
 * The stub does NOT implement any real extraction. The experiences
 * list is a single synthetic row keyed by the input's SHA-256, so the
 * shape is Zod-valid but the content is meaningless. Never use for
 * behavior that depends on extraction semantics.
 */
import { createHash } from 'node:crypto';

import type { ExtractionProvider } from './provider';
import type { ExtractionResult } from './types';

export interface StubExtractionProviderOptions {
  model?: string;
  promptVersion?: string;
  fixture?: ExtractionResult;
}

function deterministicResult(parsedText: string): ExtractionResult {
  const hash = createHash('sha256').update(parsedText).digest('hex');
  return {
    source_variant: 'cv_primary',
    experiences: [
      {
        kind: 'work',
        company: `stub-co-${hash.slice(0, 8)}`,
        title: 'Stub Engineer',
        start_date: '2020-01',
        end_date: null,
        description: null,
        skills: [`stub-skill-${hash.slice(8, 16)}`],
      },
    ],
    languages: [],
  };
}

export function createStubExtractionProvider(
  options: StubExtractionProviderOptions = {},
): ExtractionProvider {
  const model = options.model ?? 'stub-v1';
  const promptVersion = options.promptVersion ?? 'stub-prompt-v1';
  const fixture = options.fixture;

  return {
    model,
    promptVersion,
    extract(parsedText: string): Promise<ExtractionResult> {
      if (fixture !== undefined) return Promise.resolve(fixture);
      return Promise.resolve(deterministicResult(parsedText));
    },
  };
}
