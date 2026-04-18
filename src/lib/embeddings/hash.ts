/**
 * Content-hash helper for the embeddings pipeline (ADR-005 §Detección
 * de cambios).
 *
 * The hash is the cache key for an `embeddings` row: if the hash of
 * (model, current content) matches the stored hash, no regeneration
 * is needed. Including the model name in the hash domain forces
 * regeneration when we switch models, without needing a separate
 * invalidation flag.
 *
 * We use a zero-byte separator between model and content so crafted
 * inputs can't produce a collision by shifting boundaries.
 */
import { createHash } from 'node:crypto';

export function contentHash(model: string, content: string): string {
  return createHash('sha256').update(model).update('\x00').update(content).digest('hex');
}
