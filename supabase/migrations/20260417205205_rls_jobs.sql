-- Migration: 005b — RLS policies for jobs
-- Matrix: recruiter R, admin R/W. Soft-delete via deleted_at.

alter table jobs enable row level security;
alter table jobs force row level security;

create policy "jobs_select"
  on jobs for select
  to authenticated
  using (
    public.current_app_role() in ('recruiter', 'admin')
    and (deleted_at is null or public.current_app_role() = 'admin')
  );

create policy "jobs_insert"
  on jobs for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "jobs_update"
  on jobs for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "jobs_delete"
  on jobs for delete
  to authenticated
  using (public.current_app_role() = 'admin');
