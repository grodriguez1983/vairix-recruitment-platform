-- Migration: 009b — RLS policies for sync_errors
-- Matrix: admin only.

alter table sync_errors enable row level security;
alter table sync_errors force row level security;

create policy "sync_errors_admin_all"
  on sync_errors for all
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');
