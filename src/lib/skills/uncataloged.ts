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
import { normalizeSkillInput } from './resolver';

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
