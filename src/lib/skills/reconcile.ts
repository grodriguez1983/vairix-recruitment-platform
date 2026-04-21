/**
 * Skills reconciliation (ADR-013 §3) — resolves uncataloged
 * `experience_skills` rows against the current catalog.
 *
 * Pipeline:
 *   1. Read every `experience_skills` row with `skill_id IS NULL`
 *      in pages of 500 (keeps memory bounded on large backfills).
 *   2. Resolve each `skill_raw` via the in-memory snapshot.
 *   3. For hits, UPDATE the row setting `skill_id` + `resolved_at`.
 *   4. Misses are left as-is (still uncataloged — feed the admin
 *      /admin/skills/uncataloged report).
 *
 * Idempotency:
 *   A second run over the same DB state yields 0 updates because
 *   the query filters `skill_id IS NULL` and the previous run
 *   already populated the resolvable ones. Misses stay misses
 *   until the catalog grows.
 *
 * Batching:
 *   Updates run one row at a time via the JS client to keep
 *   logic simple; for 5–15 users the volume of uncataloged rows
 *   is small. If this ever becomes a bottleneck, switch to a
 *   batched UPDATE with a VALUES join.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadCatalogSnapshot } from './catalog-loader';
import { resolveSkill } from './resolver';

export type ReconcileStats = {
  scanned: number;
  updated: number;
  stillUncataloged: number;
};

const PAGE_SIZE = 500;

export async function reconcileUncatalogedSkills(svc: SupabaseClient): Promise<ReconcileStats> {
  const catalog = await loadCatalogSnapshot(svc);

  let updated = 0;
  // Track rows we already decided are "still uncataloged" so they
  // don't get counted twice across pages (a page that still has
  // unresolved rows keeps returning them until we break the loop).
  const seenUncataloged = new Set<string>();

  for (;;) {
    const { data: page, error } = await svc
      .from('experience_skills')
      .select('id, skill_raw')
      .is('skill_id', null)
      .order('created_at', { ascending: true })
      .limit(PAGE_SIZE);
    if (error) {
      throw new Error(`reconcile: read failed: ${error.message}`);
    }
    if (!page || page.length === 0) break;

    let pageUpdated = 0;
    for (const row of page) {
      if (seenUncataloged.has(row.id)) continue;
      const hit = resolveSkill(row.skill_raw, catalog);
      if (!hit) {
        seenUncataloged.add(row.id);
        continue;
      }
      const { error: updErr } = await svc
        .from('experience_skills')
        .update({ skill_id: hit.skill_id, resolved_at: new Date().toISOString() })
        .eq('id', row.id);
      if (updErr) {
        throw new Error(`reconcile: update id=${row.id} failed: ${updErr.message}`);
      }
      updated += 1;
      pageUpdated += 1;
    }

    // Once a page produces 0 updates everything left is already
    // known-uncataloged (same rows would keep coming back). Break.
    if (pageUpdated === 0) break;
  }

  return {
    scanned: updated + seenUncataloged.size,
    updated,
    stillUncataloged: seenUncataloged.size,
  };
}
