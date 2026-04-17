-- Migration: 002b — RLS policies for app_users + current_app_role() helper
-- Depends on: 20260417205152_app_users
-- Ref: ADR-003 §5, docs/data-model.md §16
-- Scope: enable RLS on app_users, install the canonical role lookup
--        function used by every other RLS policy in the system, and
--        restrict app_users to admin-only access.
--
-- Design note (divergence from ADR-003 §5):
--   ADR-003 §5 proposed reading the role from a custom JWT claim
--   (`auth.jwt() ->> 'role'`). That conflicts with Supabase's native
--   `role` claim (which carries the Postgres role, not the app role)
--   and requires configuring a JWT hook in supabase/config.toml.
--   We implement the same intent — app_users.role as source of truth —
--   via a SECURITY DEFINER function `public.current_app_role()` that
--   does the lookup by auth.uid(). Policies reference that function.
--   If a JWT hook is configured later, we can inline the claim read
--   without changing any policy definitions.
--
-- Rollback:
--   drop function if exists public.current_app_role() cascade;
--   -- policies drop with the table.

-- 1. Helper function. Stable + security definer so it can read app_users
--    regardless of the caller's RLS view.
create or replace function public.current_app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role
  from app_users
  where auth_user_id = auth.uid()
    and deactivated_at is null
  limit 1
$$;

comment on function public.current_app_role() is
  'Returns the app_users.role for the currently authenticated user, or null. Used by every RLS policy to resolve authorization. See ADR-003 §5.';

revoke all on function public.current_app_role() from public;
grant execute on function public.current_app_role() to authenticated, anon;

-- 2. Enable RLS. Force RLS ensures even the table owner is subject to
--    policies — the service role still bypasses via its dedicated role.
alter table app_users enable row level security;
alter table app_users force row level security;

-- 3. Policies. app_users is admin-only. No recruiter access, not even
--    to their own row (avoids leaking org structure / other roles).

create policy "app_users_admin_select"
  on app_users for select
  to authenticated
  using (public.current_app_role() = 'admin');

create policy "app_users_admin_insert"
  on app_users for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "app_users_admin_update"
  on app_users for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "app_users_admin_delete"
  on app_users for delete
  to authenticated
  using (public.current_app_role() = 'admin');
