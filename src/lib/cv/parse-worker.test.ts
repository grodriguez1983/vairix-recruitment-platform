/**
 * Unit tests for the CV parse worker runtime.
 *
 * The worker is the bridge between F1-007 (uploads → files rows with
 * parsed_text=null) and F3-001 cv embeddings (which only consider
 * rows where parsed_text IS NOT NULL). It must:
 *   - Pick only pending rows (deleted_at IS NULL, parsed_text IS NULL,
 *     parse_error IS NULL).
 *   - Download the binary from Storage by storage_path.
 *   - Route to parseCvBuffer by file_type.
 *   - Persist parsed_text (ok) OR parse_error (failure) with a
 *     non-null parsed_at timestamp so we do NOT re-attempt on the
 *     next run — a classified failure is still a terminal state
 *     (caller can clear parse_error to retry).
 */
import { describe, expect, it, vi } from 'vitest';

import { runCvParseWorker, type CvParseWorkerDeps } from './parse-worker';
import type { CvParserDeps } from './parse';

type PendingRow = {
  id: string;
  storage_path: string;
  file_type: string;
};

function makeDeps(overrides: {
  pending?: PendingRow[];
  parser?: Partial<CvParserDeps>;
  download?: (path: string) => Promise<Buffer>;
  updates?: Array<{ id: string; patch: Record<string, unknown> }>;
}): CvParseWorkerDeps {
  const pending = overrides.pending ?? [];
  const updates = overrides.updates ?? [];
  return {
    listPending: vi.fn().mockResolvedValue(pending),
    download: overrides.download ?? vi.fn().mockResolvedValue(Buffer.from('')),
    update: vi.fn().mockImplementation(async (id, patch) => {
      updates.push({ id, patch });
    }),
    parser: {
      parsePdf: vi.fn().mockResolvedValue({ text: 'a'.repeat(300) }),
      parseDocx: vi.fn().mockResolvedValue({ value: 'docx content here' }),
      ...overrides.parser,
    },
    now: () => new Date('2026-04-18T10:00:00Z'),
  };
}

describe('runCvParseWorker', () => {
  it('processes only pending rows and reports counts', async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const deps = makeDeps({
      pending: [
        { id: 'f1', storage_path: 'cand/f1.pdf', file_type: 'pdf' },
        { id: 'f2', storage_path: 'cand/f2.docx', file_type: 'docx' },
      ],
      updates,
    });
    const result = await runCvParseWorker(deps, { batchSize: 10 });
    expect(result).toEqual({ processed: 2, parsed: 2, errored: 0 });
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.patch.parsed_text).toEqual(expect.any(String));
      expect(u.patch.parse_error).toBeNull();
      expect(u.patch.parsed_at).toBe('2026-04-18T10:00:00.000Z');
    }
  });

  it('classifies parse_failure when the parser throws', async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const deps = makeDeps({
      pending: [{ id: 'f1', storage_path: 'cand/f1.pdf', file_type: 'pdf' }],
      parser: { parsePdf: vi.fn().mockRejectedValue(new Error('corrupt pdf')) },
      updates,
    });
    const result = await runCvParseWorker(deps, { batchSize: 10 });
    expect(result).toEqual({ processed: 1, parsed: 0, errored: 1 });
    expect(updates[0]!.patch).toMatchObject({
      parsed_text: null,
      parse_error: 'parse_failure',
      parsed_at: '2026-04-18T10:00:00.000Z',
    });
  });

  it('classifies likely_scanned for tiny PDF text', async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const deps = makeDeps({
      pending: [{ id: 'f1', storage_path: 'cand/f1.pdf', file_type: 'pdf' }],
      parser: { parsePdf: vi.fn().mockResolvedValue({ text: 'too short' }) },
      updates,
    });
    const result = await runCvParseWorker(deps, { batchSize: 10 });
    expect(result.errored).toBe(1);
    expect(updates[0]!.patch).toMatchObject({
      parse_error: 'likely_scanned',
      parsed_text: null,
    });
  });

  it('classifies unsupported_format without calling any parser', async () => {
    const parsePdf = vi.fn();
    const parseDocx = vi.fn();
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const deps = makeDeps({
      pending: [{ id: 'f1', storage_path: 'cand/f1.xlsx', file_type: 'xlsx' }],
      parser: { parsePdf, parseDocx },
      updates,
    });
    const result = await runCvParseWorker(deps, { batchSize: 10 });
    expect(result.errored).toBe(1);
    expect(parsePdf).not.toHaveBeenCalled();
    expect(parseDocx).not.toHaveBeenCalled();
    expect(updates[0]!.patch.parse_error).toBe('unsupported_format');
  });

  it('marks download failures as parse_failure (does not crash the batch)', async () => {
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const deps = makeDeps({
      pending: [
        { id: 'f1', storage_path: 'cand/f1.pdf', file_type: 'pdf' },
        { id: 'f2', storage_path: 'cand/f2.pdf', file_type: 'pdf' },
      ],
      download: vi.fn().mockImplementation(async (path: string) => {
        if (path === 'cand/f1.pdf') throw new Error('storage 404');
        return Buffer.from('ok');
      }),
      parser: { parsePdf: vi.fn().mockResolvedValue({ text: 'a'.repeat(300) }) },
      updates,
    });
    const result = await runCvParseWorker(deps, { batchSize: 10 });
    expect(result).toEqual({ processed: 2, parsed: 1, errored: 1 });
    const f1 = updates.find((u) => u.id === 'f1')!;
    expect(f1.patch.parse_error).toBe('parse_failure');
    const f2 = updates.find((u) => u.id === 'f2')!;
    expect(f2.patch.parsed_text).toEqual(expect.any(String));
    expect(f2.patch.parse_error).toBeNull();
  });

  it('honors batchSize (calls listPending with the limit)', async () => {
    const listPending = vi.fn().mockResolvedValue([]);
    const deps: CvParseWorkerDeps = {
      ...makeDeps({}),
      listPending,
    };
    await runCvParseWorker(deps, { batchSize: 25 });
    expect(listPending).toHaveBeenCalledWith(25);
  });
});
