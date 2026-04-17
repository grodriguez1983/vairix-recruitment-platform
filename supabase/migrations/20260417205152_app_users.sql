-- Migration: 002 — app_users table
-- Depends on: 001 (uuid-ossp, set_updated_at)
-- Ref: docs/data-model.md §1, ADR-003 §4
-- Scope: internal app user table. Links Supabase auth.users to an
--        app-level role (recruiter | admin). NOT the same as `users`
--        (evaluators synced from Teamtailor).
--
-- Rollback (destructive):
--   drop table if exists app_users cascade;

create table app_users (
  id             uuid primary key default uuid_generate_v4(),
  auth_user_id   uuid unique not null references auth.users(id) on delete cascade,
  email          text not null,
  full_name      text,
  role           text not null check (role in ('recruiter', 'admin')),
  tenant_id      uuid,
  deactivated_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index idx_app_users_auth_user on app_users(auth_user_id);
create index idx_app_users_role      on app_users(role);

create trigger trg_app_users_updated_at
  before update on app_users
  for each row execute function set_updated_at();

comment on table app_users is
  'Internal app users (VAIRIX employees with platform access). Links auth.users to an app role. See ADR-003 §4.';
comment on column app_users.role is
  'App role: recruiter (limited) | admin (full). Source of truth for RLS (see current_app_role()).';
