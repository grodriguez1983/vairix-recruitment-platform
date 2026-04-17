-- Migration: 016b — RLS policies for evaluations
-- Matrix: recruiter R, admin R/W.

alter table evaluations enable row level security;
alter table evaluations force row level security;

create policy "evaluations_read_all_authenticated"
  on evaluations for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "evaluations_admin_insert"
  on evaluations for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "evaluations_admin_update"
  on evaluations for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "evaluations_admin_delete"
  on evaluations for delete
  to authenticated
  using (public.current_app_role() = 'admin');
