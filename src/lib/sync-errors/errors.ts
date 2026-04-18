/**
 * Domain errors for the admin sync-errors panel (F2-004).
 */
export class SyncErrorAdminError extends Error {
  constructor(
    message: string,
    public readonly code: 'not_found' | 'already_resolved' | 'db_error',
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SyncErrorAdminError';
  }
}
