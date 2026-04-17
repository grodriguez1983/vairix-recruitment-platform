-- Migration: 017 — notes (Teamtailor free-form)
-- Depends on: candidates, applications, users
-- Ref: docs/data-model.md §9
-- Rollback: drop table if exists notes cascade;

create table notes (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid,
  teamtailor_id  text unique,
  candidate_id   uuid not null references candidates(id) on delete cascade,
  application_id uuid references applications(id) on delete set null,
  user_id        uuid references users(id) on delete set null,
  author_name    text,
  body           text not null,
  raw_data       jsonb,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now()
);

create index idx_notes_candidate   on notes(candidate_id);
create index idx_notes_application on notes(application_id);
create index idx_notes_body_trgm   on notes using gin (body gin_trgm_ops);

create trigger trg_notes_updated_at
  before update on notes
  for each row execute function set_updated_at();
