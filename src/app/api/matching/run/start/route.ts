/**
 * POST /api/matching/run/start — ADR-034 §1, first endpoint of the
 * FE-driven chunked matching pipeline.
 *
 * This module currently exports only the request schema. The route
 * handler is wired in a subsequent GREEN cycle once the
 * `startMatchJob` service exists (loadJobQuery + createMatchRun +
 * preFilter + stamp expected_count).
 *
 * Contract:
 *   - Body: `{ job_query_id: uuid }`
 *   - `top_n` is intentionally NOT accepted here — it belongs to
 *     /finalize, which is the endpoint that returns the final
 *     top-N slice to the FE. Keeping each endpoint's input minimal
 *     avoids parameter drift between sibling routes.
 *   - Unknown top-level keys are stripped, not errored, matching
 *     the posture of `runMatchRequestSchema` in the legacy
 *     /api/matching/run.
 */
import { z } from 'zod';

export const startMatchRequestSchema = z
  .object({
    job_query_id: z.string().uuid(),
  })
  .strip();

export type StartMatchRequest = z.infer<typeof startMatchRequestSchema>;
