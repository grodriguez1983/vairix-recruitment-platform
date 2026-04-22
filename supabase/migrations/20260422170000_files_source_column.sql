-- Migration: files.source — distinguish uploads vs candidate-resume (ADR-018).
-- Depends on: 20260417205216_files
-- Ref: docs/adr/adr-018-candidate-resume-as-cv.md, docs/teamtailor-api-notes.md §5.1
-- Rollback:
--   alter table files drop column if exists source;

-- ────────────────────────────────────────────────────────────────
-- Why
-- ────────────────────────────────────────────────────────────────
-- ADR-018: Teamtailor exposes CVs through two distinct surfaces —
--   (a) /v1/uploads — binaries a recruiter or candidate uploaded.
--   (b) candidates.attributes.resume — a short-lived S3 signed URL
--       to a TT-generated PDF (LinkedIn extract for sourced
--       candidates, or the candidate's original upload re-rendered).
-- Our ETL originally pulled only (a), missing ~90% of the actual CV
-- population because sourced candidates don't have an "upload" row.
-- Column `source` lets us keep both in the same table without
-- mixing their provenance, and lets downstream logic (parser,
-- deduper, UI) filter if needed.

alter table files
  add column source text not null default 'uploads'
  check (source in ('uploads', 'candidate_resume'));

comment on column files.source is
  'Provenance of the binary. ''uploads'' = /v1/uploads (recruiter/candidate upload); ''candidate_resume'' = candidates.attributes.resume (TT-generated). ADR-018.';
