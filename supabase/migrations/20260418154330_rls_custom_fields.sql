-- Migration: RLS policies for custom_fields
-- Depends on: 20260418154329_custom_fields, rls_app_users (current_app_role)
-- Ref: ADR-010 §4, ADR-003 §5-6
-- Matrix: recruiter/admin read. Writes via service role (ETL), no
--         escritura desde rol authenticated.

alter table custom_fields enable row level security;
alter table custom_fields force row level security;

create policy "custom_fields_select"
  on custom_fields for select
  to authenticated
  using (public.current_app_role() in ('recruiter', 'admin'));

-- No insert/update/delete policies para authenticated: el catálogo lo
-- mantiene el ETL con service role key (bypassea RLS).
