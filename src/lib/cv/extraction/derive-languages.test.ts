/**
 * Unit tests for `deriveLanguages` (Languages persistence slice).
 *
 * Service layer that projects `candidate_extractions.raw_output.languages[]`
 * into `candidate_languages` rows, mirroring `deriveExperiences`:
 *
 *   1. Loads the extraction. Missing → throws.
 *   2. Idempotent: `hasExistingLanguages(extraction_id) === true` → skip.
 *   3. Normalizes `name` (trim, drop empties).
 *   4. Deduplicates within the extraction by case-insensitive name,
 *      keeping the first occurrence's `level`.
 *   5. Empty (or all-empty-after-normalization) list → no insert call.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  deriveLanguages,
  type DeriveLanguagesDeps,
  type LanguageInsertRow,
} from './derive-languages';
import type { ExtractionResult } from './types';

const EXTRACTION_ID = '00000000-0000-0000-0000-000000000010';
const CANDIDATE_ID = '00000000-0000-0000-0000-000000000020';

function rawOutputWithLanguages(languages: ExtractionResult['languages']): ExtractionResult {
  return {
    source_variant: 'cv_primary',
    experiences: [],
    languages,
  };
}

function makeDeps(overrides: Partial<DeriveLanguagesDeps> = {}): DeriveLanguagesDeps {
  const base: DeriveLanguagesDeps = {
    loadExtraction: async () => ({
      candidate_id: CANDIDATE_ID,
      raw_output: rawOutputWithLanguages([
        { name: 'English', level: 'C1' },
        { name: 'Spanish', level: 'native' },
      ]),
    }),
    hasExistingLanguages: async () => false,
    insertLanguages: async (rows) => rows.length,
  };
  return { ...base, ...overrides };
}

describe('deriveLanguages (service)', () => {
  it('throws if the extraction does not exist', async () => {
    const deps = makeDeps({ loadExtraction: async () => null });
    await expect(deriveLanguages(EXTRACTION_ID, deps)).rejects.toThrow(/extraction not found/);
  });

  it('skips and writes nothing when candidate_languages already exist for the extraction', async () => {
    const insertSpy = vi.fn(async () => 0);
    const deps = makeDeps({
      hasExistingLanguages: async () => true,
      insertLanguages: insertSpy,
    });
    const result = await deriveLanguages(EXTRACTION_ID, deps);
    expect(result).toEqual({ skipped: true, languagesInserted: 0 });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('inserts one row per language with extraction_id + candidate_id stitched', async () => {
    const inserted: LanguageInsertRow[] = [];
    const deps = makeDeps({
      insertLanguages: async (rows) => {
        inserted.push(...rows);
        return rows.length;
      },
    });

    const result = await deriveLanguages(EXTRACTION_ID, deps);
    expect(result).toEqual({ skipped: false, languagesInserted: 2 });
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({
      candidate_id: CANDIDATE_ID,
      extraction_id: EXTRACTION_ID,
      name: 'English',
      level: 'C1',
    });
    expect(inserted[1]).toMatchObject({
      candidate_id: CANDIDATE_ID,
      extraction_id: EXTRACTION_ID,
      name: 'Spanish',
      level: 'native',
    });
  });

  it('returns languagesInserted=0 and does NOT call insert when raw_output.languages is empty', async () => {
    const insertSpy = vi.fn(async () => 0);
    const deps = makeDeps({
      loadExtraction: async () => ({
        candidate_id: CANDIDATE_ID,
        raw_output: rawOutputWithLanguages([]),
      }),
      insertLanguages: insertSpy,
    });
    const result = await deriveLanguages(EXTRACTION_ID, deps);
    expect(result).toEqual({ skipped: false, languagesInserted: 0 });
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('trims whitespace on name and drops rows whose name becomes empty', async () => {
    const inserted: LanguageInsertRow[] = [];
    const deps = makeDeps({
      loadExtraction: async () => ({
        candidate_id: CANDIDATE_ID,
        raw_output: rawOutputWithLanguages([
          { name: '  English  ', level: 'C1' },
          { name: '   ', level: null }, // dropped
          { name: 'French', level: null },
        ]),
      }),
      insertLanguages: async (rows) => {
        inserted.push(...rows);
        return rows.length;
      },
    });

    const result = await deriveLanguages(EXTRACTION_ID, deps);
    expect(result.languagesInserted).toBe(2);
    expect(inserted.map((r) => r.name)).toEqual(['English', 'French']);
  });

  it('dedups by case-insensitive name, keeping the first occurrence level', async () => {
    const inserted: LanguageInsertRow[] = [];
    const deps = makeDeps({
      loadExtraction: async () => ({
        candidate_id: CANDIDATE_ID,
        raw_output: rawOutputWithLanguages([
          { name: 'English', level: 'C1' },
          { name: 'ENGLISH', level: 'B2' }, // same language, dropped
          { name: 'french', level: null },
        ]),
      }),
      insertLanguages: async (rows) => {
        inserted.push(...rows);
        return rows.length;
      },
    });

    const result = await deriveLanguages(EXTRACTION_ID, deps);
    expect(result.languagesInserted).toBe(2);
    expect(inserted[0]).toMatchObject({ name: 'English', level: 'C1' });
    expect(inserted[1]).toMatchObject({ name: 'french', level: null });
  });

  it('normalizes empty-string level to null', async () => {
    const inserted: LanguageInsertRow[] = [];
    const deps = makeDeps({
      loadExtraction: async () => ({
        candidate_id: CANDIDATE_ID,
        raw_output: rawOutputWithLanguages([
          { name: 'German', level: '' },
          { name: 'Italian', level: '   ' }, // whitespace only → null
        ]),
      }),
      insertLanguages: async (rows) => {
        inserted.push(...rows);
        return rows.length;
      },
    });

    await deriveLanguages(EXTRACTION_ID, deps);
    expect(inserted[0]!.level).toBeNull();
    expect(inserted[1]!.level).toBeNull();
  });
});
