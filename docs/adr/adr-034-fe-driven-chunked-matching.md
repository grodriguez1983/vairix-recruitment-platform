# ADR-034 — Pipeline de matching chunked, orquestado desde el frontend

- **Estado**: Propuesto
- **Fecha**: 2026-05-21
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: ADR-031 (parallel chunked-IN), ADR-032 (chunked INSERT),
  ADR-033 (server-side RPC pipeline), F4-008 (matching pipeline sub-D)

---

## Contexto

ADR-033 movió las dos etapas de lectura (preFilter + loadCandidates) a
RPCs server-side. La validación post-aplicación (2026-05-21, prod con
~8 700 candidatos) descubrió tres techos simultáneos que el modelo
sync request-response **no puede resolver** combinando solo los fixes
anteriores:

1. **Heroku H12 = 30s**. La request HTTP del `POST /api/matching/run`
   tiene que terminar el pipeline completo (loadJobQuery → preFilter →
   loadCandidates → rank → inserts → complete → rescue) en ese
   presupuesto. Aún con todas las RPCs optimizadas, el wall-time crece
   linealmente con el pool y ya excede 30s.

2. **`statement_timeout` por rol `authenticated` = 8s** por default
   en Supabase. La migración `20260521000003` lo subió a 60s **por
   función** para las dos RPCs, pero no rescata al request HTTP: H12
   sigue siendo el techo externo.

3. **JSONB blob de `loadCandidates`**. La RPC devuelve un array
   serializado con todos los candidatos elegibles, sus experiencias,
   skills y languages. A 8 700 cands × ~2 KB cada uno = ~17 MB. El
   blob tiene que materializarse en memoria en Postgres, cruzar
   PostgREST (cap ~1 MB por config) y deserializarse en el cliente.
   Crece linealmente con el pool — empeora con el tiempo.

Además hay un problema de UX que se vuelve estructural a esta escala:
el recruiter espera 30+ segundos viendo un spinner sin saber si está
pasando algo o se colgó, sin posibilidad de cancelar.

### Por qué llegamos acá

ADR-031, ADR-032 y ADR-033 fueron tres optimizaciones mecánicas
sucesivas (paralelización del IN, chunking del INSERT, RPCs) que
bajaron el wall-time pero **mantuvieron el modelo sync**. A 200–500
candidatos el modelo sync era barato. A 5 000+ tiene un cliff
estructural que ya tocamos. El siguiente cambio no es otra
optimización — es un cambio de modelo de ejecución.

## Decisión

Cambiar el modelo de **sync request-response** a **FE-driven chunked**:

- El backend deja de orquestar el pipeline completo en una sola
  request. Expone **tres endpoints stateless entre sí**.
- El frontend itera explícitamente: pide chunks de a 500 candidatos,
  uno tras otro, hasta procesar el pool.
- Cada request HTTP individual cabe holgadamente en el budget H12.
- Resultados parciales se muestran en el FE a medida que cada chunk
  responde. Hay barra de progreso real y botón "Cancelar".

**Punto clave del modelo**: el backend **no corre ningún loop ni
background job**. Si el usuario se va, simplemente nadie llama más.
No hay procesos colgados.

### Contrato: tres endpoints

#### 1. `POST /api/matching/run/start`

Trabajo barato + plan de iteración.

- Body: `{ job_query_id: uuid, top_n: int }`
- Backend:
  - `loadJobQuery` + `createMatchRun(status='running')`
  - `preFilter` (RPC `match_pre_filter`, ya cabe en 60s)
  - Persiste `match_runs.expected_count = included.length`
- Response: `{ run_id, included: uuid[], excluded: [...], total: number }`
- Duración esperada: <5s.

El FE recibe la lista completa de `included` (~5 500 uuids = ~200 KB)
y mantiene esa lista en memoria durante la iteración. `excluded` se
guarda para el `/finalize`.

#### 2. `POST /api/matching/run/:id/process-chunk`

El workhorse — el FE llama N veces, una por chunk.

- Body: `{ candidate_ids: uuid[] }` (chunk de hasta 500 ids, slice
  del `included` que el FE conoce).
- Backend:
  - `loadCandidates(chunk)` — RPC `match_load_aggregates` con ~500
    ids = ~1 MB JSONB, sub-segundo.
  - `rank(chunk)` — CPU local, ~ms.
  - `insertMatchResults` — chunk único de hasta 500 rows (ADR-032).
  - `UPDATE match_runs SET processed_count = processed_count + N,
last_progress_at = now() WHERE id = :id`.
- Response: `{ processed_count, total, new_results: CandidateScore[] }`
- Duración esperada: ~3–5s por chunk.

El `rank` que se guarda en `match_results.rank` durante esta fase es
**local al chunk** (provisional). El re-rank global ocurre en
`/finalize`.

#### 3. `POST /api/matching/run/:id/finalize`

Cierre — una sola vez al final del loop del FE.

- Body: `{ excluded: PreFilterExcludedCandidate[] }` (el FE lo
  recibió en `/start`).
