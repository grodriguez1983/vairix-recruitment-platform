/**
 * OpenAI `DecompositionProvider` (ADR-014 §3).
 *
 * Mirror of `createOpenAiExtractionProvider` (ADR-012 §3). Single
 * file boundary for the external dependency; swapping providers
 * means a new implementation of `DecompositionProvider` and nothing
 * else changes.
 *
 * Flow:
 *   - POST `/v1/chat/completions` with system prompt + user raw_text.
 *   - `response_format: { type: 'json_schema' }` forces the shape
 *     server-side, and we re-validate via Zod locally.
 *   - Failures raise; the service maps them to `DecompositionError`.
 *
 * `fetchImpl` is injected for unit tests; default is global `fetch`.
 */
import type { DecompositionProvider } from '../provider';

export interface OpenAiDecompositionProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createOpenAiDecompositionProvider(
  _options: OpenAiDecompositionProviderOptions,
): DecompositionProvider {
  // Intentional RED stub — tests drive the implementation.
  throw new Error('createOpenAiDecompositionProvider: not implemented');
}
