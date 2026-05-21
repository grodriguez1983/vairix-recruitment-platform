# ADR-031 — Parallel chunked-IN fan-out en pipeline de matching

- **Estado**: Aceptado
- **Fecha**: 2026-05-21
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: ADR-017 (RLS scoping match_runs), F4-008
  (matching pipeline sub-D wiring)

---

## Contexto

Hoy (2026-05-21) `POST /api/matching/run` empezó a devolver `503
H12 Request timeout` en Heroku. Heroku tiene un hard cap de **30s**
por request dyno; el pipeline antes corría 23–27s y ahora consistentemente
se va a 30000ms → 503.

El catalizador fue la extracción masiva de CVs: ayer había ~989
`candidate_extractions` rows, hoy 5631 (drain wrapper v2 corriendo).
El pool de candidatos elegibles para matching creció ~6×.

### El pipeline

`runMatchJob` (`src/lib/matching/run-match-job.ts`) compone:

1. `loadJobQuery` (1 row, fast)
2. `createMatchRun` (1 insert)
3. `preFilter`:
   - `fetchAllCandidateIds` → SELECT all candidates, paginado por 500
   - `fetchCandidateMustHaveCoverage` → SELECT
     `experience_skills + candidate_experiences!inner`, chunked por
     `skill_id` (200) y paginado por 500
4. `loadCandidates`:
   - `loadExperiences` → SELECT `candidate_experiences + experience_skills`,
     chunked por `candidate_id` (200) y paginado por 500
   - `loadLanguages` → SELECT `candidate_languages`, chunked por
     `candidate_id` (200) y paginado por 500
5. `rank` (pure CPU)
6. `insertMatchResults`, `completeMatchRun`, rescue FTS

### El cuello

Los tres helpers chunked-IN (`fetchCandidateMustHaveCoverage`,
`loadExperiences`, `loadLanguages`) en `db-deps.ts` itera los chunks
**secuencialmente** con un for-loop manual:

```typescript
for (let i = 0; i < candidateIds.length; i += IN_CHUNK_SIZE) {
  const chunk = candidateIds.slice(i, i + IN_CHUNK_SIZE);
  const rows = await paginateRange<Row>('loadExperiences', ...);
  for (const r of rows) all.push(r);
}
```

A 5631 candidates con `IN_CHUNK_SIZE=200`:

- ~29 chunks por helper × 3 helpers = ~87 chunk-fetches sequenciales.
- Cada chunk hace su propia pagination interna (`.range(from, to)`),
  promedio 2-5 round-trips contra Supabase (depende de filas
  retornadas).
- Dyno→Supabase RTT en Heroku ~30-60ms.
- Total estimado: 87 × 3-RTT promedio × 45ms ≈ 12s solo de network,
  más el query time. Sumado a `loadCandidateAggregates` (que ya
  paraleliza experiences+languages a nivel exterior con `Promise.all`)
  el total se va sobre 30s.

### Por qué no fue obvio antes

Las queries chunked-IN se diseñaron para 1000-2000 candidates en
fase 1. A esa escala, ~10-20 chunks × ~30ms-RTT = 300-600ms de
network, hidden bajo el query time. La sequencialidad nunca dolió.

A 5631+ candidates (y proyectado a 15k+ cuando se complete el
backfill de TT) el coste se vuelve O(N) en HTTP round-trips y rompe
el ceiling de Heroku.

## Decisión

Permitir **bounded-parallel dispatch** de chunks en `runChunked`
(`src/lib/shared/chunked-in.ts`) y cablearlo en los tres call sites
de `db-deps.ts` con `concurrency=5`.

### 1. Extender el helper compartido

`runChunked` ya existe en `src/lib/shared/chunked-in.ts` como
secuencial. Agregar un parámetro opcional `{ concurrency }`:

```typescript
export async function runChunked<T>(
  ids: readonly string[],
  chunkSize: number,
  fetch: (chunk: string[]) => Promise<T[]>,
  options: { concurrency?: number } = {},
): Promise<T[]>;
```

- `concurrency: 1` (default) → mismo loop secuencial. Embeddings
  workers — los callers existentes — no se tocan.
- `concurrency: N > 1` → worker-pool de tamaño
  `min(N, chunks.length)` que pulea chunks de un contador
  compartido hasta drenar.
- **Output order**: se preserva el chunk-issue order
  independientemente del orden de completion. Esto es no-trivial:
  un `Promise.all(chunks.map(fetch))` lo daría gratis, pero el
  worker-pool con counter compartido requiere materializar los
  chunks up-front y escribir a slots indexados.
- **Failure semantics**: primer error se captura en una celda
  compartida `firstError`; workers restantes salen al próximo
  loop tick; el runner rethrowea el error original. Sin partial
  results — coincide con el contrato secuencial existente.

### 2. Wirear `db-deps.ts`

Reemplazar los 3 for-loops manuales por llamadas a `runChunked` con
`{ concurrency: CHUNK_CONCURRENCY }`. Constante local en
`db-deps.ts`:

