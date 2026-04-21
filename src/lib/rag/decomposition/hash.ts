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
 */

// RED stub.
export function decompositionContentHash(
  _normalizedText: string,
  _model: string,
  _promptVersion: string,
): string {
  throw new Error('decompositionContentHash: not implemented');
}
