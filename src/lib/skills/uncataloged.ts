/**
 * Uncataloged-skill service (ADR-013 §5).
 *
 * Feeds `/admin/skills/uncataloged` — the operator surface for
 * skill strings that `experience_skills.skill_raw` carries but the
 * catalog doesn't resolve. The page is how the taxonomy grows:
 * admins promote genuine skills into `skills` + `skill_aliases`;
 * dismiss junk via `skills_blacklist`.
 *
 * `aggregateUncataloged` is pure (tested in isolation). The DB
 * helpers read/write via an injected Supabase client so the same
 * code works under RLS (admin JWT) and in scripts with service
 * role.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { reconcileUncatalogedSkills, type ReconcileStats } from './reconcile';
import { normalizeSkillInput } from './resolver';
import { UncatalogedAdminError } from './uncataloged-errors';

export interface UncatalogedRow {
  skill_raw: string;
  experience_id: string;
}

export interface UncatalogedGroup {
  /** Normalized form (the alias that would be stored). */
  alias_normalized: string;
  count: number;
  /** Up to 3 verbatim `skill_raw` samples, first-seen order. */
  samples: string[];
}

const SAMPLES_PER_GROUP = 3;

/** Hard cap on rows fetched per request — plenty for a 5-15-user tool. */
const FETCH_CAP = 5000;

/**
 * Slug format mirrors ADR-013 §1: lowercase, dot/plus/slash/hyphen
 * allowed internally (c++, c#, node.js, ci/cd), no spaces, no
 * terminal punctuation. The DB has a UNIQUE constraint; we
 * pre-validate to give a clear error.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9+#./-]*[a-z0-9+#/]$|^[a-z0-9]$/;

export function aggregateUncataloged(
  rows: UncatalogedRow[],
  blacklist: Set<string>,
): UncatalogedGroup[] {
  const groups = new Map<string, { count: number; samples: string[] }>();

  for (const row of rows) {
    const normalized = normalizeSkillInput(row.skill_raw);
    if (normalized === null) continue;
    if (blacklist.has(normalized)) continue;

    const existing = groups.get(normalized);
    if (existing === undefined) {
      groups.set(normalized, { count: 1, samples: [row.skill_raw] });
      continue;
    }
    existing.count += 1;
    if (existing.samples.length < SAMPLES_PER_GROUP) {
      existing.samples.push(row.skill_raw);
    }
  }

  const out: UncatalogedGroup[] = [];
  for (const [alias_normalized, { count, samples }] of groups) {
    out.push({ alias_normalized, count, samples });
  }

  out.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.alias_normalized.localeCompare(b.alias_normalized);
  });

  return out;
}

export interface ListUncatalogedResult {
  groups: UncatalogedGroup[];
  /** True when the query hit FETCH_CAP — admin should prune / blacklist to see the tail. */
  truncated: boolean;
}

export async function listUncataloged(db: SupabaseClient): Promise<ListUncatalogedResult> {
  const { data: rows, error: rowsErr } = await db
    .from('experience_skills')
    .select('skill_raw, experience_id')
    .is('skill_id', null)
    .order('created_at', { ascending: true })
    .limit(FETCH_CAP);
  if (rowsErr) {
    throw new UncatalogedAdminError('failed to list uncataloged rows', 'db_error', {
      cause: rowsErr.message,
    });
  }

  const { data: blRows, error: blErr } = await db
    .from('skills_blacklist')
    .select('alias_normalized');
  if (blErr) {
    throw new UncatalogedAdminError('failed to load blacklist', 'db_error', {
      cause: blErr.message,
    });
  }
  const blacklist = new Set<string>((blRows ?? []).map((r) => r.alias_normalized as string));

  const groups = aggregateUncataloged((rows ?? []) as UncatalogedRow[], blacklist);
  return {
    groups,
    truncated: (rows?.length ?? 0) >= FETCH_CAP,
  };
}

export async function countUncatalogedRows(db: SupabaseClient): Promise<number> {
  const { count, error } = await db
    .from('experience_skills')
    .select('id', { count: 'exact', head: true })
    .is('skill_id', null);
  if (error) {
    throw new UncatalogedAdminError('failed to count uncataloged rows', 'db_error', {
      cause: error.message,
    });
  }
  return count ?? 0;
}

export interface AddSkillInput {
  canonical_name: string;
  slug: string;
  category?: string | null;
  /** Extra alias strings to register alongside the slug (case/space-insensitive; normalized before insert). */
  extra_aliases?: string[];
}

export interface AddSkillResult {
  skill_id: string;
  slug: string;
  aliases_inserted: number;
  reconcile: ReconcileStats;
}

