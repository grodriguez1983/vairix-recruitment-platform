/**
 * Embedding provider interface (ADR-005).
 *
 * `embed(texts)` returns one vector per input in the same order.
 * `model` is the identifier that goes into `embeddings.model` +
 * the content-hash domain (so changing models invalidates cache).
 * `dim` is the vector dimension — must match the `vector(N)` column.
 */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}
