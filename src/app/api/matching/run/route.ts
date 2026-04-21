/**
 * POST /api/matching/run — F4-008 sub-D (RED stub).
 *
 * Full wiring (auth, service call, route handler) lands in GREEN.
 * The schema here is intentionally loose so the test suite can
 * drive the real constraints.
 */
import { z } from 'zod';

// RED: schema intentionally permissive; GREEN tightens constraints.
export const runMatchRequestSchema = z.object({
  job_query_id: z.string(),
  top_n: z.number().optional(),
});

export type RunMatchRequest = z.infer<typeof runMatchRequestSchema>;
