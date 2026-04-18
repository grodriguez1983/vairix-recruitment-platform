-- Migration: candidate_custom_field_values — valores sideloaded de custom
--            fields por candidato
-- Depends on: 20260417205200_candidates, 20260418154329_custom_fields
-- Ref: docs/adr/adr-010-teamtailor-custom-fields.md §1, §6
-- Scope: un row por (candidate, custom_field) con columnas tipadas según
--        field_type. raw_value siempre se guarda para debug / reversión.
--
-- Rollback: drop table if exists candidate_custom_field_values cascade;

create table candidate_custom_field_values (
  id                   uuid primary key default uuid_generate_v4(),
  tenant_id            uuid,
  candidate_id         uuid not null references candidates(id) on delete cascade,
  custom_field_id      uuid not null references custom_fields(id) on delete cascade,
  teamtailor_value_id  text unique not null,
  field_type           text not null,
  value_text           text,
  value_date           date,
  value_number         numeric,
  value_boolean        boolean,
  raw_value            text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  synced_at            timestamptz not null default now(),
  unique (candidate_id, custom_field_id)
);

create index idx_ccfv_candidate       on candidate_custom_field_values(candidate_id);
create index idx_ccfv_custom_field    on candidate_custom_field_values(custom_field_id);
create index idx_ccfv_value_date      on candidate_custom_field_values(value_date)
  where value_date is not null;
create index idx_ccfv_value_number    on candidate_custom_field_values(value_number)
  where value_number is not null;

create trigger trg_ccfv_updated_at
  before update on candidate_custom_field_values
  for each row execute function set_updated_at();
