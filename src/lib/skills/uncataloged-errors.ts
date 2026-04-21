/**
 * Domain errors for the admin uncataloged-skills panel (ADR-013 §5).
 */
export class UncatalogedAdminError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'invalid_slug'
      | 'invalid_name'
      | 'invalid_alias'
      | 'slug_conflict'
      | 'alias_conflict'
      | 'db_error'
      | 'reconcile_failed',
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'UncatalogedAdminError';
  }
}
