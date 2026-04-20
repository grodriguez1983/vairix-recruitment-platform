-- Migration: RLS policies for match_runs + match_results
-- Depends on: 20260420000006_match_runs_and_results
-- Ref: docs/data-model.md §17, docs/adr/adr-003-auth-roles-rls.md,
--      docs/adr/adr-015-matching-and-ranking.md §5
-- Matrix:
--   match_runs    : recruiter R/W own (triggered_by) | admin R/W all | DELETE admin-only
--   match_results : recruiter R scoped via parent run | admin R/W   | INSERT admin-only
--                   (recruiters trigger runs via service role in the
--                    match worker; UI does not insert results directly).
--                   NO UPDATE policy — combined with the insert-only
--                   trigger, results are frozen once written.

alter table match_runs    enable row level security;
alter table match_runs    force  row level security;
alter table match_results enable row level security;
alter table match_results force  row level security;

-- ────────────────────────────────────────────────────────────────
-- match_runs: SELECT
-- ────────────────────────────────────────────────────────────────
-- Recruiter sees only their own runs (triggered_by = self). Admin
-- sees everything.
create policy "match_runs_select_own_or_admin"
  on match_runs for select
  to authenticated
  using (
    public.current_app_role() = 'admin'
    or (public.current_app_role() = 'recruiter' and triggered_by = public.current_app_user_id())
  );

-- ────────────────────────────────────────────────────────────────
-- match_runs: INSERT
-- ────────────────────────────────────────────────────────────────
-- Recruiter may only create runs attributed to themselves
-- (triggered_by = self). Admin may create anything.
create policy "match_runs_insert_own_or_admin"
  on match_runs for insert
  to authenticated
  with check (
    public.current_app_role() = 'admin'
    or (
      public.current_app_role() = 'recruiter'
      and triggered_by = public.current_app_user_id()
    )
  );

-- ────────────────────────────────────────────────────────────────
-- match_runs: UPDATE
-- ────────────────────────────────────────────────────────────────
-- Row-level allows own-or-admin; the state-machine trigger (migration
-- 000006) gates which columns may actually change and enforces the
-- status transitions. We keep both layers: RLS scopes who, trigger
-- scopes what.
create policy "match_runs_update_own_or_admin"
  on match_runs for update
  to authenticated
  using (
    public.current_app_role() = 'admin'
    or (public.current_app_role() = 'recruiter' and triggered_by = public.current_app_user_id())
  )
  with check (
    public.current_app_role() = 'admin'
    or (public.current_app_role() = 'recruiter' and triggered_by = public.current_app_user_id())
  );

-- ────────────────────────────────────────────────────────────────
-- match_runs: DELETE (admin-only — preserves audit trail)
-- ────────────────────────────────────────────────────────────────
create policy "match_runs_admin_delete"
  on match_runs for delete
  to authenticated
  using (public.current_app_role() = 'admin');

-- ────────────────────────────────────────────────────────────────
-- match_results: SELECT
-- ────────────────────────────────────────────────────────────────
-- A result is visible iff the parent run is visible. Admin sees
-- everything; recruiter sees only rows whose run they triggered.
-- tenant_id is duplicated on the row (data-model §16.10) precisely to
-- avoid this join when we later add tenant scoping — for now the
-- ownership check still has to traverse match_runs.
create policy "match_results_select_via_run"
  on match_results for select
  to authenticated
  using (
    public.current_app_role() = 'admin'
    or exists (
      select 1
      from match_runs mr
      where mr.id = match_results.match_run_id
        and mr.triggered_by = public.current_app_user_id()
    )
  );

-- ────────────────────────────────────────────────────────────────
-- match_results: INSERT (admin-only from the user client)
-- ────────────────────────────────────────────────────────────────
-- Ranker output is written by the backend worker with service role
-- (which bypasses RLS). We do NOT grant recruiters insert rights:
-- there is no legitimate UI path that writes match_results. Admin
-- may insert manually (e.g., backfill, forensic replay).
create policy "match_results_admin_insert"
  on match_results for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

-- ────────────────────────────────────────────────────────────────
-- match_results: DELETE (admin-only)
-- ────────────────────────────────────────────────────────────────
-- Parent match_run delete cascades; manual cleanup is admin-only.
create policy "match_results_admin_delete"
  on match_results for delete
  to authenticated
  using (public.current_app_role() = 'admin');

-- NOTE: no UPDATE policy is defined on match_results. Combined with
-- the `enforce_match_results_insert_only` trigger, rows are frozen
-- once written — even the service role cannot rewrite them.
