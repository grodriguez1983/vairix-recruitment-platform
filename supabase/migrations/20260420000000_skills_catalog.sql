-- Migration: skills catalog (skills, skill_aliases, skills_blacklist)
-- Depends on: 20260414_extensions_and_helpers (uuid-ossp + set_updated_at)
-- Ref: docs/adr/adr-013-skills-taxonomy.md §1-§5, docs/data-model.md §16.1-§16.3
-- Rollback:
--   drop function if exists public.resolve_skill(text);
--   drop table if exists skills_blacklist;
--   drop table if exists skill_aliases;
--   drop table if exists skills;

-- ────────────────────────────────────────────────────────────────
-- 1. skills
-- ────────────────────────────────────────────────────────────────
-- canonical_name is NOT unique on purpose (ADR-013 §1): display
-- variants can coexist; the slug is the stable key. category is
-- optional and flat — no hierarchy (§1). deprecated_at supports
-- soft delete for retired technologies (§1).
create table skills (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid,
  canonical_name text not null,
  slug           text unique not null,
  category       text,
  deprecated_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index idx_skills_slug      on skills(slug);
create index idx_skills_category  on skills(category) where category is not null;
create index idx_skills_name_trgm on skills using gin (canonical_name gin_trgm_ops);
create index idx_skills_tenant    on skills(tenant_id);

create trigger trg_skills_updated_at
  before update on skills
  for each row execute function set_updated_at();

-- ────────────────────────────────────────────────────────────────
-- 2. skill_aliases
-- ────────────────────────────────────────────────────────────────
-- alias_normalized is UNIQUE GLOBALLY (ADR-013 §1): two skills
-- cannot claim the same alias. source audits provenance:
--   'seed'   — from migration-time canonical list
--   'admin'  — added via /admin/skills UI
--   'derived'— output of `pnpm skills:derive-aliases-from-cvs`
create table skill_aliases (
  id               uuid primary key default uuid_generate_v4(),
  skill_id         uuid not null references skills(id) on delete cascade,
  alias_normalized text unique not null,
  source           text not null check (source in ('seed', 'admin', 'derived')),
  created_at       timestamptz not null default now()
);

create index idx_skill_aliases_skill  on skill_aliases(skill_id);
create index idx_skill_aliases_source on skill_aliases(source);

-- ────────────────────────────────────────────────────────────────
-- 3. skills_blacklist
-- ────────────────────────────────────────────────────────────────
-- Helper table for the admin uncataloged-skills report (ADR-013 §5).
-- Stores alias_normalized strings that an admin has reviewed and
-- decided should never be promoted to skills (e.g. "team player",
-- "hands on"). The resolver does NOT consult this table — it only
-- filters what `/admin/skills/uncataloged` displays.
create table skills_blacklist (
  id               uuid primary key default uuid_generate_v4(),
  alias_normalized text unique not null,
  reason           text,
  created_at       timestamptz not null default now()
);

create index idx_skills_blacklist_alias on skills_blacklist(alias_normalized);

-- ────────────────────────────────────────────────────────────────
-- 4. public.resolve_skill(text) — SQL helper
-- ────────────────────────────────────────────────────────────────
-- Mirror of src/lib/skills/resolver.ts (lands in F4-002). The
-- equivalence tests in tests/integration/skills/ keep both in sync.
--
-- Pipeline (ADR-013 §2):
--   1. lowercase → trim → collapse internal whitespace
--   2. strip terminal punctuation (., ,, ;, :) — preserve internal
--      punctuation (c++, c#, node.js, ci/cd)
--   3. exact match on skills.slug WHERE deprecated_at IS NULL
--   4. alias match on skill_aliases.alias_normalized
--   5. null when no match
--
-- The function is STABLE because it only reads from tables, and
-- two consecutive calls within the same query will see the same
-- rows (no side effects, no volatile time functions affect result).
create or replace function public.resolve_skill(raw text)
returns uuid
language plpgsql
stable
as $$
declare
  normalized text;
  result_id  uuid;
begin
  -- Default trim() only strips spaces; use regex to strip all
  -- whitespace (tabs, newlines, CR) so "\tReact\n" normalizes the
  -- same as "  React  ".
  normalized := regexp_replace(raw, '^\s+|\s+$', '', 'g');
  if normalized is null or length(normalized) = 0 then
    return null;
  end if;

  normalized := lower(normalized);
  normalized := regexp_replace(normalized, '\s+', ' ', 'g');
  normalized := regexp_replace(normalized, '[.,;:]+$', '');

  -- Step 1: exact slug match, ignoring deprecated rows.
  select id into result_id
    from skills
   where slug = normalized
     and deprecated_at is null;
  if result_id is not null then
    return result_id;
  end if;

  -- Step 2: alias fallback.
  select skill_id into result_id
    from skill_aliases
   where alias_normalized = normalized;

  return result_id;  -- null if no match; caller handles uncataloged.
end;
$$;

comment on function public.resolve_skill(text) is
  'Resolves a raw skill string to skills.id per ADR-013 §2. Returns '
  'null when uncataloged. Mirror of src/lib/skills/resolver.ts.';
