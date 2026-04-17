-- Migration: 013 — candidate_tags (join table)
-- Depends on: candidates, tags, app_users
-- Ref: docs/data-model.md §11
-- Rollback: drop table if exists candidate_tags cascade;

create table candidate_tags (
  candidate_id uuid not null references candidates(id) on delete cascade,
  tag_id       uuid not null references tags(id) on delete cascade,
  source       text default 'manual' check (source in ('manual','auto')),
  confidence   numeric,
  created_by   uuid references app_users(id) on delete set null,
  created_at   timestamptz not null default now(),
  primary key (candidate_id, tag_id)
);

create index idx_candidate_tags_tag on candidate_tags(tag_id);
