/**
 * Unit tests for `resolveRequirements` (ADR-014 §5).
 *
 * Pure function: given a `DecompositionResult` from the LLM plus a
 * `CatalogSnapshot` from ADR-013, emits:
 *
 *   - `resolved`: same shape as the input, plus a `skill_id` + a
 *     `resolved_at` ISO timestamp (or null when unresolved) on each
 *     requirement.
 *   - `unresolved_skills`: deduped list of `skill_raw` values that
 *     did NOT resolve (used by the ranker to either block the
 *     search or warn the recruiter — ADR-014 §6).
 *
 * Invariants:
 *   - every `requirement.skill_raw` maps to either a catalog id or
 *     null; the function never drops or reorders requirements.
 *   - `languages`, `seniority`, `notes` are copied through verbatim
 *     (they're not resolved against the skills catalog).
 *   - determinism: same input ⇒ same output (modulo `now` injection).
 */
import { describe, expect, it } from 'vitest';

import { resolveRequirements } from './resolve-requirements';
import type { CatalogSnapshot } from '../../skills/resolver';
import type { DecompositionResult } from './types';

function catalog(): CatalogSnapshot {
  return {
    slugMap: new Map([
      ['node.js', 'skill-node'],
      ['postgresql', 'skill-postgres'],
    ]),
    aliasMap: new Map([['postgres', 'skill-postgres']]),
  };
}

function input(): DecompositionResult {
  return {
    requirements: [
      {
        skill_raw: 'Node.js',
        min_years: 3,
        max_years: null,
        must_have: true,
        evidence_snippet: '3+ años de Node.js',
        category: 'technical',
        alternative_group_id: null,
      },
      {
        skill_raw: 'Postgres',
        min_years: null,
        max_years: null,
        must_have: false,
        evidence_snippet: 'deseable PostgreSQL',
        category: 'technical',
        alternative_group_id: null,
      },
      {
        skill_raw: 'Kubernetes',
        min_years: null,
        max_years: null,
        must_have: false,
        evidence_snippet: 'plus Kubernetes',
        category: 'technical',
        alternative_group_id: null,
      },
    ],
    seniority: 'senior',
    languages: [{ name: 'English', level: 'intermediate', must_have: false }],
    notes: 'Full-time',
  };
}

describe('resolveRequirements — ADR-014 §5', () => {
  it('resolves exact slug matches (confidence: exact)', () => {
    const now = new Date('2026-04-20T12:00:00Z');
    const out = resolveRequirements(input(), catalog(), { now: () => now });
    expect(out.resolved.requirements[0]?.skill_id).toBe('skill-node');
    expect(out.resolved.requirements[0]?.resolved_at).toBe(now.toISOString());
  });

  it('resolves alias matches', () => {
    const now = new Date('2026-04-20T12:00:00Z');
    const out = resolveRequirements(input(), catalog(), { now: () => now });
    expect(out.resolved.requirements[1]?.skill_id).toBe('skill-postgres');
    expect(out.resolved.requirements[1]?.resolved_at).toBe(now.toISOString());
  });

  it('leaves unresolved requirements with skill_id and resolved_at = null', () => {
    const out = resolveRequirements(input(), catalog());
    expect(out.resolved.requirements[2]?.skill_id).toBeNull();
    expect(out.resolved.requirements[2]?.resolved_at).toBeNull();
  });

  it('emits unresolved_skills list with verbatim skill_raw (deduped)', () => {
    const out = resolveRequirements(input(), catalog());
    expect(out.unresolved_skills).toEqual(['Kubernetes']);
  });

  it('dedupes unresolved_skills when the same skill_raw appears twice', () => {
    const duped = input();
    duped.requirements.push({
      skill_raw: 'Kubernetes',
      min_years: null,
      max_years: null,
      must_have: true,
      evidence_snippet: 'imprescindible Kubernetes',
      category: 'technical',
      alternative_group_id: null,
    });
    const out = resolveRequirements(duped, catalog());
    expect(out.unresolved_skills).toEqual(['Kubernetes']);
    // But both requirement rows survive as requirements (we never drop).
    expect(out.resolved.requirements).toHaveLength(4);
  });

  it('copies seniority / languages / notes verbatim', () => {
    const out = resolveRequirements(input(), catalog());
    expect(out.resolved.seniority).toBe('senior');
    expect(out.resolved.languages).toEqual([
      { name: 'English', level: 'intermediate', must_have: false },
    ]);
    expect(out.resolved.notes).toBe('Full-time');
  });

  it('preserves skill_raw verbatim on the resolved requirement (no normalization leak)', () => {
    const out = resolveRequirements(input(), catalog());
    expect(out.resolved.requirements.map((r) => r.skill_raw)).toEqual([
      'Node.js',
      'Postgres',
      'Kubernetes',
    ]);
  });

  it('is deterministic for the same input + catalog + now', () => {
    const now = new Date('2026-04-20T12:00:00Z');
    const a = resolveRequirements(input(), catalog(), { now: () => now });
    const b = resolveRequirements(input(), catalog(), { now: () => now });
    expect(a).toEqual(b);
  });

  it('handles empty requirements gracefully', () => {
    const empty: DecompositionResult = {
      requirements: [],
      seniority: 'unspecified',
      languages: [],
      notes: null,
    };
    const out = resolveRequirements(empty, catalog());
    expect(out.resolved.requirements).toEqual([]);
    expect(out.unresolved_skills).toEqual([]);
  });
});
