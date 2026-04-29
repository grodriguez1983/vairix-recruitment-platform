/**
 * Control A — Spec ↔ Code parity for prescribed test names.
 *
 * Why this exists: in Bloque 21 we found that `docs/use-cases.md` UC-11
 * prescribes a test (`test_decomposer_extracts_years_and_must_haves`)
 * that was never implemented, and the corresponding ADR (ADR-014) was
 * silently narrower than the spec. The contradiction stayed invisible
 * for months because nothing checked it.
 *
 * This test parses every `test_<snake_case>` identifier mentioned in
 * `docs/use-cases.md`, `docs/spec.md`, and `docs/adr/*.md`, and
 * cross-references them against literal `test_*` occurrences in
 * `*.test.ts` files. A prescribed name that isn't implemented (and
 * isn't in `KNOWN_GAPS`) is a parity violation.
 *
 * `KNOWN_GAPS` is an explicit allowlist of names that are prescribed
 * but acceptably absent (renamed, deferred, covered by integration
 * test under a different name, etc.). Each entry is a frozen
 * acknowledgement: when reality drifts (a gap gets closed, or a
 * prescribed name is removed from docs), the test fails so we delete
 * the stale entry on purpose.
 *
 * Three invariants:
 *   1. No prescribed name is missing from code unless it's in KNOWN_GAPS.
 *   2. KNOWN_GAPS contains no stale entries (names now implemented).
 *   3. KNOWN_GAPS contains no typos (names not actually prescribed).
 *
 * Detection model is intentionally cheap (regex over text, not AST).
 * False negatives possible (a comment mentioning `test_foo` would
 * count as "implemented") but the goal is catching omissions, not
 * gaming the matcher.
 */
import { describe, expect, it } from 'vitest';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DOC_FILES = ['docs/use-cases.md', 'docs/spec.md'];
const ADR_DIR = 'docs/adr';
const CODE_DIRS = ['src', 'tests'];

const TEST_NAME_RE = /\btest_[a-z][a-z0-9_]+/g;

/**
 * Names that are prescribed in docs but acceptably not implemented
 * under the literal name. Each entry must carry a one-line reason so
 * future readers (and security reviewers) can tell a real gap from a
 * known divergence.
 *
 * When you implement a prescribed test, REMOVE its entry from this
 * list. When you rename or delete a prescription in docs, REMOVE its
 * entry too. The `stale-allowlist` invariant below will tell you
 * which is which.
 *
 * Baseline captured: 2026-04-27. Total: 87 entries. The bar to add to
 * this list is "this gap is known and tracked elsewhere"; the bar to
 * leave it here long-term is "we have a deliberate reason not to
 * implement under the prescribed name".
 */
