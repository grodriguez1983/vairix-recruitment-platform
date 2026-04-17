# 🗄️ Data Model — Recruitment Data Platform

> Schema canónico de la base de datos. Toda migración debe partir de
> este documento. Si el schema cambia, actualizar acá **y** crear la
> migración correspondiente en `supabase/migrations/`.
>
> **ADRs relacionados**: 001, 002, 003, 004, 005, 006, 007.

---

## Principios de diseño

1. **IDs internos** en `uuid`; IDs externos como `teamtailor_id` (text).
2. **Nunca** FK contra `teamtailor_id`. Siempre resolver a `uuid` interno.
3. **`raw_data jsonb`** en cada tabla espejo con el payload original.
4. **Timestamps triples** donde aplica:
   - `created_at` — creación en Teamtailor
   - `updated_at` — última modificación en Teamtailor
   - `synced_at` — última vez que lo trajimos a nuestra DB
5. **Upsert por `teamtailor_id`**, siempre. Nunca insert ciego.
6. **Soft delete**: columna `deleted_at` en vez de `DELETE` físico.
7. **`tenant_id uuid` nullable** en tablas de dominio (hedge
   multi-tenant futuro, ver ADR-003). En Fase 1 queda null o con un
   UUID fijo por env.
8. **Row Level Security (RLS)** activa; policies en ADR-003 y en las
   migraciones.

---

## Extensiones requeridas

```sql
create extension if not exists "uuid-ossp";
create extension if not exists "vector";
create extension if not exists "pg_trgm";
```

---

## Trigger genérico de updated_at

```sql
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
```

---

## 1. `app_users`

Tabla interna de usuarios de la aplicación (no confundir con `users`
sincronizados desde Teamtailor ni con `auth.users` de Supabase).

```sql
create table app_users (
  id             uuid primary key default uuid_generate_v4(),
  auth_user_id   uuid unique not null references auth.users(id) on delete cascade,
  email          text not null,
  full_name      text,
  role           text not null check (role in ('recruiter', 'admin')),
  tenant_id      uuid,
  deactivated_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index idx_app_users_auth_user on app_users(auth_user_id);
create index idx_app_users_role      on app_users(role);

create trigger trg_app_users_updated_at
  before update on app_users
  for each row execute function set_updated_at();
```

---

## 2. `candidates`

```sql
create table candidates (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid,
  teamtailor_id  text unique not null,
  first_name     text,
  last_name      text,
  email          text,
  phone          text,
  linkedin_url   text,
  pitch          text,
  sourced        boolean default false,
  raw_data       jsonb,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now()
);

create index idx_candidates_teamtailor_id on candidates(teamtailor_id);
create index idx_candidates_email         on candidates(email);
create index idx_candidates_updated_at    on candidates(updated_at desc);
create index idx_candidates_deleted_at    on candidates(deleted_at)
  where deleted_at is null;
create index idx_candidates_tenant        on candidates(tenant_id);

create index idx_candidates_name_trgm on candidates
  using gin ((coalesce(first_name,'') || ' ' || coalesce(last_name,''))
             gin_trgm_ops);

create trigger trg_candidates_updated_at
  before update on candidates
  for each row execute function set_updated_at();
```

---

## 3. `users` (evaluadores sincronizados de Teamtailor)

Todos los usuarios internos de VAIRIX que aparecen como evaluadores
en Teamtailor. Distinta tabla que `app_users`.

```sql
create table users (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid,
  teamtailor_id  text unique not null,
  email          text,
  full_name      text,
  role           text,
  active         boolean default true,
  raw_data       jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now()
);

create index idx_users_teamtailor_id on users(teamtailor_id);
create index idx_users_email         on users(email);

create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();
```

---

## 4. `jobs`

```sql
create table jobs (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid,
  teamtailor_id  text unique not null,
  title          text not null,
  department     text,
  location       text,
  status         text check (status in ('open','draft','archived','unlisted')),
  pitch          text,
  body           text,
  raw_data       jsonb,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now()
);

create index idx_jobs_teamtailor_id on jobs(teamtailor_id);
create index idx_jobs_status        on jobs(status);
create index idx_jobs_updated_at    on jobs(updated_at desc);

create trigger trg_jobs_updated_at
  before update on jobs
  for each row execute function set_updated_at();
```

---

## 5. `stages`

Catálogo de stages del pipeline, por job.

```sql
create table stages (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid,
  teamtailor_id  text unique not null,
  job_id         uuid references jobs(id) on delete cascade,
  name           text not null,
  slug           text,
  position       integer,
  category       text,   -- applied, interviewing, offer, hired, rejected
  raw_data       jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now()
);

create index idx_stages_job           on stages(job_id);
create index idx_stages_teamtailor_id on stages(teamtailor_id);

create trigger trg_stages_updated_at
  before update on stages
  for each row execute function set_updated_at();
```

