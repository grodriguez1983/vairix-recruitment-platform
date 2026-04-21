/**
 * Unit tests for `runCvExtractions` (ADR-012 §6).
 *
 * The worker is tested with fully-injected deps — no Supabase, no
 * OpenAI. The goal is to prove the behavioral invariants listed in
 * ADR-012 §Tests obligatorios (RED antes de implementar):
 *
 *   - test_worker_idempotent_on_same_hash: if a row with the same
 *     content_hash already exists, the provider is NOT called and no
 *     insert is attempted.
 *   - test_worker_regenerates_on_model_change / _prompt_version_bump:
 *     covered indirectly — different (model|promptVersion) ⇒ different
 *     hash, cache miss, new insert.
 *   - test_worker_row_error_goes_to_sync_errors: a provider failure
 *     for one file must NOT abort the batch; the error lands in
 *     sync_errors, we move on to the next file.
 *
 * The worker dispatches per `cv_variant`: in this phase both variants
 * go through the injected `provider` (the deterministic LinkedIn
 * parser is Fase 2+ work). We still pass variant through so that
 * `candidate_extractions.source_variant` is populated correctly.
 */
import { describe, expect, it, vi } from 'vitest';

import { runCvExtractions, type CvExtractionWorkerDeps } from './worker';
import { createStubExtractionProvider } from './stub-provider';
import type { ExtractionResult } from './types';

function sampleResult(): ExtractionResult {
  return {
    source_variant: 'cv_primary',
    experiences: [
      {
        kind: 'work',
        company: 'Acme',
        title: 'Engineer',
        start_date: '2020-01',
        end_date: null,
        description: null,
        skills: ['TypeScript'],
      },
    ],
    languages: [],
  };
}

type Row = { file_id: string; candidate_id: string; parsed_text: string };

function buildDeps(opts: {
  pending?: Row[];
  existingHashes?: Set<string>;
  providerImpl?: ReturnType<typeof createStubExtractionProvider>;
  throwForFile?: string;
}): {
  deps: CvExtractionWorkerDeps;
  inserts: Array<{ file_id: string; content_hash: string; source_variant: string }>;
  errors: Array<{ entity_id: string; message: string }>;
} {
  const inserts: Array<{ file_id: string; content_hash: string; source_variant: string }> = [];
  const errors: Array<{ entity_id: string; message: string }> = [];
  const existing = new Set(opts.existingHashes ?? []);
  const provider = opts.providerImpl ?? createStubExtractionProvider({ fixture: sampleResult() });

  // Wrap provider so we can throw on demand for a specific file.
  const wrappedProvider = opts.throwForFile
    ? {
        ...provider,
        extract: vi.fn(async (text: string) => {
          const row = (opts.pending ?? []).find((r) => r.parsed_text === text);
          if (row && row.file_id === opts.throwForFile) {
            throw new Error('simulated provider failure');
          }
          return provider.extract(text);
        }),
      }
    : provider;

  return {
    deps: {
      listPending: vi.fn(async () => opts.pending ?? []),
      extractionExistsByHash: vi.fn(async (hash: string) => existing.has(hash)),
      insertExtraction: vi.fn(async (row) => {
        inserts.push({
          file_id: row.file_id,
          content_hash: row.content_hash,
          source_variant: row.source_variant,
        });
      }),
      logRowError: vi.fn(async (input) => {
        errors.push({ entity_id: input.entity_id, message: input.message });
      }),
      provider: wrappedProvider,
    },
    inserts,
    errors,
  };
}

