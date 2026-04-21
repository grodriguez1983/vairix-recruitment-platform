/**
 * Content-hash helper for the CV extraction pipeline (ADR-012 §4).
 *
 *   content_hash = SHA256(parsed_text || NUL || model || NUL ||
 *                         prompt_version)
 *
 * The hash is the `UNIQUE` key of `candidate_extractions`. Changing
 * any of the three inputs produces a different hash automatically:
 *
 *   - Text change (re-parse produced new bytes) → re-extract.
 *   - Model bump (e.g. `gpt-4o-mini` → `gpt-4o`) → re-extract.
 *   - Prompt version bump (explicit PR, ADR-012 §5) → re-extract.
 *
 * A typo fix in the prompt body that does NOT bump `prompt_version`
 * is intentionally outside the hash domain (ADR-012 alternative F
 * was rejected for the same reason: we don't want every comment
 * rewrite to burn money).
 *
 * NUL separator prevents boundary-shift collisions: `("abc","def",
 * "ghi")` and `("abcdef","","ghi")` produce different hashes even
 * though their naive concatenations would collide.
 */
import { createHash } from 'node:crypto';

export function extractionContentHash(
  parsedText: string,
  model: string,
  promptVersion: string,
): string {
  return createHash('sha256')
    .update(parsedText)
    .update('\x00')
    .update(model)
    .update('\x00')
    .update(promptVersion)
    .digest('hex');
}
