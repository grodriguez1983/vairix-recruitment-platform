/**
 * Content-hash helper for the job-query decomposition pipeline
 * (ADR-014 §1 / §4).
 *
 *   content_hash = SHA256(normalized_text || NUL || model || NUL ||
 *                         prompt_version)
 *
 * Same contract as `extractionContentHash` (ADR-012 §4). NUL separator
 * prevents boundary-shift collisions: ("ab","def","ghi") vs
 * ("abdef","","ghi") must not collide.
 *
 * The caller is expected to pass the POST-preprocess text so that two
 * submissions differing only in whitespace / HTML noise produce the
 * same hash (cache hit).
 */
import { createHash } from 'node:crypto';

export function decompositionContentHash(
  normalizedText: string,
  model: string,
  promptVersion: string,
): string {
  return createHash('sha256')
    .update(normalizedText)
    .update('\x00')
    .update(model)
    .update('\x00')
    .update(promptVersion)
    .digest('hex');
}