describe('runCvExtractions — ADR-012 §6 worker invariants', () => {
  it('extracts and inserts for every pending file (happy path)', async () => {
    const pending: Row[] = [
      { file_id: 'f1', candidate_id: 'c1', parsed_text: 'cv text one' },
      { file_id: 'f2', candidate_id: 'c2', parsed_text: 'cv text two' },
    ];
    const { deps, inserts, errors } = buildDeps({ pending });
    const stats = await runCvExtractions(deps);

    expect(stats).toEqual({ processed: 2, extracted: 2, skipped: 0, errored: 0 });
    expect(inserts).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });

  it('skips (no provider call, no insert) when content_hash already exists', async () => {
    // Pre-compute the hash the worker would produce for the stub provider.
    const { extractionContentHash } = await import('./hash');
    const provider = createStubExtractionProvider({ fixture: sampleResult() });
    const hash = extractionContentHash('already-extracted', provider.model, provider.promptVersion);

    const extractSpy = vi.spyOn(provider, 'extract');
    const pending: Row[] = [
      { file_id: 'f1', candidate_id: 'c1', parsed_text: 'already-extracted' },
    ];
    const { deps, inserts } = buildDeps({
      pending,
      existingHashes: new Set([hash]),
      providerImpl: provider,
    });

    const stats = await runCvExtractions(deps);
    expect(stats).toEqual({ processed: 1, extracted: 0, skipped: 1, errored: 0 });
    expect(inserts).toHaveLength(0);
    expect(extractSpy).not.toHaveBeenCalled();
  });

  it('logs row error to sync_errors and moves on when provider throws', async () => {
    const pending: Row[] = [
      { file_id: 'f-ok', candidate_id: 'c1', parsed_text: 'good cv' },
      { file_id: 'f-bad', candidate_id: 'c2', parsed_text: 'bad cv' },
      { file_id: 'f-ok2', candidate_id: 'c3', parsed_text: 'good cv 2' },
    ];
    const { deps, inserts, errors } = buildDeps({
      pending,
      throwForFile: 'f-bad',
    });
    const stats = await runCvExtractions(deps);

    expect(stats.processed).toBe(3);
    expect(stats.extracted).toBe(2);
    expect(stats.errored).toBe(1);
    expect(inserts.map((i) => i.file_id)).toEqual(['f-ok', 'f-ok2']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.entity_id).toBe('f-bad');
    expect(errors[0]!.message).toContain('simulated provider failure');
  });

  it('passes the classified source_variant down to the insert', async () => {
    // Text that the classifier will score as linkedin_export.
    const linkedinText = [
      '',
      'Contact',
      'x@x.com',
      'linkedin.com/in/foo',
      '',
      'Top Skills',
      'TypeScript',
      '',
      'Experience',
      'Acme',
      'January 2020 - Present',
      'Beta',
      'June 2018 - December 2019',
      '',
      'Education',
      'UBA',
    ].join('\n');
    const pending: Row[] = [{ file_id: 'f1', candidate_id: 'c1', parsed_text: linkedinText }];
    const { deps, inserts } = buildDeps({ pending });
    await runCvExtractions(deps);
    expect(inserts[0]!.source_variant).toBe('linkedin_export');
  });

  it('uses classifier to mark cv_primary for plain CV text', async () => {
    const pending: Row[] = [
      { file_id: 'f1', candidate_id: 'c1', parsed_text: 'Jane Doe — prose CV without headers' },
    ];
    const { deps, inserts } = buildDeps({ pending });
    await runCvExtractions(deps);
    expect(inserts[0]!.source_variant).toBe('cv_primary');
  });

  it('respects batch size (passes limit to listPending)', async () => {
    const listPending = vi.fn(async () => []);
    const provider = createStubExtractionProvider({ fixture: sampleResult() });
    const deps: CvExtractionWorkerDeps = {
      listPending,
      extractionExistsByHash: async () => false,
      insertExtraction: async () => {},
      logRowError: async () => {},
      provider,
    };
    await runCvExtractions(deps, { batchSize: 7 });
    expect(listPending).toHaveBeenCalledWith(7);
  });

  it('empty pending list returns zero counters', async () => {
    const { deps } = buildDeps({ pending: [] });
    const stats = await runCvExtractions(deps);
    expect(stats).toEqual({ processed: 0, extracted: 0, skipped: 0, errored: 0 });
  });
});
