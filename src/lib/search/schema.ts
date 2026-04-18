/**
 * Zod validation for the `/api/search` request body.
 *
 * The schema normalizes raw user input into `SearchFilters`. Empty
 * strings become null so the search logic has a single "no filter"
 * signal. Page/pageSize are clamped to reasonable bounds to avoid
 * accidental full-table scans over PostgREST.
 */
import { z } from 'zod';

import type { SearchFilters } from './types';

const APPLICATION_STATUS = ['active', 'rejected', 'hired', 'withdrawn'] as const;

function emptyToNull(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

const nullableString = z.preprocess(emptyToNull, z.string().nullable().default(null));
const nullableIsoDate = z.preprocess(
  emptyToNull,
  z.string().datetime({ offset: true }).nullable().default(null),
);
const nullableUuid = z.preprocess(emptyToNull, z.string().uuid().nullable().default(null));
const nullableStatus = z.preprocess(
  emptyToNull,
  z.enum(APPLICATION_STATUS).nullable().default(null),
);

export const searchRequestSchema = z.object({
  q: nullableString,
  status: nullableStatus,
  rejected_after: nullableIsoDate,
  rejected_before: nullableIsoDate,
  job_id: nullableUuid,
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;

export function requestToFilters(req: SearchRequest): SearchFilters {
  return {
    q: req.q,
    status: req.status,
    rejectedAfter: req.rejected_after,
    rejectedBefore: req.rejected_before,
    jobId: req.job_id,
    page: req.page,
    pageSize: req.pageSize,
  };
}
