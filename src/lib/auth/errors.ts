/**
 * Auth-specific errors. Kept distinct from generic errors so route
 * handlers and error boundaries can recognize them and produce the
 * right HTTP status / redirect.
 */

export class UnauthenticatedError extends Error {
  public override readonly name = 'UnauthenticatedError';
  constructor(message = 'Authentication required') {
    super(message);
  }
}

export class ForbiddenError extends Error {
  public override readonly name = 'ForbiddenError';
  constructor(
    public readonly requiredRole: string,
    public readonly actualRole: string | null,
  ) {
    super(`Forbidden: required role "${requiredRole}", current role "${actualRole ?? 'none'}".`);
  }
}
