-- Migration: match_results INSERT opens to the recruiter who owns the parent run.
-- Depends on: 20260420000007_rls_match_runs_and_results
-- Ref: docs/adr/adr-017-match-results-insert-ownership.md
-- Rollback:
--   drop policy if exists "match_results_insert_own_run_or_admin" on match_results;
--   create policy "match_results_admin_insert"
--     on match_results for insert
--     to authenticated
--     with check (public.current_app_role() = 'admin');

-- ────────────────────────────────────────────────────────────────
-- Why
-- ────────────────────────────────────────────────────────────────
-- ADR-017: F4-008 persists match_results during a recruiter-triggered
-- HTTP request. There is no async worker in F1, and CLAUDE.md #4
-- prohibits using the service role key in routes triggered by users.
-- The cleanest solution is to let the recruiter who owns the parent
-- match_run insert results for that run. Admin preserves its ability
-- to insert (manual backfill / forensic replay).
--
-- Immutability (ADR-015 §5) is untouched: no UPDATE policy exists on
-- match_results and `enforce_match_results_insert_only` (migration
-- 20260420000006) blocks any UPDATE — even with the service role.

drop policy if exists "match_results_admin_insert" on match_results;

create policy "match_results_insert_own_run_or_admin"
  on match_results for insert
  to authenticated
  with check (
    public.current_app_role() = 'admin'
    or exists (
      select 1
      from match_runs mr
      where mr.id = match_results.match_run_id
        and mr.triggered_by = public.current_app_user_id()
    )
  );
