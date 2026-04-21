/**
 * Variant merger (ADR-015 §2, F4-007 sub-A).
 *
 * Pure function: collapses `cv_primary` + `linkedin_export`
 * experiences for a single candidate into a canonical list. When a
 * cv_primary experience matches a linkedin_export one (same kind,
 * same normalized company + title, date overlap > 50%), the
 * cv_primary row wins dates/title/description and the skills are
 * unioned. The surviving row carries `merged_from_ids = [primary,
 * linkedin]` so the ranker can attribute evidence to both origins.
 *
 * Determinism is explicit: we sort by `(start_date desc NULLS LAST,
 * id asc)` before emitting. `merged_from_ids` is sorted lexically so
 * reordered input yields identical output.
 *
 * Null semantics:
 *   - `company = null` on either side → not enough signal, no merge.
 *   - `start_date = null` on either side → overlap uncomputable,
 *     no merge.
 *   - `end_date = null` → treated as `options.now` (default Date.now)
 *     when computing overlap only. The stored value stays null.
 *   - `title` is compared after normalization; `null` vs `null`
 *     counts as a match (covers CVs that omit titles).
 */
import { overlapRatio, toInterval } from './date-intervals';
import type {
  ExperienceInput,
  ExperienceSkill,
  MergeDiagnostic,
  MergeResult,
  MergedExperience,
  SourceVariant,
} from './types';

export interface MergeOptions {
  now?: Date;
}

const COMPANY_SUFFIX_RE =
  /\b(inc|incorporated|llc|ltd|limited|corp|corporation|company|co|gmbh|ag|sa|srl|bv|nv)\b\.?/gi;

