-- Migration: candidate_languages (derivation of raw_output.languages)
-- Depends on: 20260420000002_cv_extractions (extractions + candidates)
-- Ref: docs/adr/adr-012-cv-structured-extraction.md §2 (raw_output shape),
--      docs/adr/adr-015-matching-and-ranking.md §3 (language bonus),
--      src/lib/cv/extraction/types.ts LanguageSchema
-- Rollback: drop table if exists candidate_languages;

-- Derived, per-candidate list of languages extracted from the
-- LLM-produced `candidate_extractions.raw_output.languages[]`. Mirrors
-- the candidate_experiences derivation pattern (ADR-012 §2):
--
--   - raw row is frozen (extraction trigger);
--   - derivation is per-extraction and idempotent by
--     `hasExistingLanguages(extraction_id)`;
--   - re-extraction (new model/prompt_version → new extraction row)
--     re-derives.
--
-- The matcher (ADR-015 §3) reads `name` case-insensitively; `level`
-- is stored verbatim for future UI use but not consumed by the
-- deterministic ranker.
create table candidate_languages (
  id              uuid primary key default uuid_generate_v4(),
  tenant_id       uuid,
  candidate_id    uuid not null references candidates(id) on delete cascade,
  extraction_id   uuid not null references candidate_extractions(id) on delete cascade,
  name            text not null,
  level           text,
  created_at      timestamptz not null default now()
);

create index idx_candidate_languages_candidate on candidate_languages(candidate_id);
create index idx_candidate_languages_extraction on candidate_languages(extraction_id);
create index idx_candidate_languages_tenant    on candidate_languages(tenant_id);
