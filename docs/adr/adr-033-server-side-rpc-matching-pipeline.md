# ADR-033 — Pipeline de matching server-side vía RPCs

- **Estado**: Propuesto
- **Fecha**: 2026-05-21
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: ADR-017 (RLS scoping), ADR-031 (parallel chunked-IN),
  ADR-032 (chunked INSERT), F4-008 (matching pipeline sub-D)

---

## Contexto

ADR-031 (parallel chunked-IN) y ADR-032 (chunked INSERT) entregaron
los dos fixes mecánicos del lado del cliente. La validación post-032
(2026-05-21) mostró que **siguen siendo insuficientes** a la escala
actual:

```
preFilter         5 066 ms     ← chunked-IN paralelo
loadCandidates   19 523 ms     ← chunked-IN paralelo
rank                95 ms      ← CPU local, despreciable
insertMatchResults 36 404 ms   ← chunked INSERT secuencial
                  ─────────
wall total       ~62 s         ← H12 (30 s) excedido por 2×
```

El pool elegible creció a 8 692 candidatos (drain v2 sigue corriendo).
**Las dos etapas de lectura están dominadas por round-trips Heroku→
Supabase**, no por query cost en Postgres. Cada chunked-IN paraleliza
hasta 5 chunks, pero sigue habiendo ~10 round-trips por helper × 2
helpers + paginación interna. A 30-60 ms RTT × ~50 round-trips totales
= 1.5-3 s de pura red.

El INSERT está estructuralmente limitado: a más candidatos persistidos,
más statements (~18 chunks de 500 = 36 s). El truco de top-K
(`slice(0, K)` antes de persistir) lo mitiga pero introduce un techo
arbitrario al "browse rank > K" y no resuelve el problema de fondo —
las lecturas siguen barriendo el pool completo.

### Por qué llegamos acá

El diseño original (F4-008) puso el pipeline en TypeScript con
inyección de I/O para poder testear sin Supabase. Esto fue correcto
para iterar la lógica del ranker. Pero el coste de I/O es lineal en
"número de candidatos visibles por el preFilter", y se paga
**enteramente sobre red**.

A 200-500 candidatos el diseño era barato. A 5_000+ es estructuralmente
incompatible con el budget H12.

## Decisión

Mover **las dos etapas de lectura** (preFilter + loadCandidates) a
**dos funciones plpgsql `security invoker`** y reemplazar el wiring
en `db-deps.ts` por dos llamadas RPC. El ranker (CPU pura, 100 ms en
producción) **queda en TypeScript**. El INSERT (ya chunked por
ADR-032) queda en TypeScript.

### 1. Por qué dos RPCs y no una

La separación lógica preFilter/loadCandidates es **valor**, no
overhead:

- **Diagnóstico**: el resultado del preFilter (cuántos quedaron,
  cuántos fueron excluidos, qué skills faltaron) se vuelca a
  `match_runs.diagnostics`. Con una RPC monolítica habría que
  reconstruirlo desde el output combinado.
- **Optimización**: si el preFilter excluye a todos los candidatos
  (decomposition imposible), la segunda RPC ni se invoca.
- **Evolución**: cada RPC se versionará independientemente. Cambiar
  reglas de pre-filter no toca el shape del agregado.
- **Costo marginal**: 1 round-trip extra ≈ 30-60 ms. Despreciable
  contra los ~25 s de la suma actual.

### 2. Por qué el ranker se queda en TypeScript

- **Coste real**: 100 ms para 5 783 candidates. Ninguna ganancia.
- **Lógica densa**: `mergeVariants` colapsa cv_primary + linkedin
  por similitud de título/empresa/fechas — port a plpgsql sería
  rewrite de ADR-015, ADR-020, ADR-026, ADR-030 con tests nuevos.
- **Pureza**: el ranker no toca DB. Mantenerlo CPU-only en TS
  preserva la propiedad clave "fácil de testear" sin Supabase.

### 3. Por qué `security invoker` (no `definer`)

- **Consistencia con ADR-017**: el RLS de `candidates`, `candidate_
experiences`, `experience_skills`, `candidate_languages` aplica
  bajo el JWT del recruiter — el RPC respeta lo mismo. Sin
  bypass.
- **Sin tenant injection manual**: la RLS ya filtra por
  `tenant_id` cuando corresponda; el RPC ve solo lo visible.
- **Precedente en `match_rescue_fts_search`**: misma postura,
  ya validado en prod.

### 4. Por qué encoding JSONB en la entrada/salida (no `RETURNS TABLE`)

- **`max_rows = 1000`** aplica a respuestas RPC con `RETURNS
TABLE`/`SETOF`. La lista de experiences para 5 000+ candidates
  fácil excede ese cap.
- **Un round-trip vs. paginación**: el objetivo es que cada llamada
  termine en una sola request. JSONB scalar lo garantiza.
- **Volumen aceptable**: 5 000 candidates × ~3 experiences ×
  ~1 KB ≈ 15 MB de JSON crudo, ~2-3 MB con gzip de PostgREST.
  Bajo techo razonable (~100 MB) y dentro del budget de memoria del
  dyno Heroku.

