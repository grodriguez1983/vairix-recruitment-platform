-- Migration: 007b — RLS policies for tags
-- Matrix: recruiter R/W, admin R/W.

alter table tags enable row level security;
alter table tags force row level security;

create policy "tags_select"
  on tags for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "tags_insert"
  on tags for insert
  to authenticated
  with check (public.current_app_role() in ('recruiter', 'admin'));

create policy "tags_update"
  on tags for update
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'))
  with check (public.current_app_role() in ('recruiter', 'admin'));

create policy "tags_delete"
  on tags for delete
  to authenticated
  using (public.current_app_role() = 'admin');