---

## 6. `applications`

```sql
create table applications (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid,
  teamtailor_id  text unique not null,
  candidate_id   uuid not null references candidates(id) on delete cascade,
  job_id         uuid references jobs(id) on delete set null,
  stage_id       uuid references stages(id) on delete set null,
  stage_name     text,   -- snapshot legible sincronizado
  status         text check (status in ('active','rejected','hired','withdrawn')),
  source         text,
  cover_letter   text,
  rejected_at    timestamptz,
  hired_at       timestamptz,
  raw_data       jsonb,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now()
);

create index idx_applications_candidate on applications(candidate_id);
create index idx_applications_job       on applications(job_id);
create index idx_applications_stage     on applications(stage_id);
create index idx_applications_status    on applications(status);
create index idx_applications_updated   on applications(updated_at desc);

create trigger trg_applications_updated_at
  before update on applications
  for each row execute function set_updated_at();
```

---

## 7. `rejection_categories`

Catálogo normalizado. Ver ADR-007.

```sql
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
  ('other',               'Otro',                         999);
```

---

## 8. `evaluations`

```sql
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
```

---

## 9. `notes` (comentarios libres de Teamtailor)

**No confundir** con `evaluations.notes`.

```sql
create table notes (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid,
  teamtailor_id  text unique,
  candidate_id   uuid not null references candidates(id) on delete cascade,
  application_id uuid references applications(id) on delete set null,
  user_id        uuid references users(id) on delete set null,
  author_name    text,
  body           text not null,
  raw_data       jsonb,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now()
);

create index idx_notes_candidate   on notes(candidate_id);
create index idx_notes_application on notes(application_id);
create index idx_notes_body_trgm   on notes using gin (body gin_trgm_ops);

create trigger trg_notes_updated_at
  before update on notes
  for each row execute function set_updated_at();
```

---

## 10. `files` (CVs)

Ver ADR-006 para el ciclo de vida.

```sql
create table files (
  id              uuid primary key default uuid_generate_v4(),
  tenant_id       uuid,
  teamtailor_id   text unique,
  candidate_id    uuid not null references candidates(id) on delete cascade,
  storage_path    text not null,       -- path interno en bucket privado
  file_type       text,                -- pdf, docx, doc, txt, rtf
  file_size_bytes bigint,
  content_hash    text,                -- SHA-256 del binario
  parsed_text     text,
  parsed_at       timestamptz,
  parse_error     text,                -- unsupported_format, parse_failure, empty_text, likely_scanned
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
```

> **Nota**: no se almacena `file_url`. Las URLs firmadas se generan
> on-demand desde API routes autenticadas. Ver ADR-006.

---

## 11. `tags` y `candidate_tags`

```sql
create table tags (
  id         uuid primary key default uuid_generate_v4(),
  tenant_id  uuid,
  name       text unique not null,
  category   text,   -- skill, seniority, behavior, manual, auto
  created_at timestamptz not null default now()
);

create index idx_tags_category on tags(category);

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
```

---

## 12. `shortlists`

**Fase 1.** Ver spec §2.4.

```sql
create table shortlists (
  id          uuid primary key default uuid_generate_v4(),
  tenant_id   uuid,
  name        text not null,
  description text,
  created_by  uuid not null references app_users(id) on delete restrict,
  job_id      uuid references jobs(id) on delete set null,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_shortlists_created_by on shortlists(created_by);
create index idx_shortlists_job        on shortlists(job_id);

create trigger trg_shortlists_updated_at
  before update on shortlists
  for each row execute function set_updated_at();

create table shortlist_candidates (
  shortlist_id uuid not null references shortlists(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  added_by     uuid not null references app_users(id) on delete restrict,
  note         text,
  added_at     timestamptz not null default now(),
  primary key (shortlist_id, candidate_id)
);
```

---

## 13. `embeddings`

Ver ADR-005.

```sql
create table embeddings (
  id            uuid primary key default uuid_generate_v4(),
  tenant_id     uuid,
  candidate_id  uuid not null references candidates(id) on delete cascade,
  source_type   text not null check (source_type in ('cv','evaluation','notes','profile')),
  source_id     uuid,                                   -- FK lógica
  content       text not null,
  content_hash  text not null,                          -- SHA-256(content || model)
  embedding     vector(1536),                           -- text-embedding-3-small
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
```

