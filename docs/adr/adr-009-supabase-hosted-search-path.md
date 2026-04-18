# ADR-009 — Set database-wide search_path for Supabase hosted compatibility

- **Estado**: Aceptado
- **Fecha**: 2026-04-18
- **Decisores**: gabo (lead), Claude Code (co-author)
- **Relacionado con**: `supabase/migrations/20260417201204_extensions_and_helpers.sql`, `docs/data-model.md` §Extensiones requeridas, ADR-001 (Supabase + pgvector)

---

## Contexto

Durante el primer `supabase db push` contra un proyecto Supabase
**hosted** (remoto) la migración 002 (`app_users`) falla con:

```
ERROR: function uuid_generate_v4() does not exist (SQLSTATE 42883)
```

Causa raíz:

1. Supabase hosted **pre-instala** `uuid-ossp` (y otras extensiones
   de la lista permitida) en el schema `extensions`, no en `public`.
2. Cuando la migración 001 ejecuta
   `create extension if not exists "uuid-ossp"`, el CLI recibe un
   `NOTICE: extension already exists, skipping` y la extensión sigue
   residiendo en `extensions`.
3. El `search_path` por default del rol `postgres` en hosted es
   `"$user", public` — **no incluye** `extensions`.
4. Resultado: `uuid_generate_v4()` (sin calificar) no resuelve, y
   todas las migraciones que lo usan como default de `id uuid`
   revientan.

Supabase **local** (imagen del CLI) no sufre el problema porque su
bootstrap deja el `search_path` con `extensions` accesible, así que
las migraciones pasan sin fricción en dev.

Evidencia: `supabase db push` rompió en el environment remoto
linkeado, requirió workaround manual para desbloquear el primer
bootstrap. Ver `docs/status.md` 2026-04-18.

Restricciones:

- No podemos mover la extensión a `public` con
  `alter extension ... set schema public` porque Supabase reserva
  `extensions` y rota permisos allí; además rompería otras partes
  de la plataforma que esperan `extensions.uuid_generate_v4`.
- No queremos calificar a `extensions.uuid_generate_v4()` en cada
  `create table` porque contamina el schema con un detalle de
  deployment y dificulta leer las migraciones.
- No queremos sobrescribir `search_path` per-migración (requiere
  tocar 20+ archivos y olvidar uno vuelve a romper silenciosamente).

---

## Decisión

En la **migración 001** (`extensions_and_helpers.sql`) agregamos un
`alter database postgres set search_path = public, extensions;`
inmediatamente después de los `create extension`.

1. El `ALTER DATABASE` fija el `search_path` a nivel de base de
   datos (afecta toda conexión nueva, incluyendo las que abren las
   migraciones subsiguientes del mismo `supabase db push`).
2. `public` queda primero para mantener el default Postgres —
   objetos de dominio viven en `public`.
3. `extensions` queda segundo para que `uuid_generate_v4`,
   `gen_random_uuid`, `vector`, `pg_trgm` resuelvan sin calificar.
4. Para bases ya bootstrapped donde la migración 001 **ya ejecutó**
   (como el remoto actual), hay que aplicar el ALTER manualmente
   una vez — ver "Notas de implementación".

```sql
-- supabase/migrations/20260417201204_extensions_and_helpers.sql
create extension if not exists "uuid-ossp";
create extension if not exists "vector";
create extension if not exists "pg_trgm";

-- Supabase hosted instala extensiones en el schema `extensions`,
-- fuera del search_path default. Lo agregamos a nivel DB para que
-- funciones como uuid_generate_v4() resuelvan sin calificar en
-- todas las migraciones y en runtime. Idempotente y no destructivo.
alter database postgres set search_path = public, extensions;
```

---

## Alternativas consideradas

### A) Calificar toda referencia a funciones de extensión

Cambiar `default uuid_generate_v4()` → `default extensions.uuid_generate_v4()`
en cada migración.

