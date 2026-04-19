/**
 * Parsers for search page `searchParams` (UC-01 / UC-02).
 *
 * Shared by `/search/semantic` (F3-002) and `/search/hybrid` (F3-003).
 * Deliberately permissive: invalid input returns `null` instead of
 * 400 so share-linked URLs don't break when a filter value gets
 * stale or someone edits the URL by hand. The UI treats `null` as
 * "no filter".
 */
import type { SearchFilters } from './types';

const APP_STATUSES: ReadonlySet<string> = new Set(['active', 'rejected', 'hired', 'withdrawn']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Max length of the free-text query; anything beyond is truncated. */
export const MAX_QUERY_LENGTH = 2000;

/**
 * Collapses Next's `string | string[] | undefined` to `string | undefined`.
 * When the same param is repeated (`?q=a&q=b`) Next gives an array;
 * we take the first value.
 */
export function firstOf(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Normalizes the free-text query: trims, clamps to `MAX_QUERY_LENGTH`,
 * returns `''` when absent. The empty string means "no query" —
 * callers branch on `q.length > 0`.
 */
export function parseQuery(raw: string | string[] | undefined): string {
  const first = firstOf(raw);
  if (!first) return '';
  return first.trim().slice(0, MAX_QUERY_LENGTH);
}

/** Returns the status if it's a known value, else null. */
export function parseStatus(raw: string | string[] | undefined): SearchFilters['status'] {
  const v = firstOf(raw);
  if (!v || !APP_STATUSES.has(v)) return null;
  return v as SearchFilters['status'];
}

/** Returns the UUID if syntactically valid, else null. */
export function parseUuid(raw: string | string[] | undefined): string | null {
  const v = firstOf(raw);
  if (!v || !UUID_REGEX.test(v)) return null;
  return v;
}

/**
 * Accepts `YYYY-MM-DD` from `<input type="date">` and lifts it to an
 * ISO timestamp at UTC midnight. Invalid / missing → null.
 */
export function parseDateInputToIso(raw: string | string[] | undefined): string | null {
  const v = firstOf(raw);
  if (!v || !DATE_REGEX.test(v)) return null;
  return `${v}T00:00:00Z`;
}
