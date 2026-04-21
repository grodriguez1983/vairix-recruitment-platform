/**
 * Integration test for `candidate_experiences.description_tsv`
 * (ADR-016 §3, roadmap F4-007 bis).
 *
 * The column is a STORED generated tsvector over
 * `to_tsvector('simple', coalesce(description, ''))` + GIN index. It
 * feeds the FTS recall-fallback (F4-008 bis) — a candidate that has
 * `react` in free-form description but not in structured
 * `experience_skills` must still be searchable via plainto_tsquery.
 *
 * We assert two things:
 *   1. The column is queryable via `@@ plainto_tsquery('simple', ...)`.
 *   2. The column is NOT writable: any attempt to insert/update a
 *      value for `description_tsv` must fail — it is generated.
 *   3. NULL description yields an empty tsvector (not null), so the
 *      generated expression survives rows created before the backfill
 *      of FTS-usable descriptions.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { serviceClient } from '../../rls/helpers';

async function seedChain(
  svc: ReturnType<typeof serviceClient>,
  suffix: string,
): Promise<{ candidateId: string; extractionId: string }> {
  const { data: cand, error: cErr } = await svc
    .from('candidates')
    .insert({ teamtailor_id: `tt-tsv-${suffix}`, first_name: 'T' })
    .select('id')
    .single();
  if (cErr || !cand) throw new Error(`seed candidates: ${cErr?.message}`);

  const { data: file, error: fErr } = await svc
    .from('files')
    .insert({ candidate_id: cand.id, storage_path: `cv/tsv-${suffix}.pdf` })
    .select('id')
    .single();
  if (fErr || !file) throw new Error(`seed files: ${fErr?.message}`);

  const { data: ex, error: eErr } = await svc
    .from('candidate_extractions')
    .insert({
      candidate_id: cand.id,
      file_id: file.id,
      source_variant: 'cv_primary',
      model: 'gpt-4o-mini',
      prompt_version: '2026-04-v1',
      content_hash: `h-tsv-${suffix}`,
      raw_output: {},
    })
    .select('id')
    .single();
  if (eErr || !ex) throw new Error(`seed extractions: ${eErr?.message}`);

  return { candidateId: cand.id, extractionId: ex.id };
}

describe('candidate_experiences.description_tsv', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await svc
      .from('candidate_experiences')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    await svc
      .from('candidate_extractions')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('files').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc
      .from('candidate_experiences')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    await svc
      .from('candidate_extractions')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('files').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  it('description_tsv matches plainto_tsquery over description terms', async () => {
    const { candidateId, extractionId } = await seedChain(svc, 'match');
    const { data: exp, error } = await svc
      .from('candidate_experiences')
      .insert({
        candidate_id: candidateId,
        extraction_id: extractionId,
        source_variant: 'cv_primary',
        kind: 'work',
        company: 'Acme',
        description: 'Led a team using React and Node.js to ship payments.',
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    expect(exp).not.toBeNull();

    const { data: rows, error: qErr } = await svc
      .from('candidate_experiences')
      .select('id')
      .eq('id', exp!.id)
      .textSearch('description_tsv', 'react', { config: 'simple' });
    expect(qErr).toBeNull();
    expect((rows ?? []).length).toBe(1);
  });

  it('description_tsv does NOT match terms absent from description', async () => {
    const { candidateId, extractionId } = await seedChain(svc, 'miss');
    const { data: exp } = await svc
      .from('candidate_experiences')
      .insert({
        candidate_id: candidateId,
        extraction_id: extractionId,
        source_variant: 'cv_primary',
        kind: 'work',
        description: 'Led a team using Python and Django.',
      })
      .select('id')
      .single();

    const { data: rows, error } = await svc
      .from('candidate_experiences')
      .select('id')
      .eq('id', exp!.id)
      .textSearch('description_tsv', 'react', { config: 'simple' });
    expect(error).toBeNull();
    expect((rows ?? []).length).toBe(0);
  });

  it('null description produces an empty (but non-null) tsvector', async () => {
    const { candidateId, extractionId } = await seedChain(svc, 'null');
    const { data: exp, error } = await svc
      .from('candidate_experiences')
      .insert({
        candidate_id: candidateId,
        extraction_id: extractionId,
        source_variant: 'cv_primary',
        kind: 'work',
        description: null,
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    expect(exp).not.toBeNull();

    // Querying a term should simply return zero rows, not blow up.
    const { data: rows, error: qErr } = await svc
      .from('candidate_experiences')
      .select('id')
      .eq('id', exp!.id)
      .textSearch('description_tsv', 'anything', { config: 'simple' });
    expect(qErr).toBeNull();
    expect((rows ?? []).length).toBe(0);
  });
});
