-- Migration: RLS policies for skills, skill_aliases, skills_blacklist
-- Depends on: 20260420000000_skills_catalog
-- Ref: docs/adr/adr-003-auth-roles-rls.md, docs/adr/adr-013-skills-taxonomy.md §6
-- Matrix:
--   skills          : recruiter R    | admin R/W
--   skill_aliases   : recruiter R    | admin R/W
--   skills_blacklist: recruiter ❌   | admin R/W (INSERT + DELETE; no UPDATE use case)

-- ────────────────────────────────────────────────────────────────
-- skills
-- ────────────────────────────────────────────────────────────────
alter table skills enable row level security;
alter table skills force row level security;

create policy "skills_read_all_authenticated"
  on skills for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "skills_admin_insert"
  on skills for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "skills_admin_update"
  on skills for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "skills_admin_delete"
  on skills for delete
  to authenticated
  using (public.current_app_role() = 'admin');

-- ────────────────────────────────────────────────────────────────
-- skill_aliases
-- ────────────────────────────────────────────────────────────────
alter table skill_aliases enable row level security;
alter table skill_aliases force row level security;

create policy "skill_aliases_read_all_authenticated"
  on skill_aliases for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "skill_aliases_admin_insert"
  on skill_aliases for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "skill_aliases_admin_update"
  on skill_aliases for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "skill_aliases_admin_delete"
  on skill_aliases for delete
  to authenticated
  using (public.current_app_role() = 'admin');

-- ────────────────────────────────────────────────────────────────
-- skills_blacklist
-- ────────────────────────────────────────────────────────────────
-- Recruiter cannot even SELECT — this table is an admin-only helper
-- for the uncataloged-skills review report. No UPDATE policy: entries
-- are either kept or deleted; "correcting a reason" means delete+insert.
alter table skills_blacklist enable row level security;
alter table skills_blacklist force row level security;

create policy "skills_blacklist_admin_select"
  on skills_blacklist for select
  to authenticated
  using (public.current_app_role() = 'admin');

create policy "skills_blacklist_admin_insert"
  on skills_blacklist for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "skills_blacklist_admin_delete"
  on skills_blacklist for delete
  to authenticated
  using (public.current_app_role() = 'admin');
