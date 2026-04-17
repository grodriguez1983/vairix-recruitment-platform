-- Migration: 008b — RLS policies for sync_state
-- Matrix: admin only. recruiter has zero visibility (ADR-003 §5).

alter table sync_state enable row level security;
alter table sync_state force row level security;

create policy "sync_state_admin_all"
  on sync_state for all
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');
