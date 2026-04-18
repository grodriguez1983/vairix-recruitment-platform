/**
 * Generic JSON:API pagination iterator that preserves `included`.
 *
 * Variant of `paginate()` for syncers that need sideloaded resources
 * (see ADR-010 §2). Instead of yielding bare resources, yields
 * `{ resource, included }` for every primary resource, where
 * `included` is the array of sideloaded recursos from the same page
 * (repeated across every yield of that page).
 *
 * Semantics identical to `paginate()`:
 *   - follows `links.next` until null.
 *   - `break` in the consumer stops further fetching.
 *   - errors from `fetchPage` propagate.
 *
 * Normalization: `doc.included` may be omitted by TT when the page
 * has no sideloads; we normalize to [] so consumers don't need to
 * null-check.
 */
import type { FetchPage } from './paginate';
import type { TTParsedResource } from './types';

export interface PrimaryWithIncluded<A = Record<string, unknown>> {
  resource: TTParsedResource<A>;
  included: TTParsedResource[];
}

export async function* paginateWithIncluded<A = Record<string, unknown>>(
  fetchPage: FetchPage<A>,
  initialUrl: string,
): AsyncIterable<PrimaryWithIncluded<A>> {
  let nextUrl: string | null = initialUrl;
  while (nextUrl !== null) {
    const doc = await fetchPage(nextUrl);
    const included = doc.included ?? [];
    for (const resource of doc.data) {
      yield { resource, included };
    }
    nextUrl = doc.nextUrl;
  }
}
