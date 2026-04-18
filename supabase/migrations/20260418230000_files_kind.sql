-- Migration: files.kind — distinguish regular CVs from VAIRIX CV sheets
-- Depends on: 20260417205216_files
-- Ref: F1-006b (VAIRIX CV Sheet manual upload)
-- Rollback:
--   alter table files drop column kind;
--   drop index if exists idx_files_vairix_cv_sheet_one_per_candidate;
--
-- Context:
--   Teamtailor's `/v1/interviews` stores a Google Sheets URL per
--   candidate under custom question `Información para CV`
--   (question_tt_id=24016), carrying a VAIRIX-formatted CV + notes.
--   Full Google Drive integration is deferred. In the meantime the
--   recruiter downloads that sheet as xlsx/csv and uploads it here
--   so the candidate profile has the full picture in one place and
--   we can eventually parse it.
--
--   We reuse the existing `files` table (same bucket, same RLS, same
--   signed-url endpoint) with a `kind` column distinguishing the two.
--   A partial unique on `(candidate_id) where kind='vairix_cv_sheet'`
--   enforces one sheet per candidate; regular CVs stay unconstrained.

alter table files
  add column kind text not null default 'cv'
  check (kind in ('cv', 'vairix_cv_sheet'));

create unique index idx_files_vairix_cv_sheet_one_per_candidate
  on files(candidate_id)
  where kind = 'vairix_cv_sheet' and deleted_at is null;

create index idx_files_kind on files(kind);
