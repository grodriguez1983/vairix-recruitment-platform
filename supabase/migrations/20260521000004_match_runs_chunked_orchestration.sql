-- ADR-034 — Schema changes for FE-driven chunked matching.
--
-- The matching pipeline shifts from one synchronous request to a
-- FE-driven loop calling `/start`, `/process-chunk` (N times) and
-- `/finalize`. The backend stores no in-flight state beyond the
-- `match_runs` row itself, so the row gains three counters and a
-- new terminal status.
--
-- Changes (all additive on `match_runs`; one index swap on
-- `match_results`):
--
--   1. `expected_count`     — pool size after preFilter; set by /start.
--   2. `processed_count`    — incremented by each /process-chunk.
--   3. `last_progress_at`   — heartbeat for the abandoned-run cleanup.
--   4. Status `'abandoned'` — new terminal value; reached either by
--      explicit FE cancel or by a cleanup pass that detects stale runs.
--   5. State-machine trigger updated to:
--        - allow `'running' → 'abandoned'`,
--        - freeze the three new counters post-close (same posture as
--          `candidates_evaluated` and `diagnostics`, ADR-015 §5).
--   6. Index `idx_match_results_run_rank` swapped for one ordered by
--      `total_score desc`. Per ADR-034, the persisted `rank` column is
--      now chunk-local (provisional) and reads order by score. The
--      old index by `rank` no longer matches the read pattern.
--
-- Backwards-compat: closed runs (`completed`, `failed`) created before
-- this migration get `processed_count = 0` and `expected_count = null`
-- by column defaults. They are terminal and never read these fields,
-- so the "wrong" values are inert.
--
-- Rollback:
--   alter table match_runs
--     drop column if exists last_progress_at,
--     drop column if exists processed_count,
--     drop column if exists expected_count;
--   alter table match_runs drop constraint match_runs_status_check;
--   alter table match_runs add constraint match_runs_status_check
--     check (status in ('running', 'completed', 'failed'));
--   -- Re-create the original trigger body from 20260420000006.
--   drop index if exists idx_match_results_run_score;
--   create index idx_match_results_run_rank
--     on match_results(match_run_id, rank);

-- ────────────────────────────────────────────────────────────────
-- 1. Counters + heartbeat on match_runs
-- ────────────────────────────────────────────────────────────────
alter table match_runs
  add column expected_count   integer,
  add column processed_count  integer not null default 0,
  add column last_progress_at timestamptz;

-- ────────────────────────────────────────────────────────────────
-- 2. Allow 'abandoned' as a terminal status
-- ────────────────────────────────────────────────────────────────
alter table match_runs drop constraint match_runs_status_check;
alter table match_runs add constraint match_runs_status_check
  check (status in ('running', 'completed', 'failed', 'abandoned'));

-- ────────────────────────────────────────────────────────────────
-- 3. State-machine trigger — extend for 'abandoned' + freeze counters
-- ────────────────────────────────────────────────────────────────
-- Diff vs 20260420000006:
--   - `running → abandoned` is a valid close (same finished_at rule).
--   - Post-close freeze now covers expected_count, processed_count,
--     last_progress_at — matches the existing freeze on
--     candidates_evaluated and diagnostics (ADR-015 §5).
--   - During 'running', the three new columns may be updated freely
--     by /process-chunk; the trigger only enforces the freeze on
--     terminal rows.
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
    if new.status = 'running' then
      -- Valid progress update; no further checks. /process-chunk
      -- bumps expected_count/processed_count/last_progress_at.
      null;
    elsif new.status in ('completed', 'failed', 'abandoned') then
      -- Closing requires finished_at, regardless of which terminal.
      if new.finished_at is null then
        raise exception 'closing match_run requires finished_at to be stamped';
      end if;
    else
      raise exception 'invalid match_run status transition from running';
    end if;
  else
    -- Already closed: no field may change.
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
    if new.expected_count is distinct from old.expected_count then
      raise exception 'match_runs.expected_count is frozen after close';
    end if;
    if new.processed_count is distinct from old.processed_count then
      raise exception 'match_runs.processed_count is frozen after close';
    end if;
    if new.last_progress_at is distinct from old.last_progress_at then
      raise exception 'match_runs.last_progress_at is frozen after close';
    end if;
  end if;

  return new;
end;
$$;

-- ────────────────────────────────────────────────────────────────
-- 4. Swap read index on match_results — order by total_score
-- ────────────────────────────────────────────────────────────────
-- Per ADR-034 §"Lo que el ADR no resolvió bien" + Opción 1:
--   `match_results.rank` keeps `not null` (insert-only trigger from
--   20260420000006 §4 stays), but its value is now chunk-local: the
--   ranker assigns 1..N within a single /process-chunk call. The
--   global ordering is reconstructed at read time with
--   `ORDER BY total_score DESC`. The previous index
--   `(match_run_id, rank)` no longer matches that read pattern.
drop index if exists idx_match_results_run_rank;
create index idx_match_results_run_score
  on match_results(match_run_id, total_score desc);
