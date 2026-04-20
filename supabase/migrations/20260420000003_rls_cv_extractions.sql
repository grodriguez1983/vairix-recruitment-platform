-- Migration: RLS policies for candidate_extractions, candidate_experiences, experience_skills
-- Depends on: 20260420000002_cv_extractions
-- Ref: docs/data-model.md §17, docs/adr/adr-003-auth-roles-rls.md
-- Matrix:
--   candidate_extractions  : recruiter R  | admin R/W
--   candidate_experiences  : recruiter R  | admin R/W
--   experience_skills      : recruiter R  | admin R/W

-- ────────────────────────────────────────────────────────────────
-- candidate_extractions
-- ────────────────────────────────────────────────────────────────
alter table candidate_extractions enable row level security;
alter table candidate_extractions force row level security;

create policy "candidate_extractions_read_all_authenticated"
  on candidate_extractions for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "candidate_extractions_admin_insert"
  on candidate_extractions for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "candidate_extractions_admin_update"
  on candidate_extractions for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "candidate_extractions_admin_delete"
  on candidate_extractions for delete
  to authenticated
  using (public.current_app_role() = 'admin');

-- ────────────────────────────────────────────────────────────────
-- candidate_experiences
-- ────────────────────────────────────────────────────────────────
alter table candidate_experiences enable row level security;
alter table candidate_experiences force row level security;

create policy "candidate_experiences_read_all_authenticated"
  on candidate_experiences for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "candidate_experiences_admin_insert"
  on candidate_experiences for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "candidate_experiences_admin_update"
  on candidate_experiences for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "candidate_experiences_admin_delete"
  on candidate_experiences for delete
  to authenticated
  using (public.current_app_role() = 'admin');

-- ────────────────────────────────────────────────────────────────
-- experience_skills
-- ────────────────────────────────────────────────────────────────
alter table experience_skills enable row level security;
alter table experience_skills force row level security;

create policy "experience_skills_read_all_authenticated"
  on experience_skills for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "experience_skills_admin_insert"
  on experience_skills for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "experience_skills_admin_update"
  on experience_skills for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "experience_skills_admin_delete"
  on experience_skills for delete
  to authenticated
  using (public.current_app_role() = 'admin');
