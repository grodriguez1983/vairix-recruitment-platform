/**
 * Admin CRUD service for `skills` + `skill_aliases` (ADR-013 §6).
 *
 * Scope:
 *   - list / search skills (with alias + usage counts).
 *   - edit canonical_name / category.
 *   - deprecate / undeprecate (soft delete per ADR-013 §1).
 *   - add / remove aliases (source='admin'; 'seed'/'derived' are
 *     read-only from the UI to preserve provenance).
 *
 * No hard delete. Writes are gated by RLS (admin R/W) and an explicit
 * `requireRole('admin')` in the server actions.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { normalizeSkillInput } from './resolver';
import { UncatalogedAdminError } from './uncataloged-errors';

export interface SkillListItem {
  id: string;
  slug: string;
  canonical_name: string;
  category: string | null;
  deprecated_at: string | null;
  alias_count: number;
}

export interface SkillDetail extends SkillListItem {
  aliases: SkillAlias[];
  /** Count of `experience_skills` rows currently pointing at this skill. */
  usage_count: number;
}

export interface SkillAlias {
  id: string;
  alias_normalized: string;
  source: 'seed' | 'admin' | 'derived';
  created_at: string;
}

export interface ListSkillsOptions {
  search?: string;
  includeDeprecated?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListSkillsResult {
  rows: SkillListItem[];
  total: number;
}

interface RawSkillRow {
  id: string;
  slug: string;
  canonical_name: string;
  category: string | null;
  deprecated_at: string | null;
  skill_aliases: { id: string }[] | null;
}

export async function listSkills(
  db: SupabaseClient,
  options: ListSkillsOptions = {},
): Promise<ListSkillsResult> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;
  const search = options.search?.trim() ?? '';
  const includeDeprecated = options.includeDeprecated ?? false;

  let query = db
    .from('skills')
    .select('id, slug, canonical_name, category, deprecated_at, skill_aliases(id)', {
      count: 'exact',
    });

  if (!includeDeprecated) {
    query = query.is('deprecated_at', null);
  }
  if (search.length > 0) {
    const escaped = search.replace(/[%_]/g, (m) => `\\${m}`);
    query = query.or(`slug.ilike.%${escaped}%,canonical_name.ilike.%${escaped}%`);
  }

  const { data, count, error } = await query
    .order('slug', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new UncatalogedAdminError('failed to list skills', 'db_error', {
      cause: error.message,
    });
  }

  const rows = ((data ?? []) as unknown as RawSkillRow[]).map(
    (r): SkillListItem => ({
      id: r.id,
      slug: r.slug,
      canonical_name: r.canonical_name,
      category: r.category,
      deprecated_at: r.deprecated_at,
      alias_count: r.skill_aliases?.length ?? 0,
    }),
  );

  return { rows, total: count ?? rows.length };
}

export async function getSkill(db: SupabaseClient, id: string): Promise<SkillDetail | null> {
  const { data: skill, error: skillErr } = await db
    .from('skills')
    .select('id, slug, canonical_name, category, deprecated_at')
    .eq('id', id)
    .maybeSingle();
  if (skillErr) {
    throw new UncatalogedAdminError('failed to read skill', 'db_error', {
      cause: skillErr.message,
    });
  }
  if (!skill) return null;

  const { data: aliases, error: aliasErr } = await db
    .from('skill_aliases')
    .select('id, alias_normalized, source, created_at')
    .eq('skill_id', id)
    .order('created_at', { ascending: true });
  if (aliasErr) {
    throw new UncatalogedAdminError('failed to read aliases', 'db_error', {
      cause: aliasErr.message,
    });
  }

  const { count: usageCount, error: usageErr } = await db
    .from('experience_skills')
    .select('id', { count: 'exact', head: true })
    .eq('skill_id', id);
  if (usageErr) {
    throw new UncatalogedAdminError('failed to count usage', 'db_error', {
      cause: usageErr.message,
    });
  }

  return {
    id: skill.id as string,
    slug: skill.slug as string,
    canonical_name: skill.canonical_name as string,
    category: (skill.category as string | null) ?? null,
    deprecated_at: (skill.deprecated_at as string | null) ?? null,
    aliases: (aliases ?? []) as SkillAlias[],
    alias_count: aliases?.length ?? 0,
    usage_count: usageCount ?? 0,
  };
}

export interface UpdateSkillInput {
  canonical_name?: string;
  category?: string | null;
}

export async function updateSkill(
  db: SupabaseClient,
  id: string,
  input: UpdateSkillInput,
): Promise<void> {
  const patch: Record<string, unknown> = {};

  if (input.canonical_name !== undefined) {
    const name = input.canonical_name.trim();
    if (name.length === 0) {
      throw new UncatalogedAdminError('canonical_name cannot be empty', 'invalid_name');
    }
    patch.canonical_name = name;
  }
  if (input.category !== undefined) {
    patch.category = input.category === null ? null : input.category.trim() || null;
  }

  if (Object.keys(patch).length === 0) return;

  const { error } = await db.from('skills').update(patch).eq('id', id);
  if (error) {
    throw new UncatalogedAdminError('failed to update skill', 'db_error', {
      cause: error.message,
    });
  }
}

export async function setDeprecated(
  db: SupabaseClient,
  id: string,
  deprecated: boolean,
): Promise<void> {
  const { error } = await db
    .from('skills')
    .update({ deprecated_at: deprecated ? new Date().toISOString() : null })
    .eq('id', id);
  if (error) {
    throw new UncatalogedAdminError('failed to update deprecation', 'db_error', {
      cause: error.message,
    });
  }
}

export async function addAlias(
  db: SupabaseClient,
  skillId: string,
  rawAlias: string,
): Promise<void> {
  const normalized = normalizeSkillInput(rawAlias);
  if (normalized === null) {
    throw new UncatalogedAdminError('alias is empty after normalization', 'invalid_alias');
  }

  // Pre-flight: global uniqueness (alias_normalized UNIQUE in DB).
  const { data: existing, error: readErr } = await db
    .from('skill_aliases')
    .select('skill_id')
    .eq('alias_normalized', normalized)
    .maybeSingle();
  if (readErr) {
    throw new UncatalogedAdminError('failed to check alias', 'db_error', {
      cause: readErr.message,
    });
  }
  if (existing) {
    if (existing.skill_id === skillId) return; // idempotent
    throw new UncatalogedAdminError('alias already claimed by another skill', 'alias_conflict', {
      alias: normalized,
    });
  }

  const { error } = await db.from('skill_aliases').insert({
    skill_id: skillId,
    alias_normalized: normalized,
    source: 'admin',
  });
  if (error) {
    throw new UncatalogedAdminError('failed to insert alias', 'db_error', {
      cause: error.message,
    });
  }
}

export async function removeAlias(db: SupabaseClient, aliasId: string): Promise<void> {
  const { error } = await db.from('skill_aliases').delete().eq('id', aliasId);
  if (error) {
    throw new UncatalogedAdminError('failed to remove alias', 'db_error', {
      cause: error.message,
    });
  }
}
