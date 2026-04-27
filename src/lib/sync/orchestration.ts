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
export function parseBackfillArgs(argv: readonly string[]): { entity: string } {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith('--entity=')) {
      value = arg.slice('--entity='.length);
      break;
    }
    if (arg === '--entity') {
      value = argv[i + 1];
      break;
    }
  }
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
