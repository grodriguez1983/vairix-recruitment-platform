-- Migration: 003b — RLS policies for candidates
-- Depends on: 20260417205200_candidates, 20260417205153_rls_app_users (current_app_role)
-- Ref: docs/data-model.md §16, ADR-003 §5-6
-- Matrix: recruiter R/W (no soft-deleted), admin R/W total (incl. soft-deleted).

alter table candidates enable row level security;
alter table candidates force row level security;

create policy "candidates_select"
  on candidates for select
  to authenticated
  using (
    public.current_app_role() in ('recruiter', 'admin')
    and (deleted_at is null or public.current_app_role() = 'admin')
  );

create policy "candidates_insert"
  on candidates for insert
  to authenticated
  with check (public.current_app_role() in ('recruiter', 'admin'));

-- Recruiter can update non-deleted rows (incl. setting deleted_at themselves).
-- Admin can update anything.
create policy "candidates_update"
  on candidates for update
  to authenticated
  using (
    public.current_app_role() = 'admin'
    or (public.current_app_role() = 'recruiter' and deleted_at is null)
  )
  with check (public.current_app_role() in ('recruiter', 'admin'));

-- Hard delete: admin only. ADR-003 §6.
create policy "candidates_delete"
  on candidates for delete
  to authenticated
  using (public.current_app_role() = 'admin');
