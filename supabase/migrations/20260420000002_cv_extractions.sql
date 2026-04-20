-- Migration: CV extractions (candidate_extractions, candidate_experiences, experience_skills)
-- Depends on: 20260420000000_skills_catalog (skills), 20260417205216_files, 20260417205200_candidates
-- Ref: docs/adr/adr-012-cv-structured-extraction.md, docs/data-model.md §16.5-§16.7
-- Rollback:
--   drop trigger if exists trg_candidate_extractions_raw_output_immutable on candidate_extractions;
--   drop function if exists enforce_raw_output_immutability();
--   drop table if exists experience_skills;
--   drop table if exists candidate_experiences;
--   drop table if exists candidate_extractions;

-- ────────────────────────────────────────────────────────────────
-- 1. candidate_extractions
-- ────────────────────────────────────────────────────────────────
-- Idempotent by content_hash = SHA256(parsed_text || NUL || model
-- || NUL || prompt_version). raw_output is the verbatim LLM payload
-- and must NEVER be mutated post-insert (§7 ADR-012): re-extraction
-- bumps model/prompt_version → different hash → new row.
create table candidate_extractions (
  id              uuid primary key default uuid_generate_v4(),
  tenant_id       uuid,
  candidate_id    uuid not null references candidates(id) on delete cascade,
  file_id         uuid not null references files(id) on delete cascade,
  source_variant  text not null check (source_variant in ('linkedin_export', 'cv_primary')),
  model           text not null,
  prompt_version  text not null,
  content_hash    text unique not null,
  raw_output      jsonb not null,
  extracted_at    timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index idx_candidate_extractions_candidate on candidate_extractions(candidate_id);
create index idx_candidate_extractions_file      on candidate_extractions(file_id);
create index idx_candidate_extractions_variant   on candidate_extractions(source_variant);
create index idx_candidate_extractions_tenant    on candidate_extractions(tenant_id);

-- raw_output immutability is enforced at the DB level so even a
-- service-role client (which bypasses RLS) cannot rewrite a payload.
-- This protects the audit chain: `breakdown_json` in match_results
-- eventually cites experiences derived from raw_output, so tampering
-- the raw would invalidate downstream provenance silently.
create or replace function enforce_raw_output_immutability()
returns trigger
language plpgsql
as $$
begin
  if new.raw_output is distinct from old.raw_output then
    raise exception 'candidate_extractions.raw_output is immutable (ADR-012 §4)';
  end if;
  return new;
end;
$$;

create trigger trg_candidate_extractions_raw_output_immutable
  before update on candidate_extractions
  for each row execute function enforce_raw_output_immutability();

-- ────────────────────────────────────────────────────────────────
-- 2. candidate_experiences
-- ────────────────────────────────────────────────────────────────
-- Derived from candidate_extractions.raw_output. source_variant is
-- duplicated (also on the parent extraction) so the ranker can weight
-- without joining (ADR-012 §7). merged_from_ids records diagnostics
-- from the variant-merger (ADR-015 §2) — the source experience IDs
-- that got collapsed into this canonical row.
create table candidate_experiences (
  id                uuid primary key default uuid_generate_v4(),
  tenant_id         uuid,
  candidate_id      uuid not null references candidates(id) on delete cascade,
  extraction_id     uuid not null references candidate_extractions(id) on delete cascade,
  source_variant    text not null check (source_variant in ('linkedin_export', 'cv_primary')),
  kind              text not null check (kind in ('work', 'side_project', 'education')),
  company           text,
  title             text,
  start_date        date,
  end_date          date,
  description       text,
  merged_from_ids   uuid[],
  created_at        timestamptz not null default now()
);

create index idx_candidate_experiences_candidate on candidate_experiences(candidate_id);
create index idx_candidate_experiences_kind      on candidate_experiences(kind);
create index idx_candidate_experiences_dates     on candidate_experiences(start_date, end_date);
create index idx_candidate_experiences_tenant    on candidate_experiences(tenant_id);

-- ────────────────────────────────────────────────────────────────
-- 3. experience_skills
-- ────────────────────────────────────────────────────────────────
-- skill_id is nullable (uncataloged skills still get a row so
-- /admin/skills/uncataloged can surface them). ON DELETE SET NULL on
-- skills: historical mentions survive when a skill is retired — the
-- skill_raw stays as the original LLM output for the admin report.
create table experience_skills (
  id              uuid primary key default uuid_generate_v4(),
  experience_id   uuid not null references candidate_experiences(id) on delete cascade,
  skill_raw       text not null,
  skill_id        uuid references skills(id) on delete set null,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index idx_experience_skills_experience on experience_skills(experience_id);
create index idx_experience_skills_skill      on experience_skills(skill_id)
  where skill_id is not null;
create index idx_experience_skills_uncataloged on experience_skills(skill_raw)
  where skill_id is null;
