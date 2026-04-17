-- Migration: 016 — evaluations
-- Depends on: candidates, applications, users, rejection_categories
-- Ref: docs/data-model.md §8
-- Rollback: drop table if exists evaluations cascade;

create table evaluations (
  id                         uuid primary key default uuid_generate_v4(),
  tenant_id                  uuid,
  teamtailor_id              text unique,
  candidate_id               uuid not null references candidates(id) on delete cascade,
  application_id             uuid references applications(id) on delete cascade,
  user_id                    uuid references users(id) on delete set null,
  evaluator_name             text,
  score                      numeric,
  decision                   text check (decision in ('accept','reject','pending','on_hold')),
  rejection_reason           text,
  rejection_category_id      uuid references rejection_categories(id) on delete set null,
  needs_review               boolean default false,
  normalization_attempted_at timestamptz,
  notes                      text,
  raw_data                   jsonb,
  deleted_at                 timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  synced_at                  timestamptz not null default now()
);

create index idx_evaluations_candidate    on evaluations(candidate_id);
create index idx_evaluations_application  on evaluations(application_id);
create index idx_evaluations_user         on evaluations(user_id);
create index idx_evaluations_decision     on evaluations(decision);
create index idx_evaluations_category     on evaluations(rejection_category_id);
create index idx_evaluations_needs_review on evaluations(needs_review)
  where needs_review = true;
create index idx_evaluations_notes_trgm   on evaluations
  using gin (notes gin_trgm_ops);

create trigger trg_evaluations_updated_at
  before update on evaluations
  for each row execute function set_updated_at();
