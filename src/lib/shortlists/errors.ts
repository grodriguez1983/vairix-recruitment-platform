/**
 * Domain errors for shortlist operations.
 */
export class ShortlistError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid_name'
      | 'not_found'
      | 'already_archived'
      | 'already_in_shortlist'
      | 'not_in_shortlist'
      | 'db_error'
      | 'app_user_not_found',
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ShortlistError';
  }
}
