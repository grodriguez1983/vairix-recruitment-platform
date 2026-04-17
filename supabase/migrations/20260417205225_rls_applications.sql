-- Migration: 015b — RLS policies for applications
-- Matrix: recruiter R/W, admin R/W.

alter table applications enable row level security;
alter table applications force row level security;

create policy "applications_read_all_authenticated"
  on applications for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "applications_insert_all_authenticated"
  on applications for insert
  to authenticated
  with check (public.current_app_role() in ('recruiter', 'admin'));

create policy "applications_update_all_authenticated"
  on applications for update
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'))
  with check (public.current_app_role() in ('recruiter', 'admin'));

create policy "applications_delete_admin"
  on applications for delete
  to authenticated
  using (public.current_app_role() = 'admin');
