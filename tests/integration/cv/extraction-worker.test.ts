/**
 * Integration test for the CV extraction worker (ADR-012 §6).
 *
 * Wires the real Supabase bindings that the CLI uses against a local
 * stack, with a deterministic `StubExtractionProvider` so we don't
 * need an OpenAI key. The focus is the SQL side of the contract:
 *
 *   - The `listPending` query picks the right rows (parsed_text
 *     present, no extraction for current model + prompt_version).
 *   - `content_hash` UNIQUE prevents duplicates across runs — a
 *     second run on the same state extracts nothing.
 *   - A provider failure for one row lands in `sync_errors` with
 *     entity=`cv_extraction` without aborting the batch.
 *
 * We use `tenant_id = NULL` throughout — multi-tenant scoping is
 * ADR-003 Fase 2 work and the worker does not read tenant yet.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  runCvExtractions,
  type CvExtractionWorkerDeps,
} from '../../../src/lib/cv/extraction/worker';
import { listPendingExtractions } from '../../../src/lib/cv/extraction/list-pending';
import { createStubExtractionProvider } from '../../../src/lib/cv/extraction/stub-provider';
import type { ExtractionResult } from '../../../src/lib/cv/extraction/types';

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const CANDIDATE_TT_ID = 'extraction-worker-test';

function svc(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function sampleResult(): ExtractionResult {
  return {
    source_variant: 'cv_primary',
    experiences: [],
    languages: [],
  };
}

function workerDeps(
  db: SupabaseClient,
  provider: ReturnType<typeof createStubExtractionProvider>,
): CvExtractionWorkerDeps {
  return {
    listPending: (limit) =>
      listPendingExtractions(db, {
        model: provider.model,
        promptVersion: provider.promptVersion,
        limit,
      }),
    extractionExistsByHash: async (hash) => {
      const { data, error } = await db
        .from('candidate_extractions')
        .select('id')
        .eq('content_hash', hash)
        .maybeSingle();
      if (error && error.code !== 'PGRST116') throw new Error(error.message);
      return data !== null;
    },
    insertExtraction: async (row) => {
      const { data, error } = await db
        .from('candidate_extractions')
        .insert({
          candidate_id: row.candidate_id,
          file_id: row.file_id,
          source_variant: row.source_variant,
          model: row.model,
          prompt_version: row.prompt_version,
          content_hash: row.content_hash,
          raw_output: row.raw_output,
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(error?.message ?? 'insertExtraction returned no row');
      return { id: data.id as string };
    },
    logRowError: async (input) => {
      // sync_errors schema (ADR-004): entity + teamtailor_id as the
      // opaque external-or-internal key, payload for extras. We
      // store file_id in teamtailor_id (the column is a free-form
      // string for the entity's logical id).
      const { error } = await db.from('sync_errors').insert({
        entity: input.entity,
        teamtailor_id: input.entity_id,
        error_message: input.message,
        run_started_at: new Date().toISOString(),
      });
      if (error) throw new Error(error.message);
    },
    provider,
  };
}

describe('runCvExtractions (integration)', () => {
  const db = svc();
  let candidateId: string;
  const fileIds: string[] = [];

  beforeEach(async () => {
    await db.from('candidates').delete().eq('teamtailor_id', CANDIDATE_TT_ID);
    const { data: cand } = await db
      .from('candidates')
      .insert({
        teamtailor_id: CANDIDATE_TT_ID,
        first_name: 'Extraction',
        last_name: 'Worker',
        email: 'extraction-worker@example.test',
        raw_data: {},
      })
      .select('id')
      .single();
    candidateId = cand!.id as string;
    fileIds.length = 0;
  });

  afterEach(async () => {
    if (fileIds.length > 0) {
      await db.from('candidate_extractions').delete().in('file_id', fileIds);
    }
    await db
      .from('sync_errors')
      .delete()
      .in('teamtailor_id', fileIds.length > 0 ? fileIds : ['-']);
    await db.from('files').delete().eq('candidate_id', candidateId);
    await db.from('candidates').delete().eq('id', candidateId);
  });

  async function seedFile(parsedText: string): Promise<string> {
    const { data: f, error } = await db
      .from('files')
      .insert({
        candidate_id: candidateId,
        storage_path: `${candidateId}/${Math.random().toString(36).slice(2)}.pdf`,
        file_type: 'cv',
        parsed_text: parsedText,
        parsed_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error || !f) throw new Error(error?.message ?? 'insert failed');
    fileIds.push(f.id as string);
    return f.id as string;
  }

  it('extracts pending files and is idempotent on a second run', async () => {
    await seedFile('parsed cv text one');
    await seedFile('parsed cv text two');
    const provider = createStubExtractionProvider({ fixture: sampleResult() });

    const first = await runCvExtractions(workerDeps(db, provider));
    expect(first.processed).toBe(2);
    expect(first.extracted).toBe(2);
    expect(first.errored).toBe(0);

    const second = await runCvExtractions(workerDeps(db, provider));
    // On the second run, listPending excludes the files that already
    // have an extraction for (model, prompt_version) — so processed
    // is 0. That's the stronger idempotency proof.
    expect(second.processed).toBe(0);
    expect(second.extracted).toBe(0);
    expect(second.skipped).toBe(0);
  });

  it('model bump triggers a new extraction (invalidates hash)', async () => {
    await seedFile('parsed cv text for model bump');
    const p1 = createStubExtractionProvider({ fixture: sampleResult(), model: 'stub-v1' });
    const p2 = createStubExtractionProvider({ fixture: sampleResult(), model: 'stub-v2' });

    const r1 = await runCvExtractions(workerDeps(db, p1));
    expect(r1.extracted).toBe(1);

    const r2 = await runCvExtractions(workerDeps(db, p2));
    expect(r2.extracted).toBe(1);

    const { data: rows } = await db
      .from('candidate_extractions')
      .select('id, model')
      .in('file_id', fileIds);
    const models = (rows ?? []).map((r) => r.model).sort();
    expect(models).toEqual(['stub-v1', 'stub-v2']);
  });

  it('provider failure for one row lands in sync_errors; batch continues', async () => {
    const goodId = await seedFile('good cv text');
    const badId = await seedFile('bad cv text');
    const baseProvider = createStubExtractionProvider({ fixture: sampleResult() });
    const failingProvider = {
      ...baseProvider,
      extract: async (text: string) => {
        if (text === 'bad cv text') throw new Error('simulated LLM failure');
        return baseProvider.extract(text);
      },
    };
    const stats = await runCvExtractions(workerDeps(db, failingProvider));
    expect(stats.extracted).toBe(1);
    expect(stats.errored).toBe(1);

    // Good file ended up in candidate_extractions.
    const { data: extractions } = await db
      .from('candidate_extractions')
      .select('file_id')
      .eq('file_id', goodId);
    expect(extractions).toHaveLength(1);

    // Bad file ended up in sync_errors.
    const { data: errs } = await db
      .from('sync_errors')
      .select('entity, teamtailor_id, error_message')
      .eq('teamtailor_id', badId);
    expect(errs).toHaveLength(1);
    expect(errs![0]!.entity).toBe('cv_extraction');
    expect(errs![0]!.error_message as string).toContain('simulated LLM failure');
  });
});
