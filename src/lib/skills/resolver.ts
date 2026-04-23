/**
 * Skill resolver — TS-side (ADR-013 §2).
 *
 * Pure function with injected `CatalogSnapshot`. The SQL mirror is
 * `public.resolve_skill(text)` (migration 20260420000000). Both
 * sides share the exact same pipeline; equivalence is enforced by
 * tests/integration/skills/resolver-equivalence.test.ts.
 *
 * Pipeline:
 *   1. null/undefined/empty/whitespace-only → null (no I/O).
 *   2. trim any whitespace (spaces, tabs, \r, \n).
 *   3. lowercase.
 *   4. collapse internal whitespace to a single space.
 *   5. collapse `-` / `_` between alphanumerics to a single space
 *      (ADR-024). "react-native" → "react native".
 *   6. strip terminal punctuation (., ,, ;, :) — preserve internal.
 *   7. exact match against skills.slug (ignoring deprecated).
 *   8. alias match against skill_aliases.alias_normalized.
 *   9. no match → null.
 *
 * The snapshot is built once per batch from two DB reads. Inside a
 * batch it's immutable; if the catalog changes the worker rebuilds
 * on the next batch (ADR-013 §2).
 */

export type SkillRow = {
  id: string;
  slug: string;
  deprecated_at: string | null;
};

export type AliasRow = {
  skill_id: string;
  alias_normalized: string;
};

export type CatalogSnapshot = {
  /** slug → skill_id, excluding deprecated skills. */
  slugMap: Map<string, string>;
  /** alias_normalized → skill_id, regardless of parent deprecation. */
  aliasMap: Map<string, string>;
};

export type Resolution = {
  skill_id: string;
  confidence: 'exact' | 'alias';
};

/**
 * Builds the in-memory snapshot used by `resolveSkill`.
 *
 * - Deprecated skills are excluded from `slugMap` to mirror the SQL
 *   helper's `WHERE deprecated_at IS NULL` clause.
 * - Aliases are indexed unconditionally — the SQL helper does not
 *   filter alias matches by deprecation, and we mirror that literally.
 */
export function buildCatalogSnapshot(skills: SkillRow[], aliases: AliasRow[]): CatalogSnapshot {
  const slugMap = new Map<string, string>();
  for (const s of skills) {
    if (s.deprecated_at !== null) continue;
    slugMap.set(s.slug, s.id);
  }
  const aliasMap = new Map<string, string>();
  for (const a of aliases) {
    aliasMap.set(a.alias_normalized, a.skill_id);
  }
  return { slugMap, aliasMap };
}

/**
 * Normalizes a raw skill string per ADR-013 §2. Returns `null` when
 * the input is empty after normalization (caller treats as
 * "uncataloged").
 *
 * Exported for the equivalence test and for any caller that needs
 * the normalized form without resolving (e.g. building
 * `/admin/skills/uncataloged` groupings).
 */
export function normalizeSkillInput(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  // Step 1: strip all leading/trailing whitespace (including tabs,
  // newlines, carriage returns). Mirror of the SQL regex
  // `regexp_replace(raw, '^\s+|\s+$', '', 'g')`.
  let s = raw.replace(/^\s+|\s+$/g, '');
  if (s.length === 0) return null;

  // Step 2: lowercase.
  s = s.toLowerCase();

  // Step 3: collapse internal whitespace.
  s = s.replace(/\s+/g, ' ');

  // Step 4 (ADR-024): collapse `-` and `_` between alphanumerics to
  // a single space so "react-native" and "react_native" resolve the
  // same as "react native". Lookahead keeps the second alphanum
  // unconsumed so `a-b-c` is handled in one pass (a naive /g replace
  // on `([a-z0-9])[-_]([a-z0-9])` would leave `a b-c` because the
  // trailing `b` is consumed by the first match). Scope is narrow:
  // hyphens/underscores between non-alphanum chars (e.g. `-react`,
  // `c-#`) and other internal punctuation (`.`, `+`, `/`, `#`) are
  // untouched so node.js, c++, c#, ci/cd keep working.
  s = s.replace(/([a-z0-9])[-_](?=[a-z0-9])/g, '$1 ');

  // Step 5: strip terminal punctuation (., ,, ;, :). Internal
  // punctuation (the dot in "node.js", the + in "c++", the / in
  // "ci/cd") is preserved.
  s = s.replace(/[.,;:]+$/, '');

  return s.length === 0 ? null : s;
}

/**
 * Resolves a raw skill string to a catalog id using the snapshot.
 * Returns `null` for empty inputs and for uncataloged strings.
 */
export function resolveSkill(
  raw: string | null | undefined,
  catalog: CatalogSnapshot,
): Resolution | null {
  const normalized = normalizeSkillInput(raw);
  if (normalized === null) return null;

  const slugHit = catalog.slugMap.get(normalized);
  if (slugHit !== undefined) {
    return { skill_id: slugHit, confidence: 'exact' };
  }

  const aliasHit = catalog.aliasMap.get(normalized);
  if (aliasHit !== undefined) {
    return { skill_id: aliasHit, confidence: 'alias' };
  }

  return null;
}
