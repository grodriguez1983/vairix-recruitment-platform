-- Migration: 017b — RLS policies for notes
-- Matrix: recruiter R/W, admin R/W.

alter table notes enable row level security;
alter table notes force row level security;

create policy "notes_read_all_authenticated"
  on notes for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "notes_insert_all_authenticated"
  on notes for insert
  to authenticated
  with check (public.current_app_role() in ('recruiter', 'admin'));

create policy "notes_update_all_authenticated"
  on notes for update
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'))
  with check (public.current_app_role() in ('recruiter', 'admin'));

create policy "notes_delete_admin"
  on notes for delete
  to authenticated
  using (public.current_app_role() = 'admin');
