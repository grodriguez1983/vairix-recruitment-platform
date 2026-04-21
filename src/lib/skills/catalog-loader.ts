/**
 * Catalog loader — reads the skills catalog from Supabase and
 * builds a `CatalogSnapshot` usable by `resolveSkill()`.
 *
 * Usage:
 *   const catalog = await loadCatalogSnapshot(svc);
 *   const hit = resolveSkill(rawString, catalog);
 *
 * Snapshot lifetime (ADR-013 §2): load once per worker batch. If
 * the catalog changes mid-batch the worker still uses the snapshot
 * it had at batch start — consistent-within-batch trade-off.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { CatalogSnapshot } from './resolver';
import { buildCatalogSnapshot } from './resolver';

export async function loadCatalogSnapshot(svc: SupabaseClient): Promise<CatalogSnapshot> {
  const { data: skillRows, error: sErr } = await svc
    .from('skills')
    .select('id, slug, deprecated_at');
  if (sErr) {
    throw new Error(`loadCatalogSnapshot: skills read failed: ${sErr.message}`);
  }

  const { data: aliasRows, error: aErr } = await svc
    .from('skill_aliases')
    .select('skill_id, alias_normalized');
  if (aErr) {
    throw new Error(`loadCatalogSnapshot: aliases read failed: ${aErr.message}`);
  }

  return buildCatalogSnapshot(skillRows ?? [], aliasRows ?? []);
}
