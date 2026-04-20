-- Migration: RLS policies for job_queries
-- Depends on: 20260420000004_job_queries
-- Ref: docs/data-model.md §17, docs/adr/adr-003-auth-roles-rls.md,
--      docs/adr/adr-014-job-description-decomposition.md
-- Matrix:
--   job_queries : recruiter R/W own | admin R/W all
--   DELETE is admin-only regardless of ownership (preserves audit/cache).

alter table job_queries enable row level security;
alter table job_queries force row level security;

-- ────────────────────────────────────────────────────────────────
-- SELECT: own rows (recruiter) or all (admin)
-- ────────────────────────────────────────────────────────────────
create policy "job_queries_select_own_or_admin"
  on job_queries for select
  to authenticated
  using (
    public.current_app_role() = 'admin'
    or (public.current_app_role() = 'recruiter' and created_by = public.current_app_user_id())
  );

-- ────────────────────────────────────────────────────────────────
-- INSERT: recruiter can insert only with created_by = self; admin free
-- ────────────────────────────────────────────────────────────────
-- created_by IS NULL allowed only for admin (service-role bypasses RLS
-- altogether, so backend jobs are unaffected). A recruiter forging
-- another user's id is blocked because the check compares to the
-- SECURITY DEFINER lookup of the caller's own app_users.id.
create policy "job_queries_insert_own_or_admin"
  on job_queries for insert
  to authenticated
  with check (
    public.current_app_role() = 'admin'
    or (
      public.current_app_role() = 'recruiter'
      and created_by = public.current_app_user_id()
    )
  );

-- ────────────────────────────────────────────────────────────────
-- UPDATE: recruiter may update own rows (trigger blocks immutable
-- columns); admin may update any row.
-- ────────────────────────────────────────────────────────────────
-- The policy allows the UPDATE at row level; column-level
-- protection for decomposed_json, content_hash, etc. lives in the
-- enforce_job_queries_immutability trigger (DB-level invariant,
-- not bypassable by service role).
create policy "job_queries_update_own_or_admin"
  on job_queries for update
  to authenticated
  using (
    public.current_app_role() = 'admin'
    or (public.current_app_role() = 'recruiter' and created_by = public.current_app_user_id())
  )
  with check (
    public.current_app_role() = 'admin'
    or (public.current_app_role() = 'recruiter' and created_by = public.current_app_user_id())
  );

-- ────────────────────────────────────────────────────────────────
-- DELETE: admin-only (preserves the cache + audit trail).
-- ────────────────────────────────────────────────────────────────
create policy "job_queries_admin_delete"
  on job_queries for delete
  to authenticated
  using (public.current_app_role() = 'admin');
