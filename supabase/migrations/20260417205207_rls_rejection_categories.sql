-- Migration: 006b — RLS policies for rejection_categories
-- Matrix: recruiter R, admin R/W.

alter table rejection_categories enable row level security;
alter table rejection_categories force row level security;

create policy "rejection_categories_select"
  on rejection_categories for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "rejection_categories_insert"
  on rejection_categories for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "rejection_categories_update"
  on rejection_categories for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "rejection_categories_delete"
  on rejection_categories for delete
  to authenticated
  using (public.current_app_role() = 'admin');
