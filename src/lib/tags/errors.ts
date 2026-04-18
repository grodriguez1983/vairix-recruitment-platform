/**
 * Domain errors for tag operations.
 *
 * These are surface-level errors meant to be caught by server actions
 * and mapped to user-visible feedback. They carry structured context
 * so logs / UI can render them without string parsing.
 */
export class TagError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid_name'
      | 'not_found'
      | 'forbidden'
      | 'db_error'
      | 'app_user_not_found',
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'TagError';
  }
}
