-- Migration: 010b — RLS policies for stages
-- Matrix: recruiter R, admin R/W.

alter table stages enable row level security;
alter table stages force row level security;

create policy "stages_read_all_authenticated"
  on stages for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "stages_admin_insert"
  on stages for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "stages_admin_update"
  on stages for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "stages_admin_delete"
  on stages for delete
  to authenticated
  using (public.current_app_role() = 'admin');
