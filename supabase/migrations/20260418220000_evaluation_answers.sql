-- Migration: evaluation_answers — scorecard/custom Q&A per interview
-- Depends on: 20260417205226_evaluations
-- Ref: docs/data-model.md §8, docs/adr/adr-010-teamtailor-custom-fields.md (sideload pattern)
-- Rollback: drop table if exists evaluation_answers cascade;
--
-- Context:
--   Teamtailor `/v1/interviews` exposes a free-text `note` plus a
--   collection of `answers` (each bound to a `question`). Questions
--   include both built-in ones (Seniority, Autonomía, Comunicación
--   técnica ...) and tenant-custom ones (e.g. "Información para CV"
--   which stores a Google Sheets URL, question_tt_id=24016 at VAIRIX).
--
--   We don't want to bake tenant-specific question IDs into columns.
--   The typed value columns (value_text, value_range, ...) cover every
--   TT question-type, and callers look up by question_tt_id when they
--   need a specific answer.
--
-- Scope: one row per (evaluation, question_tt_id). raw_data keeps the
--   original JSON:API answer resource for debug/replay.

create table evaluation_answers (
  id                   uuid primary key default uuid_generate_v4(),
  tenant_id            uuid,
  evaluation_id        uuid not null references evaluations(id) on delete cascade,
  teamtailor_answer_id text unique not null,
  question_tt_id       text not null,
  question_title       text,
  question_type        text,
  value_text           text,
  value_number         numeric,
  value_boolean        boolean,
  value_date           date,
  value_range          numeric,
  raw_data             jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  synced_at            timestamptz not null default now(),
  unique (evaluation_id, question_tt_id)
);

create index idx_eval_answers_evaluation   on evaluation_answers(evaluation_id);
create index idx_eval_answers_question     on evaluation_answers(question_tt_id);
create index idx_eval_answers_value_text   on evaluation_answers
  using gin (value_text gin_trgm_ops) where value_text is not null;

create trigger trg_eval_answers_updated_at
  before update on evaluation_answers
  for each row execute function set_updated_at();