const KNOWN_GAPS: ReadonlyArray<string> = [
  // F4-005 (UC-11 / matcher) — these are the matcher's prescribed
  // adversarial set; matcher is partially implemented but the suite
  // hasn't landed under the prescribed names yet.
  'test_decomposer_extracts_years_and_must_haves', // ADR-029 follow-up: reconcile ADR-014 with UC-11
  'test_decomposer_extracts_min_years_from_numeric_prose',
  'test_decomposer_extracts_min_years_from_plus_notation',
  'test_decomposer_must_have_from_excluyente',
  'test_decomposer_must_have_false_from_deseable',
  'test_decomposer_ignores_years_when_absent',
  'test_decomposer_evidence_is_literal_substring',
  'test_decomposer_rejects_hallucinated_snippet',
  'test_decomposer_unresolved_skills_reported',
  'test_decomposer_cache_hit_skips_llm',
  'test_decomposer_cache_reresolves_when_catalog_changes',
  'test_decomposer_empty_input_no_llm_call',
  'test_decomposer_rls_denies_cross_user_on_private_flag',
  'test_education_excluded_from_years',
  'test_side_project_excluded_from_years',
  'test_side_project_only_candidate_passes_gate_with_low_score',
  'test_matcher_counts_only_work_experience',
  'test_matcher_decays_stale_experience',
  'test_matcher_deterministic_given_same_extraction',
  'test_matcher_empty_job_description_rejected',
  'test_matcher_excludes_candidates_missing_must_have',
  'test_matcher_respects_overlapping_experiences',
  'test_matcher_respects_rls',
  'test_matcher_returns_explainable_score',
  'test_pre_filter_excludes_candidates_without_musthave',
  'test_match_run_is_immutable',
  'test_match_run_rls_denies_cross_tenant',
  'test_keyword_matches_by_priority',
  'test_search_filters_before_vector',
  'test_search_rate_limits_embed',
  'test_semantic_aggregates_by_candidate',
  'test_semantic_only_no_structured_filters',

  // Skills catalog (F2 / ADR-007) — resolver lives in SQL+TS but
  // adversarial resolver suite hasn't landed under prescribed names.
  'test_resolver_alias_match',
  'test_resolver_deprecated_skill_not_matched',
  'test_resolver_exact_slug_match',
  'test_resolver_no_match_returns_null',
  'test_resolver_normalizes_casing_and_whitespace',
  'test_resolver_preserves_internal_punct',
  'test_sql_and_ts_resolvers_agree_on_fixture_set',
  'test_alias_global_uniqueness_enforced',
  'test_admin_only_can_insert_skill',
  'test_recruiter_can_read_skills_only',
  'test_blacklist_hides_entry_from_uncataloged_report',
  'test_uncataloged_report_groups_and_sorts_by_frequency',
  'test_reconcile_backfills_null_skill_ids',
  'test_reconcile_is_idempotent',
  'test_normalization_idempotent_by_attempt_timestamp',
  'test_no_match_sets_other_and_needs_review',

  // CV pipeline (ADR-006 / ADR-012 / ADR-029) — covered by integration
  // tests under different names; the prescribed adversarial unit
  // tests haven't been split out yet.
  'test_classifier_detects_linkedin_by_url',
  'test_classifier_falls_back_to_cv_primary_on_low_confidence',
  'test_cv_docx_parses_to_text',
  'test_cv_rejects_file_above_10mb',
  'test_cv_scanned_pdf_marked_likely_scanned',
  'test_cv_skips_reupload_when_hash_matches',
  'test_linkedin_parser_extracts_experiences_from_standard_layout',
  'test_llm_extractor_respects_json_schema',
  'test_llm_extractor_retries_on_invalid_json',
  'test_includes_file_with_no_prior_extraction', // covered by list-pending tests under "filters excluded files"
  'test_scopes_existing_query_by_model_and_prompt_version', // covered as "scopes the excluded lookup by model and prompt version"
  'test_raw_output_is_rls_admin_only',
  'test_worker_regenerates_on_prompt_version_bump',
  'test_worker_service_role_required',

  // Embeddings (ADR-005) — covered by integration tests under
  // different names; prescribed unit names not used.
  'test_embedding_hash_includes_model_name',
  'test_embedding_regenerated_when_content_changes',
  'test_embedding_skipped_when_hash_matches',
  'test_embedding_worker_idempotent',

  // ETL / sync (ADR-004) — covered by sync runner tests under
  // different names.
  'test_sync_fatal_error_preserves_last_synced_at',
  'test_sync_respects_rate_limit',
  'test_sync_row_error_does_not_stop_batch',
  'test_sync_stale_lock_is_reclaimed',
  'test_sync_upsert_is_idempotent',
  'test_add_candidate_twice_is_idempotent',

  // Shortlists / candidate profile (UC-04 / UC-05) — feature not yet
  // landed; prescribed tests will arrive with the feature.
  'test_admin_can_restore',
  'test_admin_soft_delete_hides_from_recruiter',
  'test_applications_of_soft_deleted_candidate_hidden_to_recruiter',
  'test_archived_shortlist_readonly_for_recruiter',
  'test_only_creator_or_admin_can_delete',
  'test_profile_respects_rls_soft_deleted',
  'test_profile_returns_aggregated_data',
  'test_recruiter_cannot_access_deleted_cv',
  'test_recruiter_cannot_soft_delete',
  'test_shortlist_creation_requires_name',
  'test_soft_delete_preserves_cv_in_storage',
  'test_signed_url_expires_in_one_hour',
  'test_signed_url_of_cv_is_one_hour',
  'test_signed_url_requires_auth',

  // Schema invariants — covered by SQL constraints rather than vitest.
  'test_job_queries_content_hash_unique',
];

