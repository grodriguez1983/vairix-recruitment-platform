-- Migration: RLS policies for evaluation_answers
-- Depends on: 20260418220000_evaluation_answers
-- Ref: docs/adr/adr-003-auth-roles-rls.md
-- Matrix: recruiter R, admin R/W. Same as evaluations.

alter table evaluation_answers enable row level security;
alter table evaluation_answers force row level security;

create policy "evaluation_answers_read_all_authenticated"
  on evaluation_answers for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "evaluation_answers_admin_insert"
  on evaluation_answers for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "evaluation_answers_admin_update"
  on evaluation_answers for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "evaluation_answers_admin_delete"
  on evaluation_answers for delete
  to authenticated
  using (public.current_app_role() = 'admin');
