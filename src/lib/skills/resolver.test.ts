/**
 * Unit tests for `resolveSkill` — TS-side resolver (ADR-013 §2).
 *
 * Contract mirrored by `public.resolve_skill()` SQL helper
 * (tests/integration/skills/resolve-skill-sql.test.ts). Equivalence
 * between both sides is enforced in
 * tests/integration/skills/resolver-equivalence.test.ts.
 *
 * Pipeline (ADR-013 §2):
 *   1. lowercase → trim (any whitespace) → collapse internal whitespace
 *   2. strip terminal punctuation (., ,, ;, :) — preserve internal
 *      punctuation (c++, c#, node.js, ci/cd, react.js)
 *   3. exact slug match (ignoring deprecated skills) → {exact}
 *   4. alias match → {alias}
 *   5. no match → null
 *
 * The resolver is a pure function: it takes a `CatalogSnapshot`
 * (two Maps built from the DB) and never does I/O itself.
 */
import { describe, expect, it } from 'vitest';

import type { CatalogSnapshot } from './resolver';
import { buildCatalogSnapshot, resolveSkill } from './resolver';

// ────────────────────────────────────────────────────────────────
// Fixture helpers
// ────────────────────────────────────────────────────────────────

type SkillRow = {
  id: string;
  slug: string;
  deprecated: boolean;
};

type AliasRow = {
  skill_id: string;
  alias_normalized: string;
};

function makeCatalog(skills: SkillRow[], aliases: AliasRow[]): CatalogSnapshot {
  return buildCatalogSnapshot(
    skills.map((s) => ({
      id: s.id,
      slug: s.slug,
      deprecated_at: s.deprecated ? new Date().toISOString() : null,
    })),
    aliases.map((a) => ({ skill_id: a.skill_id, alias_normalized: a.alias_normalized })),
  );
}

// Canonical ids used across tests (arbitrary UUID strings — resolver
// treats them opaquely).
const REACT = '00000000-0000-0000-0000-00000000aaaa';
const NODE = '00000000-0000-0000-0000-00000000bbbb';
const CPP = '00000000-0000-0000-0000-00000000cccc';
const CSHARP = '00000000-0000-0000-0000-00000000dddd';
const CICD = '00000000-0000-0000-0000-00000000eeee';
const REACT_NATIVE = '00000000-0000-0000-0000-00000000ffff';
const JQUERY = '00000000-0000-0000-0000-000000000011';
const LEGACY_REACT = '00000000-0000-0000-0000-000000000022';
const TEAM_PLAYER = '00000000-0000-0000-0000-000000000033';

