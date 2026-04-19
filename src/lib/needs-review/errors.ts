/**
 * Domain errors for the admin needs-review panel (F2-004).
 */
export class NeedsReviewAdminError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'already_cleared' | 'invalid_category' | 'db_error',
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'NeedsReviewAdminError';
  }
}
