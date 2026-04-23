# ADR-019 — Dedicated Supabase instance for the test suite

- **Estado**: Aceptado
- **Fecha**: 2026-04-23
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: `docs/test-architecture.md`,
  `supabase-test/supabase/config.toml`,
  `tests/setup/load-test-env.ts`, `.env.test`,
  `vitest.config.ts`, `tests/rls/helpers.ts`

---

## Contexto

Hasta hoy la suite de tests (unit + integration + RLS) corría
contra la **misma** instancia local de Supabase que usa el
desarrollo (`supabase start`, project_id `recruitment-platform`,
ports 54321/54322). `vitest.config.ts` ya documentaba el riesgo:

> RLS tests hit a shared local Supabase; running in parallel
> causes cross-test state bleed.

La solución previa — `fileParallelism: false` — ordena los tests
pero no los aísla de la data productiva local. Los tests de
integración (`tests/integration/**`) y RLS (`tests/rls/**`)
ejecutan `delete()` scopeados por `teamtailor_id` de fixtures y
dependen de FKs con `ON DELETE CASCADE`.

### Incidente gatillante (2026-04-22)

Ese día el dev env tenía data de un smoke test recién hecho
(`SYNC_MAX_RECORDS=200 pnpm sync:incremental candidates`):
200 candidatos, 195 resume files + 15 uploads parseados,
~580 embeddings. Para validar un cambio de prompt (cambio
totalmente independiente del ETL) se corrió `pnpm vitest run` —
879 tests en verde, pero la query de matching que antes traía
candidatos pasó a devolver 0 rows. El diagnóstico: algún test de
integración o RLS hizo cleanup que, vía CASCADE, se llevó
`candidates → files → cv_extractions → candidate_embeddings`.
El costo: volver a correr ETL + parse + extract + embed (tiempo +
créditos OpenAI).

Reproducible. El riesgo estaba **documentado** pero no
**estructuralmente bloqueado** — violación del principio §4
"Defended" de las 7 propiedades.

## Decisión

Correr toda la suite de tests contra una **segunda instancia
local de Supabase**, totalmente separada de la de dev.

### Layout

```
supabase/                     # dev instance (project_id=recruitment-platform)
  config.toml                 # ports 54321/54322/…
  migrations/                 # single source of truth
supabase-test/                # workdir para el CLI — no es un repo aparte
  supabase/
    config.toml               # project_id=recruitment-platform-test, ports 64321/64322/…
    migrations -> ../../supabase/migrations   # symlink, NO duplicar migraciones
```

Las migraciones se comparten por symlink: el schema queda
**single-sourced** y cada migración nueva se refleja en ambas DBs
con el mismo flujo (`pnpm test:db:reset` re-aplica todo).

### Port block

Bloque dev + 10000 para que las dos instancias convivan sin colisión:

| servicio        | dev   | test  |
| --------------- | ----- | ----- |
| API / REST      | 54321 | 64321 |
| Postgres        | 54322 | 64322 |
| Postgres shadow | 54320 | 64320 |
| Pooler          | 54329 | 64329 |
| Studio          | 54323 | 64323 |
| Inbucket        | 54324 | 64324 |
| Analytics       | 54327 | 64327 |
| Edge inspector  | 8083  | 8093  |

### Wiring

- `.env.test` (commiteado, no contiene secrets — son las claves
  well-known del CLI) pone `SUPABASE_TEST_URL=http://127.0.0.1:64321`
  - las legacy anon/service_role JWTs que firma el JWT secret
    well-known.
- `tests/setup/load-test-env.ts` es un `setupFile` de vitest que
  parsea `.env.test` sin dependencias externas. Precedencia
  dotenv-standard: variables ya presentes en el shell / CI ganan
  sobre `.env.test`.
- `vitest.config.ts` registra ese setupFile.
- `package.json` expone `test:db:start | stop | reset | status`
  que delegan a `supabase ... --workdir supabase-test`.

### Tests no cambian

Todos los test files ya leían `SUPABASE_TEST_URL`,
`SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_SERVICE_ROLE_KEY`,
`SUPABASE_TEST_JWT_SECRET` con fallback a defaults que apuntaban
al dev env. La migración es 100% en la configuración: los
fallbacks siguen apuntando al dev env (útil si alguien corre un
test sin levantar el test-db y quiere fail loud), pero cuando
vitest carga `.env.test` los `SUPABASE_TEST_*` ganan y apuntan al 64321.

## Consecuencias

### Positivas

- La data del dev env nunca puede ser destruida por la suite,
  por construcción (puertos distintos, project_id distinto,
  volúmenes docker distintos).
- `pnpm test:db:reset` es seguro de correr siempre; no hay que
  preguntarle al user. Destapa un ciclo más rápido para
  debuggear tests flaky.
- CI puede reutilizar el mismo flujo: `pnpm test:db:start` en un
  step + `pnpm vitest run` en el siguiente.
- `fileParallelism: false` sigue justificado porque los RLS
  tests comparten la misma test-DB entre sí, pero el daño
  máximo de un bug de cleanup es un `pnpm test:db:reset`.

### Negativas

- Boot time: `supabase start --workdir supabase-test` toma
  ~1.5 min la primera vez (pull del postgres image) y ~30s en
  arranques siguientes. Mitigado con `test:db:status` para
  detectar si ya está corriendo.
- Requiere tener **dos** stacks de Docker corriendo
  simultáneamente en la máquina del dev — ~8 containers extra.
  Aceptable para una máquina de desarrollo moderna.
- Memoria adicional: dos Postgres + dos Studio + dos
  realtime/storage/… El test-DB se puede stopear con
  `pnpm test:db:stop` cuando no se usa.

### Neutras

- CLI quirk: `supabase` del devDependency (v1.226) solo acepta
  `db.major_version = 15` pero la CLI global (v2.90) corre
  postgres 17.6.x igualmente. El config pineó `15` por
  compatibilidad con `supabase db reset` del devDependency.

## Alternativas consideradas

1. **Mockear la DB en tests de integración.** Descartado: el
   `feedback_vitest_destroys_dev_db.md` deja claro que el valor
   de estos tests viene de hittear Postgres real (policies RLS,
   FKs, triggers). Un mock nos daría tests verdes que no reflejan
   prod.
2. **Usar transactions + rollback en cada test.** Descartado:
   Supabase client abre sus propias conexiones por llamada, no
   hay un "test transaction" barato. Además muchos tests
   necesitan que el cambio sea visible a otro cliente (admin
   seed → recruiter read).
3. **Un solo Postgres con schemas separados (`public_test`).**
   Descartado: auth y storage de Supabase viven en schemas
   fijos; replicarlos para tests es el 90% del trabajo de una
   segunda instancia pero con más puntos de fragilidad.
4. **Branches de Supabase Cloud.** Descartado por costo y latencia
   para una suite que corre 100+ veces por día en local.
