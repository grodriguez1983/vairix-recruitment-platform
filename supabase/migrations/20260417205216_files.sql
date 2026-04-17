-- Migration: 011 — files (CVs)
-- Depends on: candidates
-- Ref: docs/data-model.md §10, docs/adr/adr-006-cv-parsing.md
-- Rollback: drop table if exists files cascade;

create table files (
  id              uuid primary key default uuid_generate_v4(),
  tenant_id       uuid,
  teamtailor_id   text unique,
  candidate_id    uuid not null references candidates(id) on delete cascade,
  storage_path    text not null,
  file_type       text,
  file_size_bytes bigint,
  content_hash    text,
  parsed_text     text,
  parsed_at       timestamptz,
  parse_error     text,
  raw_data        jsonb,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  synced_at       timestamptz not null default now()
);

create index idx_files_candidate    on files(candidate_id);
create index idx_files_content_hash on files(content_hash);
create index idx_files_parse_error  on files(parse_error)
  where parse_error is not null;
create index idx_files_parsed_text  on files
  using gin (to_tsvector('simple', coalesce(parsed_text, '')));

create trigger trg_files_updated_at
  before update on files
  for each row execute function set_updated_at();
