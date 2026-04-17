-- Migration: 012 — embeddings (pgvector)
-- Depends on: 001 (vector ext), candidates
-- Ref: docs/data-model.md §13, docs/adr/adr-005-embeddings-strategy.md
-- Rollback: drop table if exists embeddings cascade;

create table embeddings (
  id            uuid primary key default uuid_generate_v4(),
  tenant_id     uuid,
  candidate_id  uuid not null references candidates(id) on delete cascade,
  source_type   text not null check (source_type in ('cv','evaluation','notes','profile')),
  source_id     uuid,
  content       text not null,
  content_hash  text not null,
  embedding     vector(1536),
  model         text not null default 'text-embedding-3-small',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index uq_embeddings_source
  on embeddings(candidate_id, source_type, source_id);
create index idx_embeddings_candidate on embeddings(candidate_id);
create index idx_embeddings_hash      on embeddings(content_hash);

create index idx_embeddings_vector on embeddings
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create trigger trg_embeddings_updated_at
  before update on embeddings
  for each row execute function set_updated_at();
