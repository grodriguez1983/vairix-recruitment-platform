-- Migration: 004 — users (Teamtailor evaluators, NOT app_users)
-- Depends on: 001
-- Ref: docs/data-model.md §3
-- Rollback: drop table if exists users cascade;

create table users (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid,
  teamtailor_id  text unique not null,
  email          text,
  full_name      text,
  role           text,
  active         boolean default true,
  raw_data       jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now()
);

create index idx_users_teamtailor_id on users(teamtailor_id);
create index idx_users_email         on users(email);

create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();

comment on table users is
  'Teamtailor evaluators (not platform users — see app_users for that).';
