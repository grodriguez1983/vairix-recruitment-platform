-- Migration: custom_fields — catálogo mirror de /custom-fields de Teamtailor
-- Depends on: 001 (extensions, set_updated_at)
-- Ref: docs/adr/adr-010-teamtailor-custom-fields.md §1
-- Scope: metadata de las definiciones de custom fields del tenant.
--        Low-volume (≤ 50 filas esperadas). Se sincroniza ANTES de
--        candidates porque el syncer de candidates resuelve
--        custom-field.id (TT) → id (UUID local) al persistir valores.
--
-- Rollback: drop table if exists custom_fields cascade;

create table custom_fields (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid,
  teamtailor_id  text unique not null,
  api_name       text not null,
  name           text not null,
  field_type     text not null,    -- 'CustomField::Text' | 'CustomField::Date' | ...
  owner_type     text not null,    -- 'Candidate' | 'Job' | ...
  is_private     boolean not null default false,
  is_searchable  boolean not null default false,
  raw_data       jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now()
);

create index idx_custom_fields_owner_type    on custom_fields(owner_type);
create index idx_custom_fields_api_name      on custom_fields(api_name);
create index idx_custom_fields_teamtailor_id on custom_fields(teamtailor_id);

create trigger trg_custom_fields_updated_at
  before update on custom_fields
  for each row execute function set_updated_at();

-- Seed sync_state row para el nuevo entity. ADR-010 §5.
insert into sync_state (entity, last_run_status) values
  ('custom-fields', 'idle')
on conflict (entity) do nothing;
