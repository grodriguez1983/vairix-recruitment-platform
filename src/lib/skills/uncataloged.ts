/**
 * Uncataloged-skill service (ADR-013 §5) — RED stub.
 *
 * Feeds `/admin/skills/uncataloged`. The aggregation function is
 * pure and tested in isolation; the real implementation lands in
 * the GREEN commit.
 */

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

export function aggregateUncataloged(
  _rows: UncatalogedRow[],
  _blacklist: Set<string>,
): UncatalogedGroup[] {
  throw new Error('aggregateUncataloged: not implemented');
}
