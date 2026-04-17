-- Migration: 014 — shortlists + shortlist_candidates
-- Depends on: app_users, jobs, candidates
-- Ref: docs/data-model.md §12, docs/spec.md §2.4
-- Rollback: drop table if exists shortlist_candidates cascade;
--           drop table if exists shortlists cascade;

create table shortlists (
  id          uuid primary key default uuid_generate_v4(),
  tenant_id   uuid,
  name        text not null,
  description text,
  created_by  uuid not null references app_users(id) on delete restrict,
  job_id      uuid references jobs(id) on delete set null,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_shortlists_created_by on shortlists(created_by);
create index idx_shortlists_job        on shortlists(job_id);

create trigger trg_shortlists_updated_at
  before update on shortlists
  for each row execute function set_updated_at();

create table shortlist_candidates (
  shortlist_id uuid not null references shortlists(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  added_by     uuid not null references app_users(id) on delete restrict,
  note         text,
  added_at     timestamptz not null default now(),
  primary key (shortlist_id, candidate_id)
);
