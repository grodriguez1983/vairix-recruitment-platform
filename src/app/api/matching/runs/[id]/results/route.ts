/**
 * GET /api/matching/runs/:id/results?offset=&limit= — F4-008 sub-D
 * (RED stub). Returns the paginated, breakdown-included results
 * ordered by rank asc. Auth + RLS enforce tenant scoping.
 *
 * GREEN wires the handler + schema constraints.
 */
import { z } from 'zod';

// RED stub: intentionally permissive.
export const resultsQuerySchema = z.unknown();

export type ResultsQuery = unknown;