- Backend:
  - Re-rank global:
    `UPDATE match_results SET rank = row_number() OVER (ORDER BY total_score DESC)
 WHERE match_run_id = :id`.
  - `rescueFailedCandidates` con `failed` re-derivados desde
    `match_results WHERE must_have_gate = 'failed' AND match_run_id = :id`,
    más `excluded` recibidos del body.
  - `completeMatchRun(status='completed')`.
- Response: `{ candidates_evaluated, top: CandidateScore[], rescues_inserted }`
- Duración esperada: <2s.

### Loop del FE

```
1. POST /start → { run_id, included, excluded }
2. chunks = chunkBy(included, 500)
3. for chunk in chunks:
     if user_clicked_cancel: break
     resp = POST /process-chunk { candidate_ids: chunk }
     UI: actualizar barra processed/total
     UI: mergear resp.new_results en el top-N visible (heap de tamaño top_n)
4. POST /finalize { excluded } → { top, rescues_inserted }
```

## Consecuencias

### Positivas

- **H12 deja de ser el techo**. Cada request individual es corta
  (<5s típica). El pool puede crecer indefinidamente sin tocar este
  límite.
- **El JSONB blob queda acotado a 1 MB por chunk**. Cabe bajo el
  cap de PostgREST.
- **UX real**: progreso visible, cancelación gratis.
- **Sin background jobs ni dyno-recycle worries**. No hay nada
  corriendo cuando nadie llama.
- **Cancelación inherente**: el FE corta el loop. No requiere flag
  cooperativo en el server, no requiere chequeo per-chunk, no hay
  estado intermedio raro.
- **Cada endpoint es testeable individual** — no hay orquestador de
  loop server-side que probar.

### Costos

- **Round-trips**: ~12 chunks × ~100 ms RTT = ~1.2s de overhead de
  red. Despreciable frente al cost original.
- **Browser tab activa requerida** durante el run. Si el usuario
  cierra la pestaña a mitad, el run queda inacabado. Es exactamente
  el comportamiento deseado (no procesos colgados).
- **Re-ranking final** con `row_number()` requiere una query extra
  al cierre. Es barata pero existe.
- **Runs incompletos en `running`**: cuando el FE abandona, el
  `match_run` queda en `running` con `processed < expected`.
  Mitigación: cron (o limpieza on-demand) que marca como
  `abandoned` los runs con `last_progress_at < now() - 30min`.

### Cambios al schema

Migración nueva, aditiva, sin tocar datos existentes:

- `match_runs.expected_count integer null` — set por `/start`.
- `match_runs.processed_count integer not null default 0` — avanza
  por cada `/process-chunk`.
- `match_runs.last_progress_at timestamptz null` — heartbeat para
  el cron de cleanup.
- Nuevo valor para el enum `match_run_status`: `'abandoned'`.
  Constraint del state-machine: `'running' → 'abandoned'` permitido.

### Cambios al contrato API

Breaking change para el endpoint `POST /api/matching/run` original:
antes devolvía el resultado final completo en una sola request;
ahora se reemplaza por los tres nuevos endpoints. Como esta API es
**puramente interna** y la única consumidora es el propio FE de la
app, se hace en un solo PR con FE + BE juntos.

## Alternativas consideradas

### A. Background job (worker o fire-and-forget)

Idea: el POST devuelve `run_id` inmediato, un proceso server-side
hace el loop autónomamente, el FE pollea para ver progreso.

**Rechazada** porque:

- Si el usuario abandona, el job sigue corriendo y consumiendo
  recursos hasta terminar.
- Requiere cancelación cooperativa (flag chequeado per-chunk).
- Fire-and-forget pierde el job en dyno-recycle. Worker dyno
  introduce queue table + monitoring nuevo.
- Modelo mental más complejo: hay que distinguir entre estado del
  request HTTP, estado del job, estado del match_run.
- Tests del orquestador requieren mockear el chunker server-side.

El modelo FE-driven elimina todos estos costos por construcción.

### B. Mantener sync + subir timeouts más

Rechazada — H12 es externo. No lo controlamos.

### C. SSE / Streaming desde el endpoint POST

Rechazada — el SSE vive dentro de una request HTTP, así que sigue
atado a H12. Resuelve la UX pero no el techo de duración.

### D. Realtime / WebSocket sobre `match_runs` + `match_results`

Rechazada por overkill para 5–15 usuarios internos. El polling
implícito del FE (que ya hace requests secuenciales) ya da
progreso en tiempo real. Realtime introduce dependencia y
complejidad de debugging que no se justifica.

## Notas de implementación

- El FE puede paralelizar `/process-chunk` calls (ej. 2 en flight)
  si en el futuro se quiere apretar más el wall-time. No es parte
  de este ADR — empezamos secuencial.
- El cron de cleanup de runs `abandoned` no es bloqueante para
  shipping — puede agregarse en una iteración posterior. Los runs
  abandoned simplemente quedan visibles con su `processed_count`
  como evidencia de progreso parcial.
- Auth + ownership: cada endpoint valida sesión + que el `run_id`
  pertenezca al `triggered_by` correcto (igual que el endpoint
  original). El estándar `requireAuth()` + check explícito en el
  service.
