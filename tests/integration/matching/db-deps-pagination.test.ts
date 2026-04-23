/**
 * RED: `buildRunMatchJobDeps` must paginate past PostgREST `max_rows`.
 *
 * Background (prod incident, 2026-04-23). `job_query 2d4d6faa-...`
 * ran with `candidates_evaluated = 203` but 53 candidates landed at
 * `total_score = 0` (e.g. Elena Tibekina, rank 153). Root cause:
 *
 *   supabase/config.toml → `max_rows = 1000`
 *
 * is a hard cap on every PostgREST `SELECT` that does not paginate.
 * `db-deps.loadExperiences` (and `fetchAllCandidateIds`,
 * `fetchCandidateMustHaveCoverage`, `loadLanguages`) all issue a
 * single `.select(...).in(...)` call with no `.range(...)` loop, so
 * once `candidate_experiences` crosses 1000 rows the tail is
 * silently dropped — candidates whose rows fall after row 1000 look
 * like they have zero experience.
 *
 * This test exercises the bug directly: it seeds 1_100 candidates
 * with exactly one `candidate_experiences` row each, then asks
 * `loadCandidates` (via `buildRunMatchJobDeps`) for every candidate.
 * Under the current unpaginated impl it returns ≤ 1000 experience
 * rows total, so ≥ 100 candidates come back with
 * `merged_experiences.length === 0`.
 *
 * Once `db-deps` paginates (sub-B of this fix), every seeded
 * candidate returns its 1 experience and the test goes GREEN.
 *
 * Notes:
 *   - Scoped to its own teamtailor_id prefix so it never collides
 *     with other integration fixtures.
 *   - Uses service role via `serviceClient()` — this is an RLS-
 *     bypass wiring test, the RLS path is covered by `tests/rls/`.
 *   - Slow by design (large insert batches). Kept under 60s on a
 *     local supabase-test stack.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { buildRunMatchJobDeps } from '../../../src/lib/matching/db-deps';

import { serviceClient } from '../../rls/helpers';

const FIXTURE_TT_PREFIX = 'f4-008-pg-';
const CANDIDATE_COUNT = 1_100; // strictly > max_rows = 1000
const INSERT_BATCH = 200;

async function deleteFixtureArtifacts(db: SupabaseClient): Promise<void> {
  // Cascades from candidates → files → extractions → experiences.
  await db.from('candidates').delete().like('teamtailor_id', `${FIXTURE_TT_PREFIX}%`);
}

async function insertInBatches<T>(
  db: SupabaseClient,
  table: string,
  rows: T[],
  returning?: string,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const slice = rows.slice(i, i + INSERT_BATCH);
    const query = db.from(table).insert(slice as never);
    if (returning !== undefined) {
      const { data, error } = await query.select(returning);
      if (error) throw new Error(`insert ${table}[${i}]: ${error.message}`);
      for (const row of data ?? []) out.push(row as unknown as Record<string, unknown>);
    } else {
      const { error } = await query;
      if (error) throw new Error(`insert ${table}[${i}]: ${error.message}`);
    }
  }
  return out;
}

describe('buildRunMatchJobDeps — pagination past PostgREST max_rows', () => {
  const db = serviceClient();
  let candidateIds: string[] = [];

  beforeAll(async () => {
    await deleteFixtureArtifacts(db);

    // 1. Candidates.
    const candidateRows = Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
      teamtailor_id: `${FIXTURE_TT_PREFIX}${i.toString().padStart(5, '0')}`,
      first_name: 'PG',
      last_name: `Cand${i}`,
    }));
    const candidatesInserted = await insertInBatches(
      db,
      'candidates',
      candidateRows,
      'id, teamtailor_id',
    );
    // Preserve seed order via teamtailor_id so the candidate list has
    // a deterministic tail that falls past row 1000.
    candidatesInserted.sort((a, b) =>
      (a.teamtailor_id as string) < (b.teamtailor_id as string) ? -1 : 1,
    );
    candidateIds = candidatesInserted.map((r) => r.id as string);
    expect(candidateIds).toHaveLength(CANDIDATE_COUNT);

    // 2. Files — one per candidate.
    const fileRows = candidateIds.map((candidate_id, i) => ({
      candidate_id,
      storage_path: `cv/${FIXTURE_TT_PREFIX}${i.toString().padStart(5, '0')}.pdf`,
    }));
    const filesInserted = await insertInBatches(db, 'files', fileRows, 'id, candidate_id');
    const fileByCandidate = new Map<string, string>();
    for (const f of filesInserted) fileByCandidate.set(f.candidate_id as string, f.id as string);

    // 3. Extractions — one per candidate (satisfies FK from experiences).
    const extractionRows = candidateIds.map((candidate_id, i) => ({
      candidate_id,
      file_id: fileByCandidate.get(candidate_id)!,
      source_variant: 'cv_primary',
      model: 'stub-extract-v1',
      prompt_version: 'stub-extract-prompt-v1',
      content_hash: `f4008-pg-${i}`,
      raw_output: {},
    }));
    const extractionsInserted = await insertInBatches(
      db,
      'candidate_extractions',
      extractionRows,
      'id, candidate_id',
    );
    const extractionByCandidate = new Map<string, string>();
    for (const e of extractionsInserted)
      extractionByCandidate.set(e.candidate_id as string, e.id as string);

    // 4. One experience per candidate.
    const experienceRows = candidateIds.map((candidate_id) => ({
      candidate_id,
      extraction_id: extractionByCandidate.get(candidate_id)!,
      source_variant: 'cv_primary',
      kind: 'work',
      company: 'PagCo',
      title: 'Engineer',
      start_date: '2022-01-01',
      end_date: null,
    }));
    await insertInBatches(db, 'candidate_experiences', experienceRows);
  }, 120_000);

  afterAll(async () => {
    await deleteFixtureArtifacts(db);
  });

  it('loadCandidates returns every seeded experience even past the 1000-row cap', async () => {
    const deps = buildRunMatchJobDeps(db);

    const aggregates = await deps.loadCandidates(candidateIds);

    // Sanity: the loader shapes one aggregate per input id.
    expect(aggregates).toHaveLength(CANDIDATE_COUNT);

    const emptyCandidates = aggregates.filter((a) => a.merged_experiences.length === 0);
    // Under the unpaginated impl this is ≥ CANDIDATE_COUNT - 1000.
    // Under the paginated fix this is 0.
    expect(emptyCandidates).toEqual([]);

    const totalExperiences = aggregates.reduce((sum, a) => sum + a.merged_experiences.length, 0);
    expect(totalExperiences).toBe(CANDIDATE_COUNT);
  });

  it('fetchAllCandidateIds + pre-filter coverage return every candidate past the 1000-row cap', async () => {
    // Exercise preFilter's "no active must-have groups" short-circuit:
    // an empty requirements list returns the full candidate pool as
    // `included`. If `fetchAllCandidateIds` silently caps at 1000
    // the excluded-from-listing candidates never reach the ranker.
    const deps = buildRunMatchJobDeps(db);

    const res = await deps.preFilter(
      {
        requirements: [],
        languages: [],
        seniority: 'unspecified',
        notes: null,
        role_essentials: [],
      },
      null,
    );

    const fixtureIncluded = res.included.filter((id) => candidateIds.includes(id));
    expect(fixtureIncluded).toHaveLength(CANDIDATE_COUNT);
  });
});