- **Pros**: explícito; no depende de search_path.
- **Contras**: 20+ archivos modificados; el nombre `extensions` es
  una convención interna de Supabase que en otro deploy
  (self-hosted, CI local distinto) puede no existir; contamina la
  legibilidad de cada `create table`.
- **Descartada porque**: viola bounded/self-describing — el schema
  "correcto" depende del cloud provider.

### B) `alter extension ... set schema public`

Mover `uuid-ossp` (y otras) a `public` manualmente.

- **Pros**: cero cambios en search_path.
- **Contras**: Supabase otorga/revoca privilegios específicos al
  schema `extensions`; mover puede romper RLS helpers o la UI del
  Studio. Además el permiso para `alter extension` no siempre está
  disponible al role de migración.
- **Descartada porque**: lucha contra la plataforma en vez de
  alinearse con ella.

### C) `SET search_path` al comienzo de cada migración

Agregar `set local search_path = public, extensions;` al top de
cada archivo.

- **Pros**: sin efectos globales.
- **Contras**: 33 archivos; hay que acordarse para CADA migración
  futura; un olvido re-introduce el bug en silencio. No se chequea
  en CI.
- **Descartada porque**: viola verifiable — no hay gate que
  prevenga regresión.

### D) Usar `gen_random_uuid()` (`pgcrypto` / built-in pg13+)

Reemplazar `uuid_generate_v4()` por `gen_random_uuid()`.

- **Pros**: built-in en pg 13+, no requiere extensión.
- **Contras**: sigue sin estar en el search_path default de hosted
  (pgcrypto también vive en `extensions`). No soluciona el problema
  de raíz, sólo mueve la función culpable.
- **Descartada porque**: no resuelve; simplemente elige otra
  función que sufre el mismo síntoma.

---

## Consecuencias

### Positivas

- **Bootstrap hosted one-shot**: `supabase db push` contra un
  proyecto virgen Just Works, sin pasos manuales.
- **Cero duplicación**: una sola decisión en 001; todas las
  migraciones la heredan vía search_path.
- **Compatible con self-hosted y CLI local**: el ALTER es idempotente
  y no daña entornos donde `extensions` ya está en el path.

### Negativas

- **Asume DB llamada `postgres`**: Supabase hosted la nombra así;
  self-hosted también; si algún deploy usa otro nombre, la
  migración falla. Aceptable dado que el proyecto se casa con
  Supabase (ADR-001).
- **search_path de DB es estado global oculto**: alguien que lea
  el schema sin leer migración 001 puede confundirse con por qué
  `uuid_generate_v4()` resuelve sin calificar. Mitigado con un
  comentario explícito en la migración y este ADR.
- **Requiere fix-up manual para DBs con 001 ya aplicada**: en
  remotos pre-existentes (como el nuestro ahora) hay que correr
  el ALTER una vez a mano antes del próximo push. Operación de
  una-sola-vez por entorno.

---

## Criterios de reevaluación

- Si movemos fuera de Supabase (ADR-001 cambia), esto se
  reconsidera — otros Postgres pueden requerir enfoque distinto.
- Si Supabase cambia el schema default de extensiones (poco
  probable).
- Si agregamos un deploy con DB renombrada (no `postgres`),
  parametrizar el nombre.

---

## Notas de implementación

**Para la DB remota actual** (donde migración 001 ya corrió antes
de este ADR), aplicar una sola vez en el SQL Editor del Studio
remoto o vía `psql`:

```sql
ALTER DATABASE postgres SET search_path = public, extensions;
```

Sólo afecta conexiones **nuevas** — cerrar/reabrir el pool de
conexiones del CLI antes de re-intentar el push. En la práctica,
`supabase db push` abre conexiones frescas, así que un retry
inmediato alcanza.

**Para bootstraps futuros**, la migración 001 ya incluye el ALTER
y no se necesita ningún paso manual.