## Diseño detallado

### RPC #1 — `match_pre_filter`

```sql
create or replace function public.match_pre_filter(
  must_have_groups_in jsonb,  -- [{"skill_ids":["uuid",...]}, ...]
  tenant_id_in uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  -- empty input → all candidates included
  result jsonb;
begin
  if jsonb_array_length(must_have_groups_in) = 0 then
    select jsonb_build_object(
      'included', coalesce(jsonb_agg(c.id), '[]'::jsonb),
      'excluded', '[]'::jsonb
    )
    into result
    from candidates c
    where tenant_id_in is null or c.tenant_id = tenant_id_in;
    return result;
  end if;

  -- Group i covered iff candidate has ≥1 experience_skills row with
  -- skill_id in group[i].skill_ids. AND between groups, OR within.
  -- See pre-filter.ts:67-150 for the JS reference impl.
  with
    groups as (
      select ordinality - 1 as group_idx,
             array(select jsonb_array_elements_text(g->'skill_ids'))::uuid[] as skill_ids
      from jsonb_array_elements(must_have_groups_in) with ordinality as g
    ),
    candidate_skill_hits as (
      select ce.candidate_id, es.skill_id
      from experience_skills es
      join candidate_experiences ce on ce.id = es.experience_id
      where es.skill_id in (
        select unnest(skill_ids) from groups
      )
    ),
    candidate_groups_covered as (
      select chs.candidate_id, g.group_idx
      from candidate_skill_hits chs
      join groups g on chs.skill_id = any(g.skill_ids)
      group by chs.candidate_id, g.group_idx
    ),
    all_groups_count as (
      select count(*) as n from groups
    ),
    classified as (
      select
        c.id as candidate_id,
        coalesce(
          (select count(distinct group_idx) from candidate_groups_covered
           where candidate_id = c.id),
          0
        ) as covered_count
      from candidates c
      where tenant_id_in is null or c.tenant_id = tenant_id_in
    )
  select jsonb_build_object(
    'included', coalesce(jsonb_agg(candidate_id) filter (where covered_count = (select n from all_groups_count)), '[]'::jsonb),
    'excluded', coalesce(jsonb_agg(
      jsonb_build_object(
        'candidate_id', candidate_id,
        'missing_must_have_skill_ids', (
          select coalesce(jsonb_agg(distinct s), '[]'::jsonb)
          from groups g, unnest(g.skill_ids) as s
          where g.group_idx not in (
            select group_idx from candidate_groups_covered
            where candidate_id = classified.candidate_id
          )
        )
      )
    ) filter (where covered_count < (select n from all_groups_count)), '[]'::jsonb)
  )
  into result
  from classified;

  return result;
end;
$$;
```

Output:

```json
{
  "included": ["uuid", "uuid", ...],
  "excluded": [{ "candidate_id": "uuid", "missing_must_have_skill_ids": ["uuid"] }, ...]
}
```

### RPC #2 — `match_load_aggregates`

```sql
create or replace function public.match_load_aggregates(
  candidate_ids_in uuid[],
  tenant_id_in uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(payload), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'candidate_id', c.id,
      'experiences', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', ce.id,
          'source_variant', ce.source_variant,
          'kind', ce.kind,
          'company', ce.company,
          'title', ce.title,
          'start_date', ce.start_date,
          'end_date', ce.end_date,
          'description', ce.description,
          'skills', coalesce((
            select jsonb_agg(jsonb_build_object('skill_id', es.skill_id, 'skill_raw', es.skill_raw))
            from experience_skills es
            where es.experience_id = ce.id
          ), '[]'::jsonb)
        ))
        from candidate_experiences ce
        where ce.candidate_id = c.id
      ), '[]'::jsonb),
      'languages', coalesce((
        select jsonb_agg(jsonb_build_object('name', cl.name, 'level', cl.level))
        from candidate_languages cl
        where cl.candidate_id = c.id
      ), '[]'::jsonb)
    ) as payload
    from candidates c
    where c.id = any(candidate_ids_in)
      and (tenant_id_in is null or c.tenant_id = tenant_id_in)
  ) as agg;
$$;
```

Output: array de `{ candidate_id, experiences[], languages[] }` listo
para feed al ranker tras `mergeVariants`.

### Cambios en `db-deps.ts`

Reemplazar tres bloques:

- `fetchAllCandidateIds` / `fetchCandidateMustHaveCoverage`: borrar.
  Caller del preFilter ahora llama directo a RPC.
- `loadExperiences` / `loadLanguages`: borrar.
- `preFilter` dep: pasa a llamar `supabase.rpc('match_pre_filter', …)`
  y deserializar.
- `loadCandidates` dep: pasa a llamar `supabase.rpc(
'match_load_aggregates', …)`, deserializar, pasar a
  `mergeVariants` por candidato (sin cambios en `loadCandidateAggregates`
  más allá de eliminar la fan-out chunked).

`runChunked` permanece — `embeddings/*-worker.ts` lo usa con
`concurrency: 1` por la URL-length de `.in()`. No tocar.

### Migración

