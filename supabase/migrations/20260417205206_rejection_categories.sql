-- Migration: 006 — rejection_categories + seed
-- Depends on: 001
-- Ref: docs/data-model.md §7, ADR-007
-- Rollback: drop table if exists rejection_categories cascade;

create table rejection_categories (
  id            uuid primary key default uuid_generate_v4(),
  code          text unique not null,
  display_name  text not null,
  description   text,
  sort_order    integer,
  deprecated_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_rejection_categories_code on rejection_categories(code);

create trigger trg_rejection_categories_updated_at
  before update on rejection_categories
  for each row execute function set_updated_at();

-- Seed (idempotent via unique code + on conflict do nothing).
insert into rejection_categories (code, display_name, sort_order) values
  ('technical_skills',    'Nivel técnico insuficiente', 10),
  ('experience_level',    'Seniority no encaja',         20),
  ('communication',       'Comunicación',                30),
  ('culture_fit',         'Cultural fit',                40),
  ('salary_expectations', 'Expectativas salariales',     50),
  ('availability',        'Disponibilidad',              60),
  ('location',            'Ubicación / time zone',       70),
  ('no_show',             'No se presentó',              80),
  ('ghosting',            'Dejó de responder',           90),
  ('position_filled',     'Posición cubierta',           100),
  ('other',               'Otro',                         999)
on conflict (code) do nothing;
