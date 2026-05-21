# ADR-032 — Chunked INSERT en `insertMatchResults`

- **Estado**: Propuesto
- **Fecha**: 2026-05-21
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: ADR-031 (parallel chunked-IN matching), F4-008

---

## Contexto

ADR-031 paralelizó el fan-out de chunked-IN en el pipeline de
matching y aterrizó en producción (Heroku v8, 2026-05-21 13:56).
La validación inmediata mostró que el fix funcionó como diseño —
las dos etapas de lectura cayeron de ~30s combinados a ~14s — pero
el wall-clock total siguió rompiendo el ceiling de Heroku porque
**un nuevo cuello aparece downstream**.

### Medición posterior al deploy

Ejecutando `runMatchJob` contra el mismo `job_query`
`c5cf4efe-14fb-4007-89ac-0d2eb02976e5` (pool ~5_500 candidates,
el que tiraba 503 antes del fix), instrumentado por etapa:

| Etapa                    | ms         | Estado                       |
| ------------------------ | ---------- | ---------------------------- |
| `loadJobQuery`           | 314        | ok                           |
| `createMatchRun`         | 257        | ok                           |
| `preFilter`              | 4 655      | **fast (ADR-031)**           |
| `loadCandidates`         | 9 293      | **fast (ADR-031)**           |
| `rank`                   | 103        | ok                           |
| **`insertMatchResults`** | **26 856** | **FAIL — statement timeout** |
| `failMatchRun`           | 1 133      | ok                           |
| **wall total**           | **42 612** | **fail**                     |

`insertMatchResults` (`src/lib/matching/db-deps.ts:272`) emite
**un único** `.from('match_results').insert([...5500 rows])` —
Supabase-js serializa todo a un POST y PostgREST lo ejecuta como
un solo statement Postgres. A ~5_500 filas con `breakdown_json`
JSONB (por candidato: array de requirement-breakdowns + language +
seniority, típicamente ~2 KB por row), el statement excede el
`statement_timeout` del rol (60s para `service_role`, ~30s para
`authenticated`) y aborta con
`canceling statement due to statement timeout`.

### Por qué no fue obvio antes

Hasta ADR-031, la etapa de reads se llevaba 20–30s del budget de
30s, así que el INSERT raras veces se ejecutaba con un pool grande
— los runs grandes ya morían arriba. Con reads acelerados, el
INSERT se vuelve el primer paso que efectivamente se ejecuta sobre
el pool completo, y la línea de costo `O(rows × index_writes ×
RLS_check + trigger overhead)` ahora domina.

## Decisión

Chunkear `insertMatchResults` en batches de tamaño fijo y emitir
las inserts **secuencialmente**:

```typescript
const INSERT_CHUNK_SIZE = 500;

insertMatchResults: async (runId, rows) => {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
    const { error } = await supabase
      .from('match_results')
      .insert(chunk.map(/* same mapping as today */));
    if (error) throw new Error(`insertMatchResults: ${error.message}`);
  }
};
```

### 1. Por qué 500

- **Body size**. PostgREST default `max_body_size` ≈ 1 MB. Con
  ~2 KB por row, 500 rows ≈ 1 MB — pegados al límite pero bajo,
  con margen.
- **Statement timeout**. Cada chunk se ejecuta como un statement
  separado. A ~5 ms/row de costo de INSERT (incluye trigger del
  state machine + índices + RLS check), 500 rows ≈ 2.5 s por
  chunk → 11 chunks × 2.5 s ≈ 28 s para 5_500 rows. Sigue siendo
  pesado pero **cada statement individual queda muy bajo el
  timeout**, eliminando el fail-mode actual.
- **Round-trip cost**. 11 round-trips secuenciales × 30–60 ms RTT
  ≈ 500 ms de overhead — despreciable contra el coste de query.

### 2. Secuencial, no paralelo

A diferencia de los reads (ADR-031), los inserts:

- Compiten por el **mismo set de páginas** en `match_results` (un
  índice único `(match_run_id, candidate_id)` y otros). Paralelizar
  multiplica contención de locks sin reducir wall-clock.
- Tocan el **mismo write-buffer** de Postgres. Paralelizar 5
  workers no acelera el flush a disco.
- Heroku tiene un solo dyno escribiendo — paralelizar el lado del
  cliente no abre más conexiones de escritura útiles.

Si más adelante mediciones reales muestran beneficio, abrir un ADR
follow-up. Pero la heurística por defecto es "writes son
secuenciales".

### 3. Por qué no llevar el INSERT al servidor (RPC)

