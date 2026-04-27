/**
 * Adversarial tests for the sync orchestration helpers (ADR-028).
 *
 * The helpers are the testable surface of `sync-full` / `backfill`
 * scripts: canonical entity order, CLI arg parsing, and the
 * fail-fast iterator that runs one entity after another.
 */
import { describe, expect, it } from 'vitest';

import { CANONICAL_ENTITY_ORDER, parseBackfillArgs, runOrchestration } from './orchestration';

describe('CANONICAL_ENTITY_ORDER', () => {
  it('test_lists_all_nine_entities_in_fk_order', () => {
    // Order is load-bearing: anything earlier than `candidates` must
    // not have an FK into candidates; anything earlier than
    // `applications` must not FK into applications. Locking the
    // expected sequence lets a future schema change surface here.
    expect(CANONICAL_ENTITY_ORDER).toEqual([
      'stages',
      'users',
      'jobs',
      'custom-fields',
      'candidates',
      'applications',
      'notes',
      'evaluations',
      'files',
    ]);
  });

  it('test_is_readonly_at_runtime_to_prevent_accidental_mutation', () => {
    // Frozen array — protects against `CANONICAL_ENTITY_ORDER.push(...)`
    // somewhere injecting an entity into the global order.
    expect(Object.isFrozen(CANONICAL_ENTITY_ORDER)).toBe(true);
  });
});

describe('parseBackfillArgs', () => {
  it('test_accepts_single_known_entity', () => {
    expect(parseBackfillArgs(['--entity=candidates'])).toEqual({
      entity: 'candidates',
    });
  });

  it('test_accepts_all_keyword', () => {
    expect(parseBackfillArgs(['--entity=all'])).toEqual({ entity: 'all' });
  });

  it('test_accepts_space_separated_form', () => {
    expect(parseBackfillArgs(['--entity', 'jobs'])).toEqual({ entity: 'jobs' });
  });

  it('test_throws_when_entity_flag_missing', () => {
    expect(() => parseBackfillArgs([])).toThrow(/--entity/);
  });

  it('test_throws_when_entity_value_missing', () => {
    expect(() => parseBackfillArgs(['--entity='])).toThrow(/empty/);
  });

  it('test_throws_when_entity_unknown', () => {
    // Reject typos early to avoid wiping the wrong sync_state row.
    expect(() => parseBackfillArgs(['--entity=candidate'])).toThrow(/unknown entity.*candidate/i);
  });

  it('test_ignores_unrelated_args_before_entity_flag', () => {
    // The CLI may receive node/script tokens prepended; the parser
    // should tolerate noise as long as `--entity=X` is present.
    expect(parseBackfillArgs(['--verbose', '--entity=stages'])).toEqual({
      entity: 'stages',
    });
  });
});

describe('runOrchestration', () => {
  it('test_runs_entities_in_provided_order', async () => {
    const seen: string[] = [];
    const result = await runOrchestration({
      entities: ['stages', 'users', 'jobs'],
      runOne: async (entity) => {
        seen.push(entity);
        return { entity, recordsSynced: 0 };
      },
    });
    expect(seen).toEqual(['stages', 'users', 'jobs']);
    expect(result.results.map((r) => r.entity)).toEqual(['stages', 'users', 'jobs']);
  });

  it('test_fails_fast_on_first_error_and_does_not_run_remaining', async () => {
    const seen: string[] = [];
    await expect(
      runOrchestration({
        entities: ['stages', 'users', 'jobs'],
        runOne: async (entity) => {
          seen.push(entity);
          if (entity === 'users') throw new Error('boom');
          return { entity, recordsSynced: 0 };
        },
      }),
    ).rejects.toThrow(/users.*boom/);
    // jobs MUST NOT have been attempted after users failed.
    expect(seen).toEqual(['stages', 'users']);
  });

  it('test_returns_recordsSynced_per_entity_for_summary_output', async () => {
    const result = await runOrchestration({
      entities: ['stages', 'users'],
      runOne: async (entity) => ({
        entity,
        recordsSynced: entity === 'stages' ? 7 : 13,
      }),
    });
    expect(result.results).toEqual([
      { entity: 'stages', recordsSynced: 7 },
      { entity: 'users', recordsSynced: 13 },
    ]);
  });

  it('test_empty_entities_list_returns_empty_results_without_calling_runOne', async () => {
    let called = 0;
    const result = await runOrchestration({
      entities: [],
      runOne: async (entity) => {
        called += 1;
        return { entity, recordsSynced: 0 };
      },
    });
    expect(called).toBe(0);
    expect(result.results).toEqual([]);
  });
});
