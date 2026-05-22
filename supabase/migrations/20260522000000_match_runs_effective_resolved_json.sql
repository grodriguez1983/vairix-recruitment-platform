-- ADR-035 — Snapshot del ResolvedDecomposition efectivamente usado por el run.
--
-- El recruiter puede editar el set de requirements decompuesto por el LLM
-- antes de ejecutar el match (eliminar requirements, ajustar min_years,
-- destildar must_have). Ese override viaja en el body de
-- /api/matching/run/start y se persiste acá como snapshot inmutable.
--
-- Por qué snapshot y no PATCH a job_queries.resolved_json: job_queries
-- está cacheado por content_hash compartido entre recruiters. Mutar
-- resolved_json poluye el cache cross-user. Snapshot por run preserva
-- el cache y deja el run autocontenido para auditoría (ADR-015 §5).
--
-- Backwards-compat: runs históricos quedan con effective_resolved_json
-- = null. Los consumers (UI de runs, /process-chunk, /finalize) caen a
-- job_queries.resolved_json cuando es null. Inerte para runs cerrados.
--
-- Rollback:
--   -- Restaurar el cuerpo del trigger desde 20260521000004 (sin la
--   -- línea que freeza effective_resolved_json), luego:
--   alter table match_runs drop column if exists effective_resolved_json;

-- ────────────────────────────────────────────────────────────────
-- 1. Columna jsonb nullable para el snapshot.
-- ────────────────────────────────────────────────────────────────
alter table match_runs
  add column effective_resolved_json jsonb;

comment on column match_runs.effective_resolved_json is
  'ADR-035: snapshot del ResolvedDecomposition efectivamente usado '
  'por este run (override del recruiter o copia de '
  'job_queries.resolved_json). null = run legacy pre-ADR-035, los '
  'consumers caen a job_queries.resolved_json.';

-- ────────────────────────────────────────────────────────────────
-- 2. State-machine trigger — freezar effective_resolved_json siempre.
-- ────────────────────────────────────────────────────────────────
-- Diff vs 20260521000004:
--   - effective_resolved_json se sella al crear el run y nunca cambia
--     (es identity, igual que id/job_query_id/started_at/etc.).
--   - El check va en la sección de identity columns (bloquea aunque
--     el run siga en 'running'), no solo en el post-close.
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
  -- ADR-035: snapshot del resolved efectivo. Identidad del run; nunca
  -- cambia post-insert.
  if new.effective_resolved_json is distinct from old.effective_resolved_json then
    raise exception 'match_runs.effective_resolved_json is immutable (ADR-035)';
  end if;

  -- Status state machine.
  if old.status = 'running' then
    if new.status = 'running' then
      null;
    elsif new.status in ('completed', 'failed', 'abandoned') then
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