Una sola migración: `supabase/migrations/<timestamp>_match_pipeline_rpcs.sql`
con ambas funciones + grants si hace falta.

## Consecuencias

**Positivas**

- **Wall-clock proyectado a 8 700 candidates**: ~5-10 s. Bajo H12
  con holgura de >20 s. Escala holgadamente a 15-20k candidates
  proyectados.
- **Sin spikes de Supavisor**: 2 conns en lugar de ~10. Headroom
  para múltiples recruiters concurrentes.
- **Sin top-K cap arbitrario** — la paginación de results sigue
  intacta para browse hasta el rank N.
- **Tests existentes intactos**: el contrato del orchestrator
  (`runMatchJob`, `PreFilterByMustHaveResult`, `CandidateAggregate`)
  no cambia. Sólo cambia el wiring de `db-deps`.

**Negativas**

- **Más superficie SQL**: dos funciones plpgsql + tests de integración
  bajo RLS. Habrá una pequeña duplicación entre la lógica de
  `pre-filter.ts` (que ahora queda como test reference) y la de
  `match_pre_filter()`. Mitigación: mantenemos `preFilter.ts` con
  los unit tests pasivos como "ground truth" — los integration tests
  validan que la RPC produce el mismo output sobre el mismo fixture.
- **Más payload de red en `loadAggregates`**: 2-3 MB compressed peor
  caso. Aceptable. Si crece a >10 MB en el futuro, paginamos por
  bloques de candidate_ids (RPC re-llamado con chunks).
- **Debug menos directo**: explicar un fallo de la RPC requiere
  `EXPLAIN` server-side, no console.log. Mitigación: el integration
  test cubre todos los branches; ad-hoc se llama vía `psql`.

**Descartadas**

- **Una sola RPC monolítica** (`match_full_pipeline`). Pierde la
  separación lógica del preFilter; complica diagnostics; ahorra
  marginal 30 ms vs 2 RPCs.
- **Mover el ranker a plpgsql**. Rewrite tóxico de 4 ADRs de scoring
  con tests nuevos. CPU cost real es 100 ms.
- **Async pattern (202 + worker)**. Cambio de contrato externo,
  refactor de UI. Lo dejamos como Fase 3 si Plan B llega a su techo
  (estimado: >30k candidates o queries cross-tenant pesadas).
- **Top-K persist + chunked-IN paralelo (sin RPC)**. Validado
  como insuficiente: los reads siguen barriendo el pool completo
  con N×RTT.

## Plan de verificación

### Migración + RPC contract (TDD)

`tests/integration/matching/match-pre-filter-rpc.test.ts` (nuevo):

- `test_no_must_have_groups_returns_full_pool` — input
  `[]` → `included` = todos los candidates visibles bajo RLS.
- `test_single_resolved_group_filters_by_skill_coverage` — un grupo
  con 1 skill → solo candidates con esa skill en included.
- `test_alternative_group_OR_within` — grupo con 2 skills → covered
  si tiene cualquiera.
- `test_AND_between_groups` — dos grupos disjuntos → candidate
  necesita 1 skill de cada uno.
- `test_excluded_carries_missing_skill_ids` — candidates en excluded
  listan los skill_ids de TODOS los grupos no cubiertos.
- `test_rls_scopes_results_to_recruiter_tenant` — recruiter
  authenticated solo ve sus candidates.

`tests/integration/matching/match-load-aggregates-rpc.test.ts` (nuevo):

- `test_returns_empty_array_for_empty_input` — `[]` → `[]`.
- `test_aggregates_experiences_with_skills` — un candidate con N
  experiences y M skills cada una → estructura aninada correcta.
- `test_aggregates_languages` — un candidate con K languages.
- `test_omits_candidates_not_in_input_array` — solo devuelve los
  pedidos.
- `test_rls_scopes_results_to_recruiter_tenant`.

`src/lib/matching/db-deps.test.ts` (extender los 8 actuales):

- Reemplazar el fake supabase para que `.rpc('match_pre_filter', …)`
  y `.rpc('match_load_aggregates', …)` sean los seams.
- Verificar que `preFilter` y `loadCandidates` llaman a la RPC
  correspondiente con los argumentos esperados.

### Validación operativa

Tras GREEN + deploy:

1. Re-ejecutar la medición instrumentada contra
   `c5cf4efe-…` (pool ~8 700).
2. **Pass**: wall total < 15 s con preFilter < 3 s y loadAggregates
   < 8 s.
3. **Marginal**: 15-25 s. Aceptable pero abrir follow-up de
   índices (probable: `experience_skills(skill_id, experience_id)`
   compuesto si está faltando).
4. **Fail**: > 25 s. La RPC tiene query plan malo —
   `EXPLAIN ANALYZE` server-side y ajustar índices.

### Telemetría a observar (próximas 48h)

- `pg_stat_statements` para las dos funciones — verificar que no
  generan plans inestables al variar `must_have_groups_in`.
- `pg_stat_activity` durante un run — máximo 2 conexiones
  simultáneas del pipeline (vs 10 antes).
- Variabilidad de wall-clock entre runs idénticos — bajo H12
  con headroom suficiente debe ser sub-segundo.