interface ParseResult {
  /** name → set of source files where it was mentioned */
  prescribed: Map<string, Set<string>>;
  implemented: Set<string>;
}

function readDocFiles(): string[] {
  const out: string[] = [];
  for (const rel of DOC_FILES) {
    const abs = path.join(REPO_ROOT, rel);
    out.push(abs);
  }
  const adrAbs = path.join(REPO_ROOT, ADR_DIR);
  for (const entry of readdirSync(adrAbs)) {
    if (entry.endsWith('.md')) out.push(path.join(adrAbs, entry));
  }
  return out;
}

const SELF_DIR = path.resolve(REPO_ROOT, 'tests', 'spec-parity');

function walkTestFiles(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      // Skip node_modules, .next, dist, etc.
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') continue;
      // Skip self: this file embeds prescribed names as string
      // literals (KNOWN_GAPS), which would otherwise count as
      // "implemented" and defeat the whole check.
      if (path.resolve(abs) === SELF_DIR) continue;
      walkTestFiles(abs, acc);
    } else if (st.isFile() && abs.endsWith('.test.ts')) {
      acc.push(abs);
    }
  }
}

function parseRepository(): ParseResult {
  const prescribed = new Map<string, Set<string>>();
  for (const file of readDocFiles()) {
    const text = readFileSync(file, 'utf8');
    const matches = text.match(TEST_NAME_RE) ?? [];
    for (const name of matches) {
      const rel = path.relative(REPO_ROOT, file);
      const sources = prescribed.get(name) ?? new Set<string>();
      sources.add(rel);
      prescribed.set(name, sources);
    }
  }

  const testFiles: string[] = [];
  for (const dir of CODE_DIRS) {
    walkTestFiles(path.join(REPO_ROOT, dir), testFiles);
  }
  const implemented = new Set<string>();
  for (const file of testFiles) {
    const text = readFileSync(file, 'utf8');
    const matches = text.match(TEST_NAME_RE) ?? [];
    for (const name of matches) implemented.add(name);
  }

  return { prescribed, implemented };
}

describe('spec ↔ code parity (prescribed test names)', () => {
  const { prescribed, implemented } = parseRepository();
  const knownGaps = new Set(KNOWN_GAPS);

  it('every prescribed test name is either implemented or in KNOWN_GAPS', () => {
    const missing: Array<{ name: string; sources: string[] }> = [];
    for (const [name, sources] of prescribed) {
      if (implemented.has(name)) continue;
      if (knownGaps.has(name)) continue;
      missing.push({ name, sources: [...sources].sort() });
    }
    if (missing.length > 0) {
      const lines = missing.map((m) => `  - ${m.name}  (in ${m.sources.join(', ')})`);
      throw new Error(
        `Spec ↔ code parity violation: ${missing.length} prescribed test name(s) are not implemented and not in KNOWN_GAPS.\n` +
          'Either implement them under the prescribed name, or add them to KNOWN_GAPS with a one-line reason.\n\n' +
          lines.join('\n'),
      );
    }
  });

  it('KNOWN_GAPS contains no stale entries (names that ARE now implemented)', () => {
    const stale = KNOWN_GAPS.filter((name) => implemented.has(name));
    if (stale.length > 0) {
      throw new Error(
        `KNOWN_GAPS contains ${stale.length} stale entry/entries — these names are implemented in code, so they should be removed from the allowlist:\n` +
          stale.map((s) => `  - ${s}`).join('\n'),
      );
    }
  });

  it('KNOWN_GAPS contains no typos (names not actually prescribed in docs)', () => {
    const orphans = KNOWN_GAPS.filter((name) => !prescribed.has(name));
    if (orphans.length > 0) {
      throw new Error(
        `KNOWN_GAPS contains ${orphans.length} orphan entry/entries — these names are not mentioned in docs/, so they're either typos or refer to a prescription that was removed:\n` +
          orphans.map((s) => `  - ${s}`).join('\n'),
      );
    }
  });

  it('KNOWN_GAPS has no duplicates', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const name of KNOWN_GAPS) {
      if (seen.has(name)) dupes.push(name);
      seen.add(name);
    }
    expect(dupes).toEqual([]);
  });
});
