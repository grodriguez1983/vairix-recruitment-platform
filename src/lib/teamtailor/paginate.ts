/**
 * Generic JSON:API pagination iterator.
 *
 * Given a `fetchPage` function and a starting URL, walks `links.next`
 * until the server stops returning one, yielding each parsed resource
 * in order. The iterator does no HTTP itself — `fetchPage` is the
 * seam where the caller plugs in retry/rate-limit/auth. This keeps
 * paginate() trivially testable without MSW.
 *
 * Early termination (`break` in a `for-await-of`) is respected: no
 * further pages are fetched once the consumer stops iterating,
 * because we only fetch inside the `while` loop after a yield that
 * resumed successfully.
 */
import type { TTParsedDocument, TTParsedResource } from './types';

export type FetchPage<A> = (url: string) => Promise<TTParsedDocument<A>>;

export async function* paginate<A = Record<string, unknown>>(
  fetchPage: FetchPage<A>,
  initialUrl: string,
): AsyncIterable<TTParsedResource<A>> {
  let nextUrl: string | null = initialUrl;
  while (nextUrl !== null) {
    const doc = await fetchPage(nextUrl);
    for (const resource of doc.data) {
      yield resource;
    }
    nextUrl = doc.nextUrl;
  }
}