function normalizeCompany(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value
    .toLowerCase()
    .replace(COMPANY_SUFFIX_RE, ' ')
    .replace(/[.,&/()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length === 0 ? null : cleaned;
}

function normalizeTitle(value: string | null): string {
  if (value === null) return '';
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Titles on CV vs LinkedIn diverge often ("Engineer" vs "Senior
 * Engineer") — a strict equality check would miss most real dupes.
 * We accept:
 *   - identical after normalization
 *   - one is a substring of the other
 *   - Jaccard token overlap ≥ 0.5
 *
 * If either side is null, we treat title as "no signal" — the caller
 * still enforces company + date overlap, so null title alone does not
 * cause spurious merges.
 */
function titleCompatible(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return true;
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === '' || nb === '') return true;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(/\s+/).filter(Boolean));
  const tb = new Set(nb.split(/\s+/).filter(Boolean));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= 0.5;
}

/**
 * Skill union preserving cv_primary casing when the same skill_id
 * surfaces on both sides. Unresolved skills (skill_id === null) are
 * deduped by case-insensitive skill_raw.
 */
function unionSkills(
  primary: readonly ExperienceSkill[],
  linkedin: readonly ExperienceSkill[],
): ExperienceSkill[] {
  const out: ExperienceSkill[] = [];
  const seenIds = new Set<string>();
  const seenRaws = new Set<string>();

  for (const side of [primary, linkedin]) {
    for (const s of side) {
      if (s.skill_id !== null) {
        if (seenIds.has(s.skill_id)) continue;
        seenIds.add(s.skill_id);
        out.push(s);
      } else {
        const key = s.skill_raw.toLowerCase();
        if (seenRaws.has(key)) continue;
        seenRaws.add(key);
        out.push(s);
      }
    }
  }
  return out;
}

function asMerged(exp: ExperienceInput): MergedExperience {
  return {
    id: exp.id,
    source_variant: exp.source_variant,
    kind: exp.kind,
    company: exp.company,
    title: exp.title,
    start_date: exp.start_date,
    end_date: exp.end_date,
    description: exp.description,
    skills: [...exp.skills],
    merged_from_ids: [exp.id],
  };
}

function mergePair(primary: ExperienceInput, linkedin: ExperienceInput): MergedExperience {
  return {
    id: primary.id,
    source_variant: 'cv_primary' satisfies SourceVariant,
    kind: primary.kind,
    company: primary.company,
    title: primary.title,
    start_date: primary.start_date,
    end_date: primary.end_date,
    description: primary.description,
    skills: unionSkills(primary.skills, linkedin.skills),
    merged_from_ids: [linkedin.id, primary.id].sort(),
  };
}

function trySelectMatch(
  primary: ExperienceInput,
  linkedinCandidates: ExperienceInput[],
  usedLinkedin: Set<string>,
  now: Date,
): { linkedin: ExperienceInput; ratio: number } | null {
  const primaryInterval = toInterval(primary.start_date, primary.end_date, now);
  if (primaryInterval === null) return null;
  const primaryCompany = normalizeCompany(primary.company);
  if (primaryCompany === null) return null;

  let best: { linkedin: ExperienceInput; ratio: number } | null = null;

  for (const l of linkedinCandidates) {
    if (usedLinkedin.has(l.id)) continue;
    if (l.kind !== primary.kind) continue;
    const lCompany = normalizeCompany(l.company);
    if (lCompany === null || lCompany !== primaryCompany) continue;
    if (!titleCompatible(primary.title, l.title)) continue;
    const lInterval = toInterval(l.start_date, l.end_date, now);
    if (lInterval === null) continue;
    const ratio = overlapRatio(primaryInterval, lInterval);
    if (ratio <= 0.5) {
      // Threshold check is strictly greater than 50%. Log for diagnostics
      // through the return value of the outer loop, not here (we don't
      // want noise when a better candidate still wins).
      continue;
    }
    if (best === null || ratio > best.ratio) {
      best = { linkedin: l, ratio };
    }
  }
  return best;
}

/**
 * Detects near-miss pairs (same company+title+kind, dates overlap but
 * below threshold) so the UI can surface a "these might be the same
 * role" hint without auto-merging. Runs only after the greedy merge
 * has finalized — otherwise we'd double-log pairs that ended up
 * merging.
 */
function collectNearMissDiagnostics(
  primaries: readonly ExperienceInput[],
  linkedins: readonly ExperienceInput[],
  usedLinkedin: ReadonlySet<string>,
  mergedPrimaryIds: ReadonlySet<string>,
  now: Date,
): MergeDiagnostic[] {
  const diagnostics: MergeDiagnostic[] = [];
  for (const p of primaries) {
    if (mergedPrimaryIds.has(p.id)) continue;
    const pInterval = toInterval(p.start_date, p.end_date, now);
    if (pInterval === null) continue;
    const pCompany = normalizeCompany(p.company);
    if (pCompany === null) continue;

    for (const l of linkedins) {
      if (usedLinkedin.has(l.id)) continue;
      if (l.kind !== p.kind) continue;
      const lCompany = normalizeCompany(l.company);
      if (lCompany === null || lCompany !== pCompany) continue;
      const titleEq = titleCompatible(p.title, l.title);
      if (!titleEq) continue;
      const lInterval = toInterval(l.start_date, l.end_date, now);
      if (lInterval === null) continue;
      const ratio = overlapRatio(pInterval, lInterval);
      if (ratio > 0 && ratio <= 0.5) {
        diagnostics.push({
          kind: 'kept_distinct_below_threshold',
          cv_primary_id: p.id,
          linkedin_id: l.id,
          overlap_ratio: Number(ratio.toFixed(4)),
          company_match: true,
          title_match: titleEq,
        });
      }
    }
  }
  return diagnostics;
}

export function mergeVariants(
  input: readonly ExperienceInput[],
  options: MergeOptions = {},
): MergeResult {
  const now = options.now ?? new Date();
  const primaries = input.filter((e) => e.source_variant === 'cv_primary');
  const linkedins = input.filter((e) => e.source_variant === 'linkedin_export');

  const sortedPrimaries = [...primaries].sort((a, b) => a.id.localeCompare(b.id));
  const sortedLinkedins = [...linkedins].sort((a, b) => a.id.localeCompare(b.id));

  const usedLinkedin = new Set<string>();
  const mergedPrimaryIds = new Set<string>();
  const merged: MergedExperience[] = [];
  const mergeDiagnostics: MergeDiagnostic[] = [];

  for (const p of sortedPrimaries) {
    const match = trySelectMatch(p, sortedLinkedins, usedLinkedin, now);
    if (match !== null) {
      usedLinkedin.add(match.linkedin.id);
      mergedPrimaryIds.add(p.id);
      merged.push(mergePair(p, match.linkedin));
      mergeDiagnostics.push({
        kind: 'merged',
        cv_primary_id: p.id,
        linkedin_id: match.linkedin.id,
        overlap_ratio: Number(match.ratio.toFixed(4)),
        company_match: true,
        title_match: true,
      });
    } else {
      merged.push(asMerged(p));
    }
  }

  for (const l of sortedLinkedins) {
    if (usedLinkedin.has(l.id)) continue;
    merged.push(asMerged(l));
  }

  const nearMiss = collectNearMissDiagnostics(
    sortedPrimaries,
    sortedLinkedins,
    usedLinkedin,
    mergedPrimaryIds,
    now,
  );

  merged.sort((a, b) => {
    // Sort: start_date desc NULLS LAST, then id asc. Determinism first.
    const aStart = a.start_date === null ? -Infinity : Date.parse(a.start_date);
    const bStart = b.start_date === null ? -Infinity : Date.parse(b.start_date);
    if (aStart !== bStart) return bStart - aStart;
    return a.id.localeCompare(b.id);
  });

  return { experiences: merged, diagnostics: [...mergeDiagnostics, ...nearMiss] };
}
