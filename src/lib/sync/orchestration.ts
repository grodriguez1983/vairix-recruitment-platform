/**
 * Orchestration helpers for `sync:full` and `sync:backfill` (ADR-028).
 *
 * These are pure (no I/O, no globals) so the script entrypoints can
 * remain thin: parse CLI → look up entities → call `runOne(entity)`
 * sequentially with fail-fast semantics.
 */

/**
 * Canonical FK-respecting order of entities. Anything earlier in the
 * list must not have a FK into anything later. The full sync
 * orchestrator iterates this list verbatim.
 *
 * Frozen at module load to defeat accidental `.push(...)` somewhere
 * in the codebase rotating the global order.
 */
export const CANONICAL_ENTITY_ORDER: readonly string[] = Object.freeze([
  'stages',
  'users',
  'jobs',
  'custom-fields',
  'candidates',
  'applications',
  'notes',
  'evaluations',
  'files',
] as const);

const KNOWN_ENTITIES: ReadonlySet<string> = new Set(CANONICAL_ENTITY_ORDER);

/**
 * Parses `--entity=<name>` (or `--entity <name>`) from a CLI argv.
 * Accepts the literal `all` to mean "every entity in canonical
 * order". Throws with an actionable message for missing/empty/unknown
 * values so the caller can exit with a usage error before touching
 * `sync_state`.
 */
export interface ParsedBackfillArgs {
  entity: string;
  /** Date-window backfill (ADR-028 addendum); both bounds required. */
  dateWindow?: { from: string; to: string };
  /** `--seal-cursor`: pin `sync_state.last_cursor` to `now()` without TT calls. */
  sealCursor?: true;
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  // Supports `--flag=value` and `--flag value`. Returns the literal
  // value (or '' if `--flag=` with no value). Returns undefined when
  // the flag isn't present at all.
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const prefix = `--${name}=`;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}`) return argv[i + 1] ?? '';
  }
  return undefined;
}

function hasBoolFlag(argv: readonly string[], name: string): boolean {
  return argv.some((a) => a === `--${name}`);
}

export function parseBackfillArgs(argv: readonly string[]): ParsedBackfillArgs {
  const value = readFlag(argv, 'entity');
  if (value === undefined) {
    throw new Error('missing required arg --entity=<name|all>');
  }
  if (value === '') {
    throw new Error('--entity value is empty');
  }
  if (value !== 'all' && !KNOWN_ENTITIES.has(value)) {
    throw new Error(
      `unknown entity "${value}" — expected one of: ${[...CANONICAL_ENTITY_ORDER, 'all'].join(', ')}`,
    );
  }

  const from = readFlag(argv, 'from');
  const to = readFlag(argv, 'to');
  const sealCursor = hasBoolFlag(argv, 'seal-cursor');

  if ((from !== undefined) !== (to !== undefined)) {
    throw new Error('--from and --to must be provided together (date-window backfill)');
  }

  if (sealCursor && from !== undefined) {
    throw new Error('--seal-cursor is incompatible with --from/--to (use one or the other)');
  }
  if (sealCursor && value === 'all') {
    throw new Error('--seal-cursor cannot be combined with --entity=all (seal per-entity only)');
  }

  if (from !== undefined && to !== undefined) {
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    if (Number.isNaN(fromMs)) {
      throw new Error(`invalid --from "${from}" — expected an ISO-8601 date or timestamp`);
    }
    if (Number.isNaN(toMs)) {
      throw new Error(`invalid --to "${to}" — expected an ISO-8601 date or timestamp`);
    }
    if (fromMs > toMs) {
      throw new Error(`--from "${from}" must be before --to "${to}"`);
    }
    return { entity: value, dateWindow: { from, to } };
  }

  if (sealCursor) {
    return { entity: value, sealCursor: true };
  }

  return { entity: value };
}

export interface OrchestrationResult {
  entity: string;
  recordsSynced: number;
}

export interface OrchestrationOutcome {
  results: OrchestrationResult[];
}

/**
 * Iterates `entities` in order, awaiting `runOne(entity)` for each.
 * Fail-fast: the first thrown error stops iteration; remaining
 * entities are NOT attempted. The thrown error is wrapped so the
 * failing entity is named in its message.
 */
export async function runOrchestration(input: {
  entities: readonly string[];
  runOne: (entity: string) => Promise<OrchestrationResult>;
}): Promise<OrchestrationOutcome> {
  const results: OrchestrationResult[] = [];
  for (const entity of input.entities) {
    try {
      const r = await input.runOne(entity);
      results.push(r);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`orchestration failed at "${entity}": ${message}`, {
        cause: e instanceof Error ? e : undefined,
      });
    }
  }
  return { results };
}
