/**
 * Skill resolver — TS-side (ADR-013 §2).
 *
 * STUB: GREEN implementation lands in the next commit. This file
 * exists only to make the test file typecheck during the RED phase.
 */

export type CatalogSnapshot = {
  slugMap: Map<string, string>;
  aliasMap: Map<string, string>;
};

export type SkillRow = {
  id: string;
  slug: string;
  deprecated_at: string | null;
};

export type AliasRow = {
  skill_id: string;
  alias_normalized: string;
};

export type Resolution = {
  skill_id: string;
  confidence: 'exact' | 'alias';
};

export function buildCatalogSnapshot(_skills: SkillRow[], _aliases: AliasRow[]): CatalogSnapshot {
  return { slugMap: new Map(), aliasMap: new Map() };
}

export function resolveSkill(
  _raw: string | null | undefined,
  _catalog: CatalogSnapshot,
): Resolution | null {
  return null;
}
