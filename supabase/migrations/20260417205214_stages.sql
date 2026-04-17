-- Migration: 010 — stages
-- Depends on: 001 (extensions), jobs
-- Ref: docs/data-model.md §5
-- Rollback: drop table if exists stages cascade;

create table stages (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid,
  teamtailor_id  text unique not null,
  job_id         uuid references jobs(id) on delete cascade,
  name           text not null,
  slug           text,
  position       integer,
  category       text,
  raw_data       jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now()
);

create index idx_stages_job           on stages(job_id);
create index idx_stages_teamtailor_id on stages(teamtailor_id);

create trigger trg_stages_updated_at
  before update on stages
  for each row execute function set_updated_at();
