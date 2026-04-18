/**
 * Unit tests for the cv source builder (ADR-005 §Fuentes a embeber,
 * F3-001).
 *
 * Covers:
 *   - Returns null when no file has parsed_text.
 *   - Picks the most recently parsed file when multiple CVs exist.
 *   - Ignores soft-deleted files.
 *   - Truncates very long texts to a safe ceiling so we don't blow
 *     past the provider's token limit (ADR-005 §Chunking: Fase 1
 *     trunca al primer chunk).
 *   - Output is deterministic: same inputs in different order yield
 *     the same string (required for hash-driven cache invalidation).
 */
import { describe, expect, it } from 'vitest';

import { buildCvContent, CV_CONTENT_MAX_CHARS } from './cv';

describe('buildCvContent', () => {
  it('returns null when the candidate has no files', () => {
    expect(buildCvContent({ candidateId: 'c1', files: [] })).toBeNull();
  });

  it('returns null when every file has no parsed_text', () => {
    const out = buildCvContent({
      candidateId: 'c1',
      files: [
        { id: 'f1', parsedText: null, parsedAt: '2024-01-01T00:00:00Z', deletedAt: null },
        { id: 'f2', parsedText: '   ', parsedAt: '2024-02-01T00:00:00Z', deletedAt: null },
      ],
    });
    expect(out).toBeNull();
  });

  it('picks the file with the most recent parsed_at', () => {
    const out = buildCvContent({
      candidateId: 'c1',
      files: [
        {
          id: 'old',
          parsedText: 'older resume content',
          parsedAt: '2023-01-01T00:00:00Z',
          deletedAt: null,
        },
        {
          id: 'new',
          parsedText: 'newest resume content',
          parsedAt: '2024-06-01T00:00:00Z',
          deletedAt: null,
        },
        {
          id: 'mid',
          parsedText: 'middle resume content',
          parsedAt: '2023-12-01T00:00:00Z',
          deletedAt: null,
        },
      ],
    });
    expect(out).toContain('newest resume content');
    expect(out).not.toContain('older resume content');
    expect(out).not.toContain('middle resume content');
  });

  it('skips soft-deleted files even if they are the newest', () => {
    const out = buildCvContent({
      candidateId: 'c1',
      files: [
        {
          id: 'kept',
          parsedText: 'still valid resume',
          parsedAt: '2024-01-01T00:00:00Z',
          deletedAt: null,
        },
        {
          id: 'trashed',
          parsedText: 'should not appear',
          parsedAt: '2024-06-01T00:00:00Z',
          deletedAt: '2024-06-02T00:00:00Z',
        },
      ],
    });
    expect(out).toBe('still valid resume');
  });

  it('falls back to files without parsed_at when none have one', () => {
    // If the CV parser has not yet filled parsed_at for any file, we
    // still want a deterministic pick (first id alphabetically) rather
    // than null — the content itself decides the hash.
    const out = buildCvContent({
      candidateId: 'c1',
      files: [
        { id: 'bbb', parsedText: 'second', parsedAt: null, deletedAt: null },
        { id: 'aaa', parsedText: 'first', parsedAt: null, deletedAt: null },
      ],
    });
    expect(out).not.toBeNull();
    // Whichever is picked, the choice must be stable.
    expect(
      buildCvContent({
        candidateId: 'c1',
        files: [
          { id: 'aaa', parsedText: 'first', parsedAt: null, deletedAt: null },
          { id: 'bbb', parsedText: 'second', parsedAt: null, deletedAt: null },
        ],
      }),
    ).toBe(out);
  });

  it('truncates content exceeding the safe ceiling', () => {
    const huge = 'x'.repeat(CV_CONTENT_MAX_CHARS + 5000);
    const out = buildCvContent({
      candidateId: 'c1',
      files: [{ id: 'f1', parsedText: huge, parsedAt: '2024-01-01T00:00:00Z', deletedAt: null }],
    });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(CV_CONTENT_MAX_CHARS);
  });

  it('collapses internal whitespace', () => {
    const out = buildCvContent({
      candidateId: 'c1',
      files: [
        {
          id: 'f1',
          parsedText: '  lots   of\n\n\twhitespace   here  ',
          parsedAt: '2024-01-01T00:00:00Z',
          deletedAt: null,
        },
      ],
    });
    expect(out).toBe('lots of whitespace here');
  });

  it('is deterministic: reshuffled input ⇒ same output', () => {
    const files = [
      {
        id: 'f1',
        parsedText: 'cv one',
        parsedAt: '2024-01-01T00:00:00Z',
        deletedAt: null,
      },
      {
        id: 'f2',
        parsedText: 'cv two',
        parsedAt: '2024-03-01T00:00:00Z',
        deletedAt: null,
      },
    ];
    const a = buildCvContent({ candidateId: 'c1', files });
    const b = buildCvContent({ candidateId: 'c1', files: [...files].reverse() });
    expect(a).toBe(b);
  });
});
