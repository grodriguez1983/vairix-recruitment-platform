-- Migration: 012b — RLS policies for embeddings
-- Matrix: recruiter R (indirecto), admin R/W.
-- El worker de embeddings usa service_role key, que bypasea RLS.

alter table embeddings enable row level security;
alter table embeddings force row level security;

create policy "embeddings_read_all_authenticated"
  on embeddings for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

create policy "embeddings_admin_insert"
  on embeddings for insert
  to authenticated
  with check (public.current_app_role() = 'admin');

create policy "embeddings_admin_update"
  on embeddings for update
  to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

create policy "embeddings_admin_delete"
  on embeddings for delete
  to authenticated
  using (public.current_app_role() = 'admin');
