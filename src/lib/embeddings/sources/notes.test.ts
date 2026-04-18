/**
 * Unit tests for the notes source builder.
 *
 * Covers:
 *   - Returns null when the candidate has no usable notes.
 *   - Concatenates bodies with a visible separator.
 *   - Sorts chronologically (oldest first) so output is stable
 *     regardless of input order.
 *   - Skips empty / whitespace-only bodies without leaving dangling
 *     separators.
 *   - Same set of notes in different orders ⇒ same string (critical
 *     for hash-based cache invalidation).
 */
import { describe, expect, it } from 'vitest';

import { buildNotesContent } from './notes';

describe('buildNotesContent', () => {
  it('returns null when there are no notes at all', () => {
    expect(buildNotesContent({ candidateId: 'c1', notes: [] })).toBeNull();
  });

  it('returns null when every note body is empty or whitespace', () => {
    const out = buildNotesContent({
      candidateId: 'c1',
      notes: [
        { body: '', createdAt: '2024-01-01T00:00:00Z' },
        { body: '   ', createdAt: '2024-01-02T00:00:00Z' },
        { body: null, createdAt: '2024-01-03T00:00:00Z' },
      ],
    });
    expect(out).toBeNull();
  });

  it('concatenates bodies chronologically (oldest first)', () => {
    const out = buildNotesContent({
      candidateId: 'c1',
      notes: [
        { body: 'second note', createdAt: '2024-02-01T00:00:00Z' },
        { body: 'first note', createdAt: '2024-01-01T00:00:00Z' },
        { body: 'third note', createdAt: '2024-03-01T00:00:00Z' },
      ],
    });
    expect(out).not.toBeNull();
    const firstIdx = out!.indexOf('first note');
    const secondIdx = out!.indexOf('second note');
    const thirdIdx = out!.indexOf('third note');
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });

  it('is deterministic: reshuffled input ⇒ same output', () => {
    const a = buildNotesContent({
      candidateId: 'c1',
      notes: [
        { body: 'one', createdAt: '2024-01-01T00:00:00Z' },
        { body: 'two', createdAt: '2024-01-02T00:00:00Z' },
        { body: 'three', createdAt: '2024-01-03T00:00:00Z' },
      ],
    });
    const b = buildNotesContent({
      candidateId: 'c1',
      notes: [
        { body: 'three', createdAt: '2024-01-03T00:00:00Z' },
        { body: 'one', createdAt: '2024-01-01T00:00:00Z' },
        { body: 'two', createdAt: '2024-01-02T00:00:00Z' },
      ],
    });
    expect(a).toBe(b);
  });

  it('skips empty bodies without leaving blank sections in between', () => {
    const out = buildNotesContent({
      candidateId: 'c1',
      notes: [
        { body: 'keeper', createdAt: '2024-01-01T00:00:00Z' },
        { body: '   ', createdAt: '2024-01-02T00:00:00Z' },
        { body: 'also keeper', createdAt: '2024-01-03T00:00:00Z' },
      ],
    });
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/\n\n\n/);
    expect(out).toContain('keeper');
    expect(out).toContain('also keeper');
  });

  it('never leaks "null" / "undefined" literals in the output', () => {
    const out = buildNotesContent({
      candidateId: 'c1',
      notes: [
        { body: 'real text', createdAt: '2024-01-01T00:00:00Z' },
        { body: null, createdAt: '2024-01-02T00:00:00Z' },
      ],
    });
    expect(out).not.toMatch(/\b(null|undefined)\b/i);
  });

  it('collapses internal whitespace inside each body', () => {
    const out = buildNotesContent({
      candidateId: 'c1',
      notes: [{ body: '  lots   of   spaces  \n  and\ttabs ', createdAt: '2024-01-01T00:00:00Z' }],
    });
    expect(out).toBe('lots of spaces and tabs');
  });
});
