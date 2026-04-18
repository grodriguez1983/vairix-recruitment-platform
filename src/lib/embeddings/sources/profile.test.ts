/**
 * Unit tests for the profile source builder.
 *
 * Per ADR-005 §Fuentes a embeber: profile text is a synthetic string
 * combining "Nombre, headline, tags, sumario del CV". Builder must:
 *   - Return null when the candidate has no usable fields (skip).
 *   - Handle missing optional fields gracefully (no "undefined"
 *     strings leaking into the output).
 *   - Be stable: same inputs ⇒ same output (critical for hash-based
 *     change detection).
 */
import { describe, expect, it } from 'vitest';

import { buildProfileContent, type ProfileSourceInput } from './profile';

describe('buildProfileContent', () => {
  it('returns null when there is no usable content at all', () => {
    const input: ProfileSourceInput = {
      candidateId: 'c1',
      firstName: null,
      lastName: null,
      headline: null,
      summary: null,
      tags: [],
    };
    expect(buildProfileContent(input)).toBeNull();
  });

  it('returns a non-null string when any field is populated', () => {
    const out = buildProfileContent({
      candidateId: 'c1',
      firstName: 'Ada',
      lastName: null,
      headline: null,
      summary: null,
      tags: [],
    });
    expect(out).not.toBeNull();
    expect(out).toContain('Ada');
  });

  it('composes all fields when present', () => {
    const out = buildProfileContent({
      candidateId: 'c1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      headline: 'Senior Backend Engineer',
      summary: '10 years of experience building distributed systems.',
      tags: ['go', 'kafka', 'leadership'],
    });
    expect(out).toContain('Ada Lovelace');
    expect(out).toContain('Senior Backend Engineer');
    expect(out).toContain('distributed systems');
    expect(out).toContain('go');
    expect(out).toContain('kafka');
    expect(out).toContain('leadership');
  });

  it('never leaks "null" or "undefined" literals in the output', () => {
    const out = buildProfileContent({
      candidateId: 'c1',
      firstName: 'Ada',
      lastName: null,
      headline: null,
      summary: null,
      tags: [],
    });
    expect(out).not.toMatch(/null|undefined/i);
  });

  it('is deterministic: tag order and whitespace are normalized', () => {
    const a = buildProfileContent({
      candidateId: 'c1',
      firstName: 'A',
      lastName: null,
      headline: null,
      summary: null,
      tags: ['go', 'kafka'],
    });
    const b = buildProfileContent({
      candidateId: 'c1',
      firstName: 'A',
      lastName: null,
      headline: null,
      summary: null,
      tags: ['kafka', 'go'],
    });
    expect(a).toBe(b);
  });

  it('trims surrounding whitespace and collapses duplicate blanks', () => {
    const out = buildProfileContent({
      candidateId: 'c1',
      firstName: '  Ada  ',
      lastName: 'Lovelace',
      headline: null,
      summary: null,
      tags: [],
    });
    expect(out).toBe(out?.trim());
    expect(out).not.toMatch(/ {2,}/);
  });
});
