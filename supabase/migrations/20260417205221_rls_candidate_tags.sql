-- Migration: 013b — RLS policies for candidate_tags
-- Matrix: recruiter R/W, admin R/W.

alter table candidate_tags enable row level security;
alter table candidate_tags force row level security;

create policy "candidate_tags_read_all_authenticated"
  on candidate_tags for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "candidate_tags_insert_all_authenticated"
  on candidate_tags for insert
  to authenticated
  with check (public.current_app_role() in ('recruiter', 'admin'));

create policy "candidate_tags_update_all_authenticated"
  on candidate_tags for update
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'))
  with check (public.current_app_role() in ('recruiter', 'admin'));

create policy "candidate_tags_delete_all_authenticated"
  on candidate_tags for delete
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));
