-- Migration: 007 — tags (candidate_tags join comes in wave 2)
-- Depends on: 001
-- Ref: docs/data-model.md §11
-- Rollback: drop table if exists tags cascade;

create table tags (
  id         uuid primary key default uuid_generate_v4(),
  tenant_id  uuid,
  name       text unique not null,
  category   text,
  created_at timestamptz not null default now()
);

create index idx_tags_category on tags(category);
