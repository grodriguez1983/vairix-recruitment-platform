-- Migration: 004b — RLS policies for users (TT evaluators)
-- Matrix: recruiter R, admin R/W.

alter table users enable row level security;
alter table users force row level security;

create policy "users_select"
  on users for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "users_insert"
  on users for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "users_update"
  on users for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "users_delete"
  on users for delete
  to authenticated
  using (public.current_app_role() = 'admin');
