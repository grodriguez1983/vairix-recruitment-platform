-- Migration: 005 — jobs
-- Depends on: 001
-- Ref: docs/data-model.md §4
-- Rollback: drop table if exists jobs cascade;

create table jobs (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid,
  teamtailor_id  text unique not null,
  title          text not null,
  department     text,
  location       text,
  status         text check (status in ('open', 'draft', 'archived', 'unlisted')),
  pitch          text,
  body           text,
  raw_data       jsonb,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now()
);

create index idx_jobs_teamtailor_id on jobs(teamtailor_id);
create index idx_jobs_status        on jobs(status);
create index idx_jobs_updated_at    on jobs(updated_at desc);

create trigger trg_jobs_updated_at
  before update on jobs
  for each row execute function set_updated_at();