> Con 5k candidates × 3 fuentes ≈ 15k embeddings. `lists = 100` es
> un buen compromiso hasta ~1M vectores. Reevaluar al crecer.

---

## 14. `sync_state`

Ver ADR-004.

```sql
create table sync_state (
  id                    uuid primary key default uuid_generate_v4(),
  entity                text unique not null,
  last_synced_at        timestamptz,
  last_cursor           text,
  last_run_started      timestamptz,
  last_run_finished     timestamptz,
  last_run_status       text check (last_run_status in ('idle','running','success','error')),
  last_run_error        text,
  records_synced        integer default 0,
  stale_timeout_minutes integer default 60,
  updated_at            timestamptz not null default now()
);

create trigger trg_sync_state_updated_at
  before update on sync_state
  for each row execute function set_updated_at();

insert into sync_state (entity, last_run_status) values
  ('stages', 'idle'),
  ('users', 'idle'),
  ('jobs', 'idle'),
  ('candidates', 'idle'),
  ('applications', 'idle'),
  ('evaluations', 'idle'),
  ('notes', 'idle'),
  ('files', 'idle');
```

---

## 15. `sync_errors`

Errores puntuales a nivel registro.

```sql
create table sync_errors (
  id             uuid primary key default uuid_generate_v4(),
  entity         text not null,
  teamtailor_id  text,
  error_code     text,
  error_message  text,
  payload        jsonb,
  run_started_at timestamptz not null,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index idx_sync_errors_entity     on sync_errors(entity);
create index idx_sync_errors_unresolved on sync_errors(resolved_at)
  where resolved_at is null;
```

---

## 16. Row Level Security

RLS activa en todas las tablas de dominio. Policies concretas en
migraciones, siguiendo el patrón del ADR-003.

Matriz de acceso:

| Tabla                                | recruiter             | admin     |
| ------------------------------------ | --------------------- | --------- |
| `candidates`                         | R/W (no soft-deleted) | R/W total |
| `jobs`                               | R                     | R/W       |
| `stages`                             | R                     | R/W       |
| `applications`                       | R/W                   | R/W       |
| `evaluations`                        | R                     | R/W       |
| `notes`                              | R/W                   | R/W       |
| `files`                              | R                     | R/W       |
| `tags`, `candidate_tags`             | R/W                   | R/W       |
| `shortlists`, `shortlist_candidates` | R/W                   | R/W       |
| `embeddings`                         | R (indirecto)         | R/W       |
| `users`                              | R                     | R/W       |
| `app_users`                          | ❌                    | R/W       |
| `sync_state`, `sync_errors`          | ❌                    | R/W       |
| `rejection_categories`               | R                     | R/W       |

El backend (ETL y embeddings worker) usa **service role key**, por
lo que RLS no aplica a esos jobs. RLS aplica exclusivamente a las
conexiones con JWT de usuario.

---

## 17. Vistas útiles (propuestas)

### `v_candidate_summary`

Una fila por candidate con: conteo de applications, última activa,
último stage, última evaluation, tags agregadas, última actividad.

### `v_dormant_candidates`

Candidates sin application activa hace más de
`DORMANT_THRESHOLD_MONTHS` (default 12).

### `v_rejection_insights`

Agregado por `rejection_category` × mes × job × departamento.

Las vistas se implementan en migraciones separadas cuando haya
consumidores concretos.

---

## 18. Diagrama ER (Mermaid)

```mermaid
erDiagram
  candidates ||--o{ applications : has
  candidates ||--o{ files : has
  candidates ||--o{ embeddings : has
  candidates ||--o{ candidate_tags : has
  candidates ||--o{ notes : has
  jobs ||--o{ applications : receives
  jobs ||--o{ stages : defines
  stages ||--o{ applications : holds
  applications ||--o{ evaluations : generates
  applications ||--o{ notes : context
  users ||--o{ evaluations : submitted_by
  users ||--o{ notes : authored_by
  rejection_categories ||--o{ evaluations : classifies
  tags ||--o{ candidate_tags : categorizes
  shortlists ||--o{ shortlist_candidates : groups
  candidates ||--o{ shortlist_candidates : listed_in
  app_users ||--o{ shortlists : created_by
  app_users ||--o{ candidate_tags : tagged_by
```

---

## 19. Convenciones de migraciones

- Archivos: `supabase/migrations/YYYYMMDDHHMMSS_description.sql`
- Cada migración es **idempotente**.
- Una migración = un cambio lógico. No mezclar refactors.
- Rollback documentado en comentario al inicio del archivo.
- RLS policies en migraciones separadas por tabla, naming
  `YYYYMMDDHHMMSS_rls_<tabla>.sql`.
