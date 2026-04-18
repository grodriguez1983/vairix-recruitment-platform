-- Migration: RLS policies for candidate_custom_field_values
-- Depends on: 20260418154331_candidate_custom_field_values,
--             rls_custom_fields (current_app_role)
-- Ref: ADR-010 §4, ADR-003 §5-6
-- Matrix:
--   - SELECT: recruiter/admin, pero los valores de custom fields con
--             is_private=true quedan ocultos para recruiter (admin ve
--             todo). En F1 no hay rol recruiter_senior distinto del
--             recruiter base; si aparece, ampliar la whitelist.
--   - INSERT/UPDATE/DELETE: service role (ETL). Authenticated no escribe.

alter table candidate_custom_field_values enable row level security;
alter table candidate_custom_field_values force row level security;

create policy "ccfv_select"
  on candidate_custom_field_values for select
  to authenticated
  using (
    public.current_app_role() in ('recruiter', 'admin')
    and (
      public.current_app_role() = 'admin'
      or not exists (
        select 1 from custom_fields cf
        where cf.id = candidate_custom_field_values.custom_field_id
          and cf.is_private = true
      )
    )
  );
