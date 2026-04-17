// Stub — implementación en [GREEN] siguiente.
export class TeamtailorError extends Error {
  constructor(
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TeamtailorError';
  }
}
export class HttpError extends TeamtailorError {
  constructor(
    public readonly status: number,
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message, context);
    this.name = 'HttpError';
  }
}
export class RateLimitError extends TeamtailorError {
  constructor(
    public readonly retryAfterMs: number,
    context?: Record<string, unknown>,
  ) {
    super(`rate limited; retry after ${retryAfterMs}ms`, context);
    this.name = 'RateLimitError';
  }
}
export class ParseError extends TeamtailorError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, context);
    this.name = 'ParseError';
  }
}
