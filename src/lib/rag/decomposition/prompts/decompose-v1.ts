/**
 * Decomposition prompt v1 (ADR-014 §3).
 *
 * The prompt body and version tag are exported together so that the
 * provider can report `promptVersion` and the test suite can pin the
 * version string.
 *
 * IMPORTANT: bumping `DECOMPOSITION_PROMPT_V1` invalidates every
 * `job_queries.content_hash` and forces a re-decompose of every job
 * query (ADR-014 §5). Only bump the version in a conscious PR — typo
 * fixes with no semantic change go under the same version.
 */

// RED stub — GREEN will pin + supply body.
export const DECOMPOSITION_PROMPT_V1 = 'UNPINNED';
export const DECOMPOSITION_PROMPT_V1_TEXT = '';
