/**
 * Error hierarchy for the sync layer.
 *
 * SyncError is the base; distinct subclasses let callers (and tests)
 * discriminate between "could not acquire lock" (expected / skip this
 * run), "the sync_state row doesn't exist" (configuration bug), and
 * generic sync failures (fatal). Each error carries a `context`
 * payload so log entries and `sync_errors` rows have enough info to
 * diagnose without reading back into code.
 */
export class SyncError extends Error {
  constructor(
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

/**
 * Thrown when another run currently holds the lock and its start
 * timestamp is within the stale timeout. The caller should abort
 * and let the next cron cycle retry.
 */
export class LockBusyError extends SyncError {
  constructor(
    public readonly entity: string,
    public readonly lastRunStartedAt: string,
    context?: Record<string, unknown>,
  ) {
    super(`lock for "${entity}" held since ${lastRunStartedAt}`, context);
    this.name = 'LockBusyError';
  }
}

/**
 * Thrown when the entity has no row in `sync_state`. This is a
 * configuration bug (the row is seeded by migration 008); failing
 * loudly surfaces it early.
 */
export class UnknownEntityError extends SyncError {
  constructor(entity: string) {
    super(`no sync_state row for entity "${entity}"`, { entity });
    this.name = 'UnknownEntityError';
  }
}
