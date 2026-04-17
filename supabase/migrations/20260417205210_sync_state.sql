-- Migration: 008 — sync_state + seed
-- Depends on: 001
-- Ref: docs/data-model.md §14, ADR-004
-- Rollback: drop table if exists sync_state cascade;

create table sync_state (
  id                    uuid primary key default uuid_generate_v4(),
  entity                text unique not null,
  last_synced_at        timestamptz,
  last_cursor           text,
  last_run_started      timestamptz,
  last_run_finished     timestamptz,
  last_run_status       text check (last_run_status in ('idle', 'running', 'success', 'error')),
  last_run_error        text,
  records_synced        integer default 0,
  stale_timeout_minutes integer default 60,
  updated_at            timestamptz not null default now()
);

create trigger trg_sync_state_updated_at
  before update on sync_state
  for each row execute function set_updated_at();

insert into sync_state (entity, last_run_status) values
  ('stages',       'idle'),
  ('users',        'idle'),
  ('jobs',         'idle'),
  ('candidates',   'idle'),
  ('applications', 'idle'),
  ('evaluations',  'idle'),
  ('notes',        'idle'),
  ('files',        'idle')
on conflict (entity) do nothing;
