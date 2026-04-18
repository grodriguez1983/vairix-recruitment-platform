-- Migration: F1-007 — Supabase Storage bucket for candidate CVs + files.is_internal.
-- Depends on: 20260417205216_files, 20260418230000_files_kind.
-- Ref: docs/adr/adr-006-cv-storage-and-parsing.md, docs/spec.md §6,
--      docs/teamtailor-api-notes.md §5.7.
--
-- Rollback:
--   drop policy if exists "candidate_cvs_select_role" on storage.objects;
--   drop policy if exists "candidate_cvs_admin_write" on storage.objects;
--   delete from storage.buckets where id = 'candidate-cvs';
--   alter table files drop column is_internal;
--
-- Context:
--   Teamtailor uploads (/v1/uploads) carry short-lived S3 signed URLs
--   (see ADR-006 §2). The sync worker downloads the binary, hashes it,
--   and stores it in our own private bucket. The UI serves it via
--   server-issued signed URLs (ADR-006 §3). Regular CVs and the
--   manually-uploaded VAIRIX CV sheet (F1-006b) share the bucket,
--   distinguished by `files.kind`.
--
--   `is_internal` mirrors Teamtailor's `uploads.internal` attribute
--   (true=recruiter-uploaded from admin, false=candidate-uploaded
--   during application). Stored to keep provenance queryable; the
--   sync imports both without filtering. Nullable to accommodate
--   manually-uploaded files (F1-006b) where the concept doesn't
--   apply; defaults to false (candidate-facing semantics).

-- ── 1. Column: files.is_internal ──────────────────────────────────
alter table files
  add column is_internal boolean not null default false;

comment on column files.is_internal is
  'Teamtailor uploads.internal: true=recruiter-internal upload, false=candidate application upload. Defaults false for manual uploads (F1-006b).';

-- ── 2. Bucket: candidate-cvs ──────────────────────────────────────
-- Private bucket (public=false), 10 MB cap, MIME whitelist.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'candidate-cvs',
  'candidate-cvs',
  false,
  10485760,  -- 10 MB
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain',
    'application/rtf'
  ]
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── 3. storage.objects RLS on bucket 'candidate-cvs' ─────────────
-- RLS on storage.objects is enabled by Supabase by default. We add
-- two bucket-scoped policies:
--   (a) SELECT: recruiter + admin — so they can sign URLs.
--   (b) ALL:    admin only — uploads from F1-006b admin route.
-- The sync worker (F1-007) and the manual-upload API route use the
-- service_role client, which bypasses RLS.

create policy "candidate_cvs_select_role"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'candidate-cvs'
    and public.current_app_role() in ('recruiter', 'admin')
  );

create policy "candidate_cvs_admin_write"
  on storage.objects for all
  to authenticated
  using (
    bucket_id = 'candidate-cvs'
    and public.current_app_role() = 'admin'
  )
  with check (
    bucket_id = 'candidate-cvs'
    and public.current_app_role() = 'admin'
  );
