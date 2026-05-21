/**
 * Stub for ADR-034 [RED] — GREEN will replace this with the real
 * POST /api/matching/run/start handler + Zod schema.
 *
 * The placeholder schema below is intentionally too permissive so
 * the type-side compiles but the runtime assertions in
 * `route.test.ts` fail (UUID format not enforced).
 */
import { z } from 'zod';

export const startMatchRequestSchema = z.object({
  job_query_id: z.string(),
});

export type StartMatchRequest = z.infer<typeof startMatchRequestSchema>;
