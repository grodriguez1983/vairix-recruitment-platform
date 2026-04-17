/**
 * Generic JSON:API pagination iterator.
 *
 * Stub — implementación en [GREEN] siguiente.
 */
import type { TTParsedDocument, TTParsedResource } from './types';

export type FetchPage<A> = (url: string) => Promise<TTParsedDocument<A>>;

export async function* paginate<A = Record<string, unknown>>(
  _fetchPage: FetchPage<A>,
  _initialUrl: string,
): AsyncIterable<TTParsedResource<A>> {
  void _fetchPage;
  void _initialUrl;
  // Yield is required so TS infers AsyncIterable properly; the throw
  // below ensures callers see a clear "not implemented" error.
  if (false as boolean) yield undefined as unknown as TTParsedResource<A>;
  throw new Error('paginate: not implemented');
}
