-- Migration: match_rescues table (ADR-016 §1 — FTS recall-fallback bucket).
-- Depends on: 20260420000006_match_runs_and_results
-- Ref: docs/adr/adr-016-complementary-signals.md §1, §Notas de implementación
-- Rollback:
--   drop trigger if exists trg_match_rescues_insert_only on match_rescues;
--   drop function if exists enforce_match_rescues_insert_only();
--   drop table if exists match_rescues;

-- ────────────────────────────────────────────────────────────────
-- Why
-- ────────────────────────────────────────────────────────────────
-- ADR-016 §1: candidates failing the must_have gate are scanned via
-- FTS over files.parsed_text for the missing skill slugs. Hits above
-- FTS_RESCUE_THRESHOLD land in this bucket as `requires_manual_review`
-- evidence. It is NOT another ranking — total_score / rank remain
-- untouched. The bucket decays as the extractor improves.
--
-- Composite PK (match_run_id, candidate_id) — one rescue row per
-- candidate per run, parallel to match_results. tenant_id duplicated
-- (data-model §17 hedge, ADR-003) to avoid joining match_runs in RLS.

create table match_rescues (
  match_run_id    uuid not null references match_runs(id) on delete cascade,
  candidate_id    uuid not null references candidates(id) on delete cascade,
  tenant_id       uuid,
  missing_skills  text[] not null,
  fts_snippets    jsonb not null,
  fts_max_rank    numeric(6, 4) not null,
  created_at      timestamptz not null default now(),
  primary key (match_run_id, candidate_id)
);

create index idx_match_rescues_run       on match_rescues(match_run_id);
create index idx_match_rescues_candidate on match_rescues(candidate_id);
create index idx_match_rescues_tenant    on match_rescues(tenant_id);

-- ────────────────────────────────────────────────────────────────
-- Insert-only trigger
-- ────────────────────────────────────────────────────────────────
-- Rescue rows are derived from the same snapshot as match_results;
-- they are frozen post-insert just like match_results (ADR-015 §5 by
-- analogy). Any correction is a new run.
create or replace function enforce_match_rescues_insert_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'match_rescues rows are insert-only (ADR-016 §1)';
end;
$$;

create trigger trg_match_rescues_insert_only
  before update on match_rescues
  for each row execute function enforce_match_rescues_insert_only();
