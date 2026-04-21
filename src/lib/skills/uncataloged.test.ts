/**
 * Unit tests for uncataloged-skill aggregation (ADR-013 §5).
 *
 * The admin report at `/admin/skills/uncataloged` groups
 * `experience_skills` rows with `skill_id IS NULL` by their
 * *normalized* form (so "React", "react " and "REACT" collapse to
 * a single row), counts them, and excludes strings that an admin
 * already blacklisted.
 *
 * Invariants under test:
 *   1. Groups are keyed by `normalizeSkillInput(skill_raw)`.
 *   2. Rows that normalize to null (empty, whitespace-only) are
 *      dropped entirely — they are garbage, not uncataloged.
 *   3. Sort order is count desc, then alias asc (deterministic for
 *      equal counts).
 *   4. Blacklisted aliases are omitted from the output.
 *   5. Samples (up to 3 verbatim `skill_raw`s per group) are
 *      preserved so the admin can eyeball what they're cataloging.
 */
import { describe, expect, it } from 'vitest';

import { aggregateUncataloged, type UncatalogedGroup, type UncatalogedRow } from './uncataloged';

function row(skill_raw: string, experience_id = 'exp-1'): UncatalogedRow {
  return { skill_raw, experience_id };
}

describe('aggregateUncataloged — ADR-013 §5', () => {
  it('returns an empty list when there are no rows', () => {
    expect(aggregateUncataloged([], new Set())).toEqual([]);
  });

  it('groups rows by normalized form (case/whitespace/terminal-punct insensitive)', () => {
    const out = aggregateUncataloged(
      [row('React'), row('react '), row('REACT'), row('React.'), row('Python')],
      new Set(),
    );
    const react = out.find((g) => g.alias_normalized === 'react');
    expect(react?.count).toBe(4);
    const python = out.find((g) => g.alias_normalized === 'python');
    expect(python?.count).toBe(1);
  });

  it('drops rows that normalize to null (empty / whitespace-only)', () => {
    const out = aggregateUncataloged([row(''), row('   '), row('\n\t'), row('React')], new Set());
    expect(out).toHaveLength(1);
    expect(out[0]?.alias_normalized).toBe('react');
  });

  it('orders by count desc, then alias asc for ties', () => {
    const out = aggregateUncataloged(
      [
        row('react'),
        row('react'),
        row('react'),
        row('vue'),
        row('vue'),
        row('angular'),
        row('angular'),
      ],
      new Set(),
    );
    expect(out.map((g) => g.alias_normalized)).toEqual(['react', 'angular', 'vue']);
  });

  it('excludes aliases present in the blacklist', () => {
    const out: UncatalogedGroup[] = aggregateUncataloged(
      [row('team player'), row('react'), row('Team Player')],
      new Set(['team player']),
    );
    expect(out.map((g) => g.alias_normalized)).toEqual(['react']);
  });

  it('collects up to 3 verbatim samples per group (preserving first-seen order)', () => {
    const out = aggregateUncataloged(
      [
        row('React', 'exp-1'),
        row('REACT', 'exp-2'),
        row('react ', 'exp-3'),
        row('React.', 'exp-4'),
      ],
      new Set(),
    );
    const react = out.find((g) => g.alias_normalized === 'react');
    expect(react?.samples).toEqual(['React', 'REACT', 'react ']);
  });
});