describe('resolveSkill — ADR-013 §2 pipeline', () => {
  // ──────────────────────────────────────────────────────────────
  // Null / empty inputs
  // ──────────────────────────────────────────────────────────────

  it('returns null for null input', () => {
    const catalog = makeCatalog([{ id: REACT, slug: 'react', deprecated: false }], []);
    expect(resolveSkill(null, catalog)).toBeNull();
  });

  it('returns null for undefined input', () => {
    const catalog = makeCatalog([], []);
    expect(resolveSkill(undefined, catalog)).toBeNull();
  });

  it('returns null for empty string', () => {
    const catalog = makeCatalog([{ id: REACT, slug: 'react', deprecated: false }], []);
    expect(resolveSkill('', catalog)).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    const catalog = makeCatalog([{ id: REACT, slug: 'react', deprecated: false }], []);
    expect(resolveSkill('   ', catalog)).toBeNull();
    expect(resolveSkill('\t\n', catalog)).toBeNull();
    expect(resolveSkill('\r  \t', catalog)).toBeNull();
  });

  it('returns null for uncataloged input (no match)', () => {
    const catalog = makeCatalog([{ id: REACT, slug: 'react', deprecated: false }], []);
    expect(resolveSkill('Fortran', catalog)).toBeNull();
    expect(resolveSkill('my experience', catalog)).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────
  // Slug match (exact, case-insensitive)
  // ──────────────────────────────────────────────────────────────

  it('matches slug case-insensitively and returns confidence=exact', () => {
    const catalog = makeCatalog([{ id: REACT, slug: 'react', deprecated: false }], []);
    expect(resolveSkill('React', catalog)).toEqual({
      skill_id: REACT,
      confidence: 'exact',
    });
    expect(resolveSkill('react', catalog)).toEqual({
      skill_id: REACT,
      confidence: 'exact',
    });
    expect(resolveSkill('REACT', catalog)).toEqual({
      skill_id: REACT,
      confidence: 'exact',
    });
  });

  it('matches slug with internal punctuation preserved', () => {
    const catalog = makeCatalog(
      [
        { id: NODE, slug: 'node.js', deprecated: false },
        { id: CPP, slug: 'c++', deprecated: false },
        { id: CSHARP, slug: 'c#', deprecated: false },
        { id: CICD, slug: 'ci/cd', deprecated: false },
      ],
      [],
    );
    expect(resolveSkill('Node.js', catalog)?.skill_id).toBe(NODE);
    expect(resolveSkill('NODE.JS', catalog)?.skill_id).toBe(NODE);
    expect(resolveSkill('C++', catalog)?.skill_id).toBe(CPP);
    expect(resolveSkill('c++', catalog)?.skill_id).toBe(CPP);
    expect(resolveSkill('C#', catalog)?.skill_id).toBe(CSHARP);
    expect(resolveSkill('CI/CD', catalog)?.skill_id).toBe(CICD);
    expect(resolveSkill('ci/cd', catalog)?.skill_id).toBe(CICD);
  });

  // ──────────────────────────────────────────────────────────────
  // Normalization: trim + collapse whitespace + terminal punct
  // ──────────────────────────────────────────────────────────────

  it('strips terminal punctuation (., ,, ;, :) before matching', () => {
    const catalog = makeCatalog([{ id: REACT, slug: 'react', deprecated: false }], []);
    expect(resolveSkill('React.', catalog)?.skill_id).toBe(REACT);
    expect(resolveSkill('React,', catalog)?.skill_id).toBe(REACT);
    expect(resolveSkill('React;', catalog)?.skill_id).toBe(REACT);
    expect(resolveSkill('React:', catalog)?.skill_id).toBe(REACT);
    expect(resolveSkill('React..,;', catalog)?.skill_id).toBe(REACT);
  });

  it('does NOT strip internal punctuation even if the skill has no internal punct', () => {
    // "react.js" must NOT resolve to "react" — the internal dot is
    // not a terminal one and is preserved, so normalized form is
    // "react.js" which does not match slug "react".
    const catalog = makeCatalog([{ id: REACT, slug: 'react', deprecated: false }], []);
    expect(resolveSkill('react.js', catalog)).toBeNull();
  });

  it('trims leading and trailing whitespace (spaces, tabs, newlines)', () => {
    const catalog = makeCatalog([{ id: REACT, slug: 'react', deprecated: false }], []);
    expect(resolveSkill('  React  ', catalog)?.skill_id).toBe(REACT);
    expect(resolveSkill('\tReact\n', catalog)?.skill_id).toBe(REACT);
    expect(resolveSkill('\r\nReact\r\n', catalog)?.skill_id).toBe(REACT);
  });

  it('collapses internal whitespace to a single space', () => {
    const catalog = makeCatalog(
      [{ id: REACT_NATIVE, slug: 'react native', deprecated: false }],
      [],
    );
    expect(resolveSkill('React Native', catalog)?.skill_id).toBe(REACT_NATIVE);
    expect(resolveSkill('React  Native', catalog)?.skill_id).toBe(REACT_NATIVE);
    expect(resolveSkill('React\tNative', catalog)?.skill_id).toBe(REACT_NATIVE);
    expect(resolveSkill('  React   Native  ', catalog)?.skill_id).toBe(REACT_NATIVE);
  });

  // ──────────────────────────────────────────────────────────────
  // Alias fallback
  // ──────────────────────────────────────────────────────────────

  it('falls back to alias match with confidence=alias', () => {
    const catalog = makeCatalog(
      [{ id: REACT, slug: 'react', deprecated: false }],
      [
        { skill_id: REACT, alias_normalized: 'reactjs' },
        { skill_id: REACT, alias_normalized: 'react.js' },
      ],
    );
    expect(resolveSkill('ReactJS', catalog)).toEqual({
      skill_id: REACT,
      confidence: 'alias',
    });
    expect(resolveSkill('react.js', catalog)).toEqual({
      skill_id: REACT,
      confidence: 'alias',
    });
  });

  it('prefers slug match over alias match (step 2 before step 3)', () => {
    // If the catalog were corrupted so a string matches both a slug
    // and an alias pointing elsewhere, slug must win.
    const catalog = makeCatalog(
      [
        { id: REACT, slug: 'react', deprecated: false },
        { id: LEGACY_REACT, slug: 'legacy-react', deprecated: false },
      ],
      [{ skill_id: LEGACY_REACT, alias_normalized: 'react' }],
    );
    expect(resolveSkill('React', catalog)).toEqual({
      skill_id: REACT,
      confidence: 'exact',
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Deprecated + blacklist-agnostic
  // ──────────────────────────────────────────────────────────────

  it('ignores deprecated skills on slug match', () => {
    const catalog = makeCatalog([{ id: JQUERY, slug: 'jquery', deprecated: true }], []);
    expect(resolveSkill('jQuery', catalog)).toBeNull();
  });

  it('resolves via alias even if alias points to a deprecated skill', () => {
    // ADR-013 §1: deprecated_at is soft-delete — UI hides but data
    // integrity is preserved. The SQL helper's current behavior is
    // to check deprecation only for slug match (step 2), not for
    // alias match (step 3). We mirror that literally.
    const catalog = makeCatalog(
      [{ id: JQUERY, slug: 'jquery', deprecated: true }],
      [{ skill_id: JQUERY, alias_normalized: 'jquery-ui' }],
    );
    expect(resolveSkill('jquery-ui', catalog)).toEqual({
      skill_id: JQUERY,
      confidence: 'alias',
    });
  });

  it('does NOT consult skills_blacklist (resolver bypasses it)', () => {
    // Blacklist is a UI helper for /admin/skills/uncataloged (ADR-013
    // §5). The resolver does not see it — and the CatalogSnapshot
    // does not even carry blacklist data.
    const catalog = makeCatalog([{ id: TEAM_PLAYER, slug: 'team player', deprecated: false }], []);
    expect(resolveSkill('Team Player', catalog)?.skill_id).toBe(TEAM_PLAYER);
  });

  // ──────────────────────────────────────────────────────────────
  // buildCatalogSnapshot invariants
  // ──────────────────────────────────────────────────────────────

  it('buildCatalogSnapshot excludes deprecated skills from the slug map', () => {
    const catalog = makeCatalog(
      [
        { id: REACT, slug: 'react', deprecated: false },
        { id: JQUERY, slug: 'jquery', deprecated: true },
      ],
      [],
    );
    expect(catalog.slugMap.get('react')).toBe(REACT);
    expect(catalog.slugMap.has('jquery')).toBe(false);
  });

  it('buildCatalogSnapshot indexes aliases regardless of parent deprecation', () => {
    const catalog = makeCatalog(
      [{ id: JQUERY, slug: 'jquery', deprecated: true }],
      [{ skill_id: JQUERY, alias_normalized: 'jquery-ui' }],
    );
    expect(catalog.aliasMap.get('jquery-ui')).toBe(JQUERY);
  });
});
