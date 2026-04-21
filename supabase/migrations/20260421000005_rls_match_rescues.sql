-- Migration: RLS policies for match_rescues
-- Depends on: 20260421000004_match_rescues
-- Ref: docs/adr/adr-016-complementary-signals.md §1,
--      docs/adr/adr-017-match-results-insert-ownership.md
-- Matrix:
--   match_rescues : recruiter R (own run) / W (own run) | admin R/W
--                   UPDATE blocked by insert-only trigger; no policy needed.
--                   DELETE admin-only (audit trail parity with match_results).
--
-- Mirrors match_results policies (post-ADR-017): the recruiter who
-- triggered the parent run may insert + read its rescue rows, so the
-- synchronous runMatchJob orchestrator can persist rescues under the
-- user's client (no service-role in user-triggered routes, CLAUDE.md #4).

alter table match_rescues enable row level security;
alter table match_rescues force  row level security;

-- SELECT — visible iff the parent run is visible.
create policy "match_rescues_select_via_run"
  on match_rescues for select
  to authenticated
  using (
    public.current_app_role() = 'admin'
    or exists (
      select 1
      from match_runs mr
      where mr.id = match_rescues.match_run_id
        and mr.triggered_by = public.current_app_user_id()
    )
  );

-- INSERT — admin, or the recruiter who owns the parent run.
create policy "match_rescues_insert_own_run_or_admin"
  on match_rescues for insert
  to authenticated
  with check (
    public.current_app_role() = 'admin'
    or exists (
      select 1
      from match_runs mr
      where mr.id = match_rescues.match_run_id
        and mr.triggered_by = public.current_app_user_id()
    )
  );

-- DELETE — admin-only (audit trail).
create policy "match_rescues_admin_delete"
  on match_rescues for delete
  to authenticated
  using (public.current_app_role() = 'admin');

-- NOTE: no UPDATE policy. The insert-only trigger freezes rows.
