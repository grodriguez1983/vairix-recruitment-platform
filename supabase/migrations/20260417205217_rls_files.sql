-- Migration: 011b — RLS policies for files
-- Matrix: recruiter R, admin R/W.

alter table files enable row level security;
alter table files force row level security;

create policy "files_read_all_authenticated"
  on files for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "files_admin_insert"
  on files for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "files_admin_update"
  on files for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "files_admin_delete"
  on files for delete
  to authenticated
  using (public.current_app_role() = 'admin');
