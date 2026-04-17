-- Migration: 015 — applications
-- Depends on: candidates, jobs, stages
-- Ref: docs/data-model.md §6
-- Rollback: drop table if exists applications cascade;

create table applications (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid,
  teamtailor_id  text unique not null,
  candidate_id   uuid not null references candidates(id) on delete cascade,
  job_id         uuid references jobs(id) on delete set null,
  stage_id       uuid references stages(id) on delete set null,
  stage_name     text,
  status         text check (status in ('active','rejected','hired','withdrawn')),
  source         text,
  cover_letter   text,
  rejected_at    timestamptz,
  hired_at       timestamptz,
  raw_data       jsonb,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now()
);

create index idx_applications_candidate on applications(candidate_id);
create index idx_applications_job       on applications(job_id);
create index idx_applications_stage     on applications(stage_id);
create index idx_applications_status    on applications(status);
create index idx_applications_updated   on applications(updated_at desc);

create trigger trg_applications_updated_at
  before update on applications
  for each row execute function set_updated_at();
