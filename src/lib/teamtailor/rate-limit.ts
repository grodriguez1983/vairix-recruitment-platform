// Stub — implementación en [GREEN]. Las firmas deben compilar para
// que los tests [RED] carguen; los cuerpos hacen throw intencional.
export interface TokenBucketOptions {
  tokensPerSecond: number;
  burst: number;
  now?: () => number;
}
export class TokenBucket {
  constructor(_opts: TokenBucketOptions) {
    throw new Error('not implemented');
  }
  pendingWaitMs(): number {
    throw new Error('not implemented');
  }
  take(): void {
    throw new Error('not implemented');
  }
}
