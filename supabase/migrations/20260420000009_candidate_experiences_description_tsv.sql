-- Migration: candidate_experiences.description_tsv (ADR-016 §3, F4-007 bis)
-- Depends on: 20260420000002_cv_extractions (candidate_experiences)
-- Ref: docs/adr/adr-016-complementary-signals.md §3
-- Rollback:
--   drop index if exists idx_candidate_experiences_description_tsv;
--   alter table candidate_experiences drop column if exists description_tsv;

-- STORED generated tsvector over the free-form description. Feeds the
-- FTS recall-fallback in F4-008 bis: a candidate with `react` in a
-- description but not in structured experience_skills must still be
-- findable via plainto_tsquery. The `simple` configuration matches
-- the one used by hybrid_search_fn (no stemming — skill names like
-- 'react' and 'reacts' must not collapse).
--
-- Additive and idempotent: the column is generated, so there is no
-- backfill step. The GIN index rebuilds on existing rows during the
-- CREATE INDEX (not concurrent — this table is small and only the
-- extraction worker writes to it).
alter table candidate_experiences
  add column description_tsv tsvector
    generated always as (to_tsvector('simple', coalesce(description, ''))) stored;

create index idx_candidate_experiences_description_tsv
  on candidate_experiences using gin (description_tsv);
