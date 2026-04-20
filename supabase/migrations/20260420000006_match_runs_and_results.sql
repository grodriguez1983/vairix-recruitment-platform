-- Migration: match_runs + match_results (ADR-015 ranker persistence)
-- Depends on: 20260420000004_job_queries, 20260417205200_candidates
-- Ref: docs/adr/adr-015-matching-and-ranking.md §5, docs/data-model.md §16.9-§16.10, §17
-- Rollback:
--   drop trigger if exists trg_match_results_insert_only on match_results;
--   drop function if exists enforce_match_results_insert_only();
--   drop trigger if exists trg_match_runs_state on match_runs;
--   drop function if exists enforce_match_runs_state_machine();
--   drop table if exists match_results;
--   drop table if exists match_runs;

-- ────────────────────────────────────────────────────────────────
-- 1. match_runs
-- ────────────────────────────────────────────────────────────────
-- Inmutable post-close (ADR-015 §5): si el catálogo cambia, se
-- ejecuta un run nuevo. catalog_snapshot_at captura el instante
-- del catálogo usado por este run, para reproducir auditorías.
create table match_runs (
  id                    uuid primary key default uuid_generate_v4(),
  job_query_id          uuid not null references job_queries(id) on delete cascade,
  tenant_id             uuid,
  triggered_by          uuid references app_users(id) on delete set null,
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,
  status                text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  candidates_evaluated  integer,
  diagnostics           jsonb,
  catalog_snapshot_at   timestamptz not null,
  created_at            timestamptz not null default now()
);

create index idx_match_runs_job_query on match_runs(job_query_id);
create index idx_match_runs_tenant    on match_runs(tenant_id);
create index idx_match_runs_status    on match_runs(status);
create index idx_match_runs_triggered_by on match_runs(triggered_by);

-- ────────────────────────────────────────────────────────────────
-- 2. State machine trigger on match_runs
-- ────────────────────────────────────────────────────────────────
-- Enforces (data-model §17 invariants):
--   Identity frozen always: id, job_query_id, triggered_by,
--     started_at, catalog_snapshot_at, created_at.
--   Closed run (status != 'running') is fully frozen.
--   Only allowed transition: 'running' → ('completed' | 'failed'),
--     and closing REQUIRES finished_at to be stamped.
--   While 'running': candidates_evaluated, diagnostics, tenant_id
--     may be updated (incremental progress).
create or replace function enforce_match_runs_state_machine()
returns trigger
language plpgsql
as $$
begin
  -- Identity columns frozen regardless of status.
  if new.id is distinct from old.id then
    raise exception 'match_runs.id is immutable';
  end if;
  if new.job_query_id is distinct from old.job_query_id then
    raise exception 'match_runs.job_query_id is immutable';
  end if;
  if new.triggered_by is distinct from old.triggered_by then
    raise exception 'match_runs.triggered_by is immutable';
  end if;
  if new.started_at is distinct from old.started_at then
    raise exception 'match_runs.started_at is immutable';
  end if;
  if new.catalog_snapshot_at is distinct from old.catalog_snapshot_at then
    raise exception 'match_runs.catalog_snapshot_at is immutable';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'match_runs.created_at is immutable';
  end if;

  -- Status state machine.
  if old.status = 'running' then
    -- Still running: allow progress updates, or a close.
    if new.status = 'running' then
      -- Valid progress update; nothing to check.
      null;
    elsif new.status in ('completed', 'failed') then
      -- Closing requires finished_at.
      if new.finished_at is null then
        raise exception 'closing match_run requires finished_at to be stamped';
      end if;
    else
      -- Defensive; the CHECK constraint already blocks other values.
      raise exception 'invalid match_run status transition from running';
    end if;
  else
    -- Already closed: no field may change (including finished_at,
    -- candidates_evaluated, diagnostics, status).
    if new.status is distinct from old.status then
      raise exception 'match_runs.status is frozen after close';
    end if;
    if new.finished_at is distinct from old.finished_at then
      raise exception 'match_runs.finished_at is frozen after close';
    end if;
    if new.candidates_evaluated is distinct from old.candidates_evaluated then
      raise exception 'match_runs.candidates_evaluated is frozen after close';
    end if;
    if new.diagnostics is distinct from old.diagnostics then
      raise exception 'match_runs.diagnostics is frozen after close';
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_match_runs_state
  before update on match_runs
  for each row execute function enforce_match_runs_state_machine();

-- ────────────────────────────────────────────────────────────────
-- 3. match_results
-- ────────────────────────────────────────────────────────────────
-- Composite PK (match_run_id, candidate_id): one result per
-- candidate per run. tenant_id duplicated intentionally (data-model
-- §16.10) to avoid joining match_runs in RLS at query time.
-- No `id` column — the composite is the identity.
create table match_results (
  match_run_id     uuid not null references match_runs(id) on delete cascade,
  candidate_id     uuid not null references candidates(id) on delete cascade,
  tenant_id        uuid,
  total_score      numeric(5, 2) not null,
  must_have_gate   text not null check (must_have_gate in ('passed', 'failed')),
  rank             integer not null,
  breakdown_json   jsonb not null,
  primary key (match_run_id, candidate_id)
);

create index idx_match_results_run_rank on match_results(match_run_id, rank);
create index idx_match_results_candidate on match_results(candidate_id);
create index idx_match_results_tenant    on match_results(tenant_id);

-- ────────────────────────────────────────────────────────────────
-- 4. Insert-only trigger on match_results
-- ────────────────────────────────────────────────────────────────
-- match_results are insert-only (ADR-015 §5 + data-model §17):
-- breakdown_json inmutable, and by extension total_score, rank and
-- must_have_gate — they are the crystallized output of the ranker
-- for a (run, candidate) tuple. Any correction is a new run.
-- RLS already omits an UPDATE policy; this trigger blocks service
-- role too.
create or replace function enforce_match_results_insert_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'match_results rows are insert-only (ADR-015 §5)';
end;
$$;

create trigger trg_match_results_insert_only
  before update on match_results
  for each row execute function enforce_match_results_insert_only();
