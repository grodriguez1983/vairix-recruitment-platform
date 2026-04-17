---
name: etl-sync
description: Cómo implementar syncers por entidad, manejar sync_state, lock y stale timeout, errores por registro vs errores fatales. Usar cuando la tarea toque src/lib/sync o cualquier job en supabase/functions/sync-*.
---

# ETL Sync

## Cuándo aplicar este skill

- Crear un `EntitySyncer` nuevo (stages, users, jobs, candidates,
  applications, evaluations, notes, files).
- Modificar el loop genérico de sync.
- Depurar un run atascado (`last_run_status = 'running'` pero sin
  avance).
- Agregar métrica o logging al ETL.

## Principios no negociables

1. **El ETL no genera embeddings.** Punto. Los embeddings corren
   en worker separado post-sync (ADR-005).
2. **El ETL no parsea CVs.** El parser corre post-upload
   (ADR-006).
3. **Upsert por `teamtailor_id`** siempre. Nunca insert ciego.
4. **Errores por registro NO detienen el batch.** Se loggean en
   `sync_errors` y el loop continúa.
5. **Errores fatales SÍ detienen el batch** y NO avanzan
   `last_synced_at`.
6. **Orden de sync es una dependencia de data.** Cambiarlo sin
   ADR es un bug esperando.

## Orden fijo

1. `stages`
2. `users`
3. `jobs`
4. `candidates`
5. `applications`
6. `evaluations` / `notes`
7. `files`

Razón: applications referencia jobs y stages. Evaluations
referencia users. Files referencia candidates. Si syncás
applications antes que jobs, las FK quedan sin resolver.

## Lock con stale timeout

Cada syncer arranca así (pseudo-TS):

```typescript
export async function runIncremental(entity: Entity): Promise<void> {
  const state = await sql`
    select last_run_status, last_run_started
    from sync_state
    where entity = ${entity}
    for update
  `;

  if (state.last_run_status === 'running') {
    const age = Date.now() - state.last_run_started.getTime();
    if (age < state.stale_timeout_minutes * 60_000) {
      throw new LockHeldError(entity);
    }
    // stale → lo tomamos
  }

  await sql`
    update sync_state
    set last_run_status = 'running',
        last_run_started = now()
    where entity = ${entity}
  `;

  try {
    const records = await syncEntity(entity);
    await sql`
      update sync_state
      set last_run_status = 'success',
          last_run_finished = now(),
          last_synced_at = now(),
          records_synced = ${records}
      where entity = ${entity}
    `;
  } catch (err) {
    await sql`
      update sync_state
      set last_run_status = 'error',
          last_run_finished = now(),
          last_run_error = ${String(err)}
      where entity = ${entity}
    `;
    throw err;
  }
}
```

**Clave**: en error, `last_synced_at` **no se actualiza**. El
próximo run retoma desde el cursor válido previo.

## Estructura de un EntitySyncer

Cada syncer expone:

```typescript
export interface EntitySyncer<TTRecord, DbRow> {
  entity: Entity;
  // Endpoint de Teamtailor + includes + filters
  queryParams(cursor: Date | null): PaginateParams;
  // Map del record JSON:API al row a upsertar
  toRow(record: TTRecord, ctx: SyncContext): DbRow;
  // Resolver FKs (ej: job_teamtailor_id → jobs.id interno)
  resolveRefs(row: DbRow, ctx: SyncContext): Promise<DbRow>;
  // Upsert final (con ON CONFLICT)
  upsert(rows: DbRow[]): Promise<void>;
}
```

Los métodos son puros salvo `resolveRefs` (lee DB) y `upsert`
(escribe DB). Esto permite tests unitarios con fixtures
mockeando la DB solo en los dos últimos.

## Resolución de FKs

Regla: **nunca FK contra `teamtailor_id`**. Siempre resolver al
`uuid` interno.

Patrón:

```typescript
async function resolveRefs(row: ApplicationRow, ctx): Promise<ApplicationRow> {
  const [candidate, job, stage] = await Promise.all([
    ctx.repos.candidates.findByTeamtailorId(row.candidate_teamtailor_id),
    ctx.repos.jobs.findByTeamtailorId(row.job_teamtailor_id),
    ctx.repos.stages.findByTeamtailorId(row.stage_teamtailor_id),
  ]);

  if (!candidate) throw new UnresolvedRefError('candidate', row.candidate_teamtailor_id);
  // job y stage pueden ser null → aceptables según schema
  return {
    ...row,
    candidate_id: candidate.id,
    job_id: job?.id ?? null,
    stage_id: stage?.id ?? null,
    stage_name: stage?.name ?? row.stage_name_snapshot,
  };
}
```

Si un ref falla: `sync_errors` con `error_code = 'unresolved_ref'`.

## Clasificación de errores

| Tipo | Acción | Avanza cursor? |
|---|---|---|
| Row-level: validation fallida, parsing JSON roto, FK no resoluble | `sync_errors` + continuar | Sí (al final del batch si no hubo fatales) |
| Row-level: rate limit 429 | backoff + retry, si agota intentos → row error | Sí |
| Fatal: auth 401 / 403 | error run, no retry | **No** |
| Fatal: network timeout persistente | retry con backoff, si agota → error run | **No** |
| Fatal: schema mismatch (rompe Zod validation) | error run, PR fix requerido | **No** |

## Testing

Tests obligatorios por syncer (ver `docs/test-architecture.md`):

- `test_sync_upsert_is_idempotent`
- `test_sync_resolves_fks_correctly`
- `test_sync_row_error_does_not_stop_batch`
- `test_sync_fatal_error_preserves_last_synced_at`
- `test_sync_stale_lock_is_reclaimed`

Fixtures en `tests/fixtures/teamtailor/<entity>/`. Usar MSW.

## Observabilidad

Log estructurado por run:

```json
{
  "timestamp": "2026-04-17T14:30:00Z",
  "level": "info",
  "scope": "sync.candidates",
  "message": "sync batch completed",
  "meta": {
    "entity": "candidates",
    "records_processed": 42,
    "row_errors": 1,
    "duration_ms": 14500,
    "cursor_from": "2026-04-17T14:15:00Z",
    "cursor_to": "2026-04-17T14:29:45Z"
  }
}
```

## Checklist

- [ ] Syncer implementa el interface `EntitySyncer`.
- [ ] Fixtures + tests con MSW.
- [ ] Upsert usa `ON CONFLICT (teamtailor_id)`.
- [ ] Row errors van a `sync_errors`, no detienen batch.
- [ ] Fatal errors no avanzan `last_synced_at`.
- [ ] Log estructurado por batch.

## Referencias

- ADR-002 — estrategia de sync.
- ADR-004 — orquestación del ETL.
- `docs/use-cases.md` UC-05 — state machine y acceptance criteria.
- `docs/runbooks/initial-backfill.md` — operación manual.
- `.claude/skills/teamtailor-integration/SKILL.md` — cliente base.