Es la opción correcta a largo plazo — combinada con el Plan B
diferido en ADR-031, colapsaría las dos etapas de lectura +
filtering + ranking + INSERT en un solo round-trip server-side. Pero
requiere:

- Diseñar la RPC con encoding del `ResolvedDecomposition`.
- Migrar el ranker a plpgsql (o invocar una edge function desde la
  RPC).
- Tests nuevos contra el comportamiento server-side.

Es follow-up estructural, fuera de alcance para parchar el
incidente de hoy. Queda registrado en `docs/status.md`.

## Consecuencias

**Positivas**

- Cada INSERT individual se mantiene bajo cualquier
  `statement_timeout` razonable. Elimina el modo de falla actual.
- Wall-clock esperado del pipeline para 5_500 candidates:
  ~14 s (reads ADR-031) + ~12–18 s (11 inserts × ~1.5 s) ≈ 26–32 s.
  **Probable: marginal aún para Heroku 30 s**; pero ya no
  determinístico-fail. Si quedamos pegados, sigue Plan B (RPC).
- Cero cambios de schema, contrato externo, o auth.

**Negativas**

- Wall-clock **mayor** que un INSERT bulk exitoso (porque
  agregamos round-trip overhead). El benchmark esperado: cuando
  el bulk SÍ termina antes del timeout (pool ≤ ~1_000 candidates),
  el chunked secuencial es ~5–10 % más lento. Aceptable a cambio
  de robustez.
- Si un chunk intermedio falla, los chunks previos ya están
  insertados. El run termina en estado `failed` por
  `failMatchRun`, pero las filas quedan huérfanas. **Mitigación**:
  el FK `match_results.match_run_id → match_runs.id` está marcado
  `ON DELETE CASCADE`; un GC futuro de runs `failed` limpiaría
  esto. Aceptable porque coincide con el estado actual de fallas
  parciales (el INSERT bulk también deja state inconsistente si
  falla mid-statement antes del rollback).

**Descartadas**

- **Bulk COPY**. Supabase-js / PostgREST no exponen `COPY FROM
STDIN`. Requeriría conexión directa al pooler con `pg` client,
  saliendo del cliente Supabase actual.
- **Paralelizar inserts** con `runChunked({ concurrency: N })`. Ver
  §2 arriba — no aporta y multiplica contención de locks.
- **Bajar `breakdown_json` payload size** (omitir branches no
  resueltas). Es saneo legítimo pero ortogonal — no resuelve el
  problema base de "muchas rows en un statement".
- **Mover a async (202 + worker)**. Cambio de contrato, fuera de
  proporción para el incidente.

## Plan de verificación

### Unit (TDD)

`src/lib/matching/db-deps.test.ts` (nuevo, RED commit):

- `test_no_op_when_rows_empty` — sin filas, no se llama a
  `supabase.from`.
- `test_single_chunk_when_rows_fit_under_threshold` — 10 filas →
  1 insert.
- `test_splits_inserts_into_multiple_chunks_when_rows_exceed_threshold`
  (clave RED) — 1_500 filas → ≥ 2 inserts, cada uno ≤
  `INSERT_CHUNK_SIZE`.
- `test_total_inserted_rows_equals_input` — suma de filas
  insertadas = filas de entrada (sin duplicados, sin pérdida).
- `test_preserves_row_order_across_chunks` — rows[0..499] en el
  primer call, rows[500..999] en el segundo, etc.
- `test_all_chunks_tagged_with_same_match_run_id` —
  `match_run_id` se setea sobre cada fila.
- `test_on_chunk_failure_surfaces_error_and_stops_further_chunks` —
  si el 2do chunk devuelve error, el 3ro nunca se emite.

### Validación operativa

Tras GREEN + deploy:

1. Re-ejecutar la misma medición instrumentada contra
   `job_query c5cf4efe-…`.
2. **Pass**: `insertMatchResults` < 18 s, wall total < 30 s con
   headroom de al menos 1 s antes del H12.
3. **Marginal**: 18–22 s INSERT, wall 28–30 s. Aceptable pero
   abrir Plan B con urgencia.
4. **Fail**: si algún chunk individual sigue dando statement
   timeout, el chunk size es demasiado grande — bajar a 250 y
   reintentar.

### Telemetría a observar

- `match_runs` con `status = 'completed'` para pools > 5_000 —
  contar % de éxito.
- `pg_stat_activity` durante un run grande: máximo 1 INSERT
  concurrente del lado del client (secuencial garantiza esto).
- Distribución de `finished_at - started_at` en `match_runs` —
  buscar la cola larga que se mantenga bajo 30 s.
