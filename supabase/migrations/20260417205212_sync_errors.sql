-- Migration: 009 — sync_errors
-- Depends on: 001
-- Ref: docs/data-model.md §15
-- Rollback: drop table if exists sync_errors cascade;

create table sync_errors (
  id             uuid primary key default uuid_generate_v4(),
  entity         text not null,
  teamtailor_id  text,
  error_code     text,
  error_message  text,
  payload        jsonb,
  run_started_at timestamptz not null,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index idx_sync_errors_entity     on sync_errors(entity);
create index idx_sync_errors_unresolved on sync_errors(resolved_at)
  where resolved_at is null;
