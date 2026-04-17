-- Migration: 014b — RLS policies for shortlists + shortlist_candidates
-- Matrix: recruiter R/W, admin R/W.

alter table shortlists enable row level security;
alter table shortlists force row level security;

create policy "shortlists_read_all_authenticated"
  on shortlists for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "shortlists_insert_all_authenticated"
  on shortlists for insert
  to authenticated
  with check (public.current_app_role() in ('recruiter', 'admin'));

create policy "shortlists_update_all_authenticated"
  on shortlists for update
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'))
  with check (public.current_app_role() in ('recruiter', 'admin'));

create policy "shortlists_delete_all_authenticated"
  on shortlists for delete
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

alter table shortlist_candidates enable row level security;
alter table shortlist_candidates force row level security;

create policy "shortlist_candidates_read_all_authenticated"
  on shortlist_candidates for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "shortlist_candidates_insert_all_authenticated"
  on shortlist_candidates for insert
  to authenticated
  with check (public.current_app_role() in ('recruiter', 'admin'));

create policy "shortlist_candidates_update_all_authenticated"
  on shortlist_candidates for update
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'))
  with check (public.current_app_role() in ('recruiter', 'admin'));

create policy "shortlist_candidates_delete_all_authenticated"
  on shortlist_candidates for delete
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));