/**
 * Promote an uncataloged string into the catalog.
 *
 * Flow:
 *   1. Validate slug + canonical_name shape (cheap, pre-DB).
 *   2. Insert skills row (UNIQUE on slug — DB enforces canonical id).
 *   3. Insert any extra aliases with source='admin' (normalized,
 *      deduped, slug itself excluded — slug is matched by the
 *      resolver's step 1).
 *   4. Run incremental reconcile so every existing `experience_skills`
 *      row that now resolves gets its `skill_id` set in one pass.
 *
 * Partial failure semantics: if the skill insert succeeds but alias
 * inserts fail, we still call reconcile (the slug alone resolves
 * whatever matches it) and surface the alias error via the returned
 * `aliases_inserted` count relative to the input. The admin can
 * retry aliases via the `/admin/skills` UI once it exists.
 */
export async function addSkillToCatalog(
  db: SupabaseClient,
  input: AddSkillInput,
): Promise<AddSkillResult> {
  const canonical = input.canonical_name.trim();
  if (canonical.length === 0) {
    throw new UncatalogedAdminError('canonical_name is required', 'invalid_name');
  }

  const slug = input.slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new UncatalogedAdminError('slug must match the catalog format', 'invalid_slug', {
      slug,
    });
  }

  // Normalize+dedupe aliases; drop the slug itself (resolver already
  // matches slugs directly) and anything that normalizes to null.
  const aliasSet = new Set<string>();
  for (const raw of input.extra_aliases ?? []) {
    const normalized = normalizeSkillInput(raw);
    if (normalized === null) continue;
    if (normalized === slug) continue;
    aliasSet.add(normalized);
  }

  // Pre-flight: slug conflict → clear error instead of PG 23505.
  const { data: slugHit, error: slugErr } = await db
    .from('skills')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  if (slugErr) {
    throw new UncatalogedAdminError('failed to check slug', 'db_error', {
      cause: slugErr.message,
    });
  }
  if (slugHit) {
    throw new UncatalogedAdminError('slug already exists', 'slug_conflict', { slug });
  }

  // Pre-flight: alias conflicts (UNIQUE on alias_normalized globally).
  if (aliasSet.size > 0) {
    const { data: aliasHits, error: aliasErr } = await db
      .from('skill_aliases')
      .select('alias_normalized')
      .in('alias_normalized', Array.from(aliasSet));
    if (aliasErr) {
      throw new UncatalogedAdminError('failed to check aliases', 'db_error', {
        cause: aliasErr.message,
      });
    }
    if ((aliasHits ?? []).length > 0) {
      throw new UncatalogedAdminError('alias already claimed by another skill', 'alias_conflict', {
        aliases: (aliasHits ?? []).map((r) => r.alias_normalized as string),
      });
    }
  }

  // Insert skill row.
  const { data: inserted, error: insErr } = await db
    .from('skills')
    .insert({
      canonical_name: canonical,
      slug,
      category: input.category ?? null,
    })
    .select('id')
    .single();
  if (insErr || !inserted) {
    throw new UncatalogedAdminError('failed to insert skill', 'db_error', {
      cause: insErr?.message ?? 'no row returned',
    });
  }
  const skillId = inserted.id as string;

  let aliasesInserted = 0;
  if (aliasSet.size > 0) {
    const payload = Array.from(aliasSet).map((a) => ({
      skill_id: skillId,
      alias_normalized: a,
      source: 'admin' as const,
    }));
    const { error: aliasInsErr, count } = await db
      .from('skill_aliases')
      .insert(payload, { count: 'exact' });
    if (aliasInsErr) {
      throw new UncatalogedAdminError('failed to insert aliases', 'db_error', {
        cause: aliasInsErr.message,
        skill_id: skillId,
      });
    }
    aliasesInserted = count ?? payload.length;
  }

  let reconcile: ReconcileStats;
  try {
    reconcile = await reconcileUncatalogedSkills(db);
  } catch (e) {
    throw new UncatalogedAdminError('reconcile failed after insert', 'reconcile_failed', {
      skill_id: skillId,
      cause: e instanceof Error ? e.message : String(e),
    });
  }

  return { skill_id: skillId, slug, aliases_inserted: aliasesInserted, reconcile };
}

export interface BlacklistInput {
  alias_normalized: string;
  reason?: string | null;
}

export async function blacklistAlias(db: SupabaseClient, input: BlacklistInput): Promise<void> {
  const normalized = normalizeSkillInput(input.alias_normalized);
  if (normalized === null) {
    throw new UncatalogedAdminError('alias is empty after normalization', 'invalid_alias');
  }

  const { error } = await db
    .from('skills_blacklist')
    .insert({ alias_normalized: normalized, reason: input.reason ?? null });
  if (error) {
    // Duplicate is fine — alias already blacklisted, caller is idempotent.
    if (error.code === '23505') return;
    throw new UncatalogedAdminError('failed to blacklist alias', 'db_error', {
      cause: error.message,
    });
  }
}
