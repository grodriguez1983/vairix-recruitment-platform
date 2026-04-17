---
name: supabase-migrations
description: Cómo crear, aplicar y revertir migraciones de Supabase siguiendo las convenciones del repo. Usar cuando la tarea requiera cambios de schema, nuevas tablas/columnas/índices, RLS policies, seeds, o funciones SQL.
---

# Supabase Migrations

## Cuándo aplicar este skill

- Crear una tabla, columna, índice, función, trigger.
- Modificar RLS policies.
- Poblar un catálogo (seed).
- Regenerar tipos TypeScript.
- Cambiar una vista.

## Principios no negociables

1. **Una migración = un cambio lógico.** No mezclar tabla nueva
   + refactor de otra + seed en un solo archivo.
2. **Todas las migraciones son idempotentes.** Usar
   `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
   `INSERT ... ON CONFLICT DO NOTHING`.
3. **Forward-only.** No se editan migraciones aplicadas. Si hay
   que revertir, crear una nueva que compense.
4. **RLS siempre activa en tablas de dominio.** Si el PR agrega
   una tabla sin RLS, es rechazado por review (ver ADR-003).
5. **Tipos regenerados y committeados en el mismo PR** que la
   migración.

## Workflow

```bash
# 1. Arranque local
supabase start

# 2. Crear migración vacía con timestamp
supabase migration new add_candidate_email_index

# 3. Editar el archivo SQL
# → supabase/migrations/YYYYMMDDHHMMSS_add_candidate_email_index.sql

# 4. Aplicar local y verificar diff
supabase db reset      # CUIDADO: solo local, Tier 1
supabase db diff       # debe estar limpio tras aplicar

# 5. Regenerar tipos
pnpm supabase:types
# → src/types/database.ts

# 6. Correr tests de RLS que toca
pnpm test tests/rls/<tabla>.test.ts

# 7. Commit
git add supabase/migrations/ src/types/database.ts
git commit -m "feat(db): add email index on candidates"
```

## Convenciones de naming

Archivo:

```
supabase/migrations/YYYYMMDDHHMMSS_<verb>_<scope>.sql
```

Verbos estándar: `add`, `alter`, `drop` (rara vez), `seed`,
`rls`, `fn` (función), `trigger`.

Ejemplos:
- `20260501120000_add_candidates.sql`
- `20260501120100_rls_candidates.sql`
- `20260501120200_seed_rejection_categories.sql`
- `20260501120300_fn_set_updated_at.sql`

**Regla**: una migración de schema **no contiene** policies RLS.
Van en un archivo aparte `*_rls_<tabla>.sql` con timestamp
posterior. Esto facilita review separado.

## Patrón base de tabla

```sql
-- Cada columna según data-model.md
create table if not exists <table> (
  id            uuid primary key default uuid_generate_v4(),
  tenant_id     uuid,
  ...
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Índices (incluir los de data-model.md)
create index if not exists idx_<table>_<col> on <table>(<col>);

-- Trigger updated_at (la función ya existe de migración 001)
create trigger trg_<table>_updated_at
  before update on <table>
  for each row execute function set_updated_at();

-- Comentario al inicio del archivo:
-- Rollback: drop table <table> cascade;
```

## Patrón de RLS policy

```sql
-- En archivo separado: YYYYMMDDHHMMSS_rls_<table>.sql

-- 1. Activar RLS
alter table <table> enable row level security;

-- 2. Policy por operación (select/insert/update/delete)
create policy "read_visible_<table>"
  on <table> for select
  using (
    deleted_at is null
    or (auth.jwt() ->> 'role') = 'admin'
  );

-- 3. Test correspondiente en tests/rls/<table>.test.ts
```

**Regla**: toda policy tiene un test adversarial que intenta
violarla con un JWT de role incorrecto y verifica el rechazo.

## Seeds

Seeds permanentes (catálogos) van en migraciones con
`INSERT ... ON CONFLICT DO NOTHING`. Ejemplo: `rejection_categories`.

Seeds de desarrollo (datos de prueba) van en `supabase/seed.sql`.
Ese archivo NO se aplica en producción.

## Operaciones delicadas

Tier 2+ (ver `docs/operation-classification.md`), requieren
confirmación humana y ADR:

- `ALTER TABLE ... DROP COLUMN`
- `ALTER TABLE ... ALTER COLUMN TYPE` con posible pérdida
- `DROP TABLE` (no debería pasar; preferir deprecar)
- Revocar policy RLS

Forma preferida de borrar una columna obsoleta:

1. Crear migración que la marque deprecated (comentario).
2. Refactor del código para no usarla (varios PRs).
3. Una vez confirmado que no hay references, migración que la
   `DROP COLUMN`. Ese PR requiere aprobación de un admin.

## Tipos TypeScript

- **Generados automáticamente** con:
  ```bash
  supabase gen types typescript --local > src/types/database.ts
  ```
- **Nunca** editarlos a mano.
- El comando está en `package.json` como `pnpm supabase:types`.
- CI verifica que el archivo esté actualizado:
  ```bash
  pnpm supabase:types
  git diff --exit-code src/types/database.ts
  ```
  Si hay diff → la PR no regeneró tipos.

## Producción

**Nunca** `supabase db reset` contra producción. Tier 3, ver
`operation-classification.md`.

Push de migraciones:

```bash
supabase db push --linked
```

Siempre desde un branch protegido (post-merge a main), idealmente
vía workflow de CI con manual approval.

## Checklist para PR de migración

- [ ] Una migración por cambio lógico.
- [ ] Rollback documentado en comentario al inicio.
- [ ] RLS policy en archivo aparte si aplica.
- [ ] Test RLS correspondiente.
- [ ] Tipos TS regenerados.
- [ ] `supabase db diff` vacío tras aplicar.
- [ ] Data model doc actualizado si el cambio es estructural.
- [ ] ADR si la decisión es no obvia.

## Referencias

- `docs/data-model.md` — schema canónico.
- ADR-003 — auth y RLS.
- `docs/operation-classification.md` — tiers de operaciones.
- `.claude/skills/rls-policies/SKILL.md` — detalles de RLS.