```typescript
const CHUNK_CONCURRENCY = 5;
```

### 3. Por qué 5

Cota dura: el pool de Supavisor en el tenant (Supabase pooler) es
**~15 conexiones** por default. Cinco workers paralelos × tres
helpers ejecutados serialmente (preFilter primero, luego
loadCandidates con experiences+languages en Promise.all) implica
peaks de hasta 10 conexiones simultáneas durante
`loadCandidates`. Deja headroom para:

- Otros recruiters corriendo match en paralelo (5-15 usuarios totales).
- Workers de sync incremental.
- Edge functions de embeddings.

A 8-10 workers/chunk pegaríamos el ceiling de Supavisor durante
spikes, lo que se traduce en `ERROR: max client connections
reached` y degradación cascade. 5 es la opción conservadora hasta
tener telemetría.

## Consecuencias

**Positivas**

- Wall-clock de los tres helpers cae de ~29 chunks de RTT a
  ~ceil(29/5) = 6 chunks de RTT. Cut esperado: 5× en network-bound
  cost.
- El primitivo `runChunked` queda reusable para cualquier otro
  caller que necesite chunked-IN con paralelismo (ej. embeddings
  futuro a escala).
- Sin schema change, sin migración, sin cambio de contrato externo
  (`/api/matching/run` devuelve el mismo JSON).

**Negativas**

- Spike de conexiones simultáneas contra Supavisor: 5 en
  `fetchCandidateMustHaveCoverage`, 5+5=10 en `loadCandidates`.
  Si el tenant tiene >2 match runs concurrentes esto se acerca al
  ceiling. Mitigación: monitorear `pg_stat_activity` en producción
  durante las primeras semanas; bajar a 3 si aparecen
  `max_connections` errors.
- Los chunks ya no se sirven en orden de completion → si un chunk
  tarda más que el resto, retiene resources hasta resolver. Cota
  superior aceptable: cualquier chunk individual debe terminar bien
  bajo 30s por el PostgREST timeout interno.
- Test order de chunks individuales no es determinístico para los
  callers — pero `loadCandidates` y `fetchCandidateMustHaveCoverage`
  ya agrupan resultados por `candidate_id` con `Map` post-fetch, así
  que el orden de chunks no afecta la salida final.

**Descartadas**

- **Mover el pre-filter al DB con una RPC** (Plan B en el plan
  original). Es el fix estructural correcto — colapsa
  `fetchAllCandidateIds + fetchCandidateMustHaveCoverage +
  loadCandidates` en un SELECT server-side que solo devuelve los
  candidatos elegibles. Pero requiere diseñar la RPC, decidir
  encoding del `ResolvedDecomposition`, plpgsql con type checking
  contra el schema, y migrar tests. Es la siguiente decisión, no
  esta. Queda registrado como follow-up en `docs/status.md`.
- **Async job pattern** (return 202 + polling). Cambio de contrato
  externo, requiere worker process (Heroku scheduler o queue),
  refactor del UI. Mayor scope, fuera de proporción para el
  incidente.
- **Subir el timeout de Heroku**. No hay dial: 30s es hard cap por
  diseño en el routing layer, no configurable.

## Plan de verificación

### Unit (TDD)

`src/lib/shared/chunked-in.test.ts`:

- `test_default_behavior_is_sequential` — `concurrency` default = 1
  mantiene at-most-1 in-flight (regression guard para embeddings).
- `test_dispatches_up_to_3_chunks_in_parallel` — con `concurrency:
  3` y 6 chunks, observar exactamente 3 in-flight tras dispatch
  inicial (clave RED).
- `test_never_inflates_beyond_chunk_count` — con `concurrency: 3` y
  2 chunks, ceiling = 2.
- `test_preserves_chunk_issue_order_under_concurrency` — chunk 0
  tarda más que chunk 2; output sigue ordenado [chunk0, chunk1,
  chunk2].
- `test_rejects_zero_negative_non_integer_concurrency`.
- `test_chunk_failure_under_concurrency_surfaces_error`.

### Validación operativa

Tras deploy a Heroku:

1. Re-ejecutar el `curl POST /api/matching/run` que dio 503
   (`job_query_id` con el pool de 5631 candidates).
2. Medir `service` time en `heroku logs --tail` para 3-5 runs
   consecutivos.
3. **Pass**: p99 < 25s con headroom de 5s. Confirma el fix.
4. **Marginal**: 25-29s. Fix landeó pero quedamos pegados al
   ceiling — abrir trabajo de Plan B con urgencia.
5. **Fail**: > 29s. Cuello no era esto; revertir y volver a la fase
   de investigación con timestamps por etapa.

### Telemetría a observar (próximas 48h)

- `pg_stat_activity` count contra la DB Supabase: pico esperado en
  10-12 conns durante un match run, sin alcanzar 15.
- Heroku `service` time p50/p95/p99 en `/api/matching/run`.
- `match_runs.diagnostics` payload — verificar que
  `candidates_evaluated` sigue siendo igual a antes (sanity check
  que no perdimos datos por orden inconsistente).
