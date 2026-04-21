-- Migration: RLS policies for candidate_languages
-- Depends on: 20260421000002_candidate_languages
-- Ref: docs/data-model.md §17, docs/adr/adr-003-auth-roles-rls.md
-- Matrix:
--   candidate_languages : recruiter R | admin R/W
--
-- Mirrors candidate_experiences RLS: recruiters read (matching ranker
-- reads via RLS-scoped client per ADR-017), admins write (derivation
-- runs under admin or service-role per ADR-003 §ETL).

alter table candidate_languages enable row level security;
alter table candidate_languages force row level security;

create policy "candidate_languages_read_all_authenticated"
  on candidate_languages for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "candidate_languages_admin_insert"
  on candidate_languages for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "candidate_languages_admin_update"
  on candidate_languages for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "candidate_languages_admin_delete"
  on candidate_languages for delete
  to authenticated
  using (public.current_app_role() = 'admin');
