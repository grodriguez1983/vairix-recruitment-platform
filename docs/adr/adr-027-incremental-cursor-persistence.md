# ADR-027 — Persistencia del `last_cursor` en el runner incremental de sync

- **Estado**: Aceptado
- **Fecha**: 2026-04-27
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: ADR-002 (ETL incremental), ADR-004 (Teamtailor
  client),
  `src/lib/sync/run.ts`, `src/lib/sync/lock.ts`,
  `supabase/migrations/20260417205210_sync_state.sql`

---

## Contexto

El schema de `sync_state` (migración `20260417205210`) declara dos
columnas relacionadas con la posición de avance del syncer:

- `last_synced_at timestamptz` — wall-clock del último run exitoso
  (capturado al inicio del run para garantizar monotonicidad bajo
  clock skew, según docstring de `runIncremental`).
- `last_cursor text` — cursor opaco usado por el syncer como argumento
  de `buildInitialRequest(cursor)`. Hoy todos los syncers lo
  interpretan como `filter[updated-at][from]=<cursor>` cuando es
  no-null.

`releaseLock` (en `lock.ts`) acepta un campo opcional `lastCursor` en
el `ReleaseOutcome.success` y lo persiste si está presente.
**`runIncremental` nunca lo pasa** — solo escribe `lastSyncedAt:
runStartedAt`. Resultado:

1. `last_cursor` queda eternamente en `NULL`.
2. `acquireLock` lee `last_cursor` y se lo entrega al syncer vía
   `cursor = acquired.lastCursor` → `syncer.buildInitialRequest(cursor)`.
3. Como `cursor` es siempre `null`, los syncers nunca emiten el filtro
   `filter[updated-at][from]` y cada run de "incremental" hace **full
   scan de Teamtailor desde la primera página**.

El upsert idempotente de cada syncer evita data duplicada, pero el
costo de red es proporcional al universo TT, no al delta. En prod el
catálogo TT puede tener decenas de miles de candidatos; un cron
cada hora bajaría todo cada hora.

### Incidente gatillante (Bloque 16, 2026-04-24)

Durante un partial backfill de 200 → 400 candidatos, el owner observó
que subir `SYNC_MAX_RECORDS=400` re-trajo los 200 previos completos
(idempotencia confirmada, pero costo doble). La investigación expuso
que `incremental` es un misnomer: el syncer no tiene watermark.

## Decisión

**`runIncremental` persiste el `runStartedAt` como `last_cursor` en
toda terminación exitosa**, y al inicio de cada run lee
`cursor = acquired.lastCursor ?? acquired.lastSyncedAt` para
backward-compat con rows preexistentes (cuyo `last_cursor` es `null`
pero cuyo `last_synced_at` ya está poblado).

### Semántica de las dos columnas

Ambas se mantienen distintas porque cubren contratos diferentes,
aunque hoy carguen el mismo valor (`runStartedAt` ISO string):

- `last_synced_at` es **observabilidad operativa**: "¿cuándo fue la
  última vez que esta entidad sincronizó OK?". Se exhibe en runbooks,
  alertas, dashboards. No es seguro re-interpretarlo como input al
  filtro TT en una migración futura.
- `last_cursor` es **estado de avance del syncer**: el valor concreto
  que se pasa a `syncer.buildInitialRequest(cursor)`. Hoy es un ISO
  timestamp, mañana podría ser un page token opaco si TT migra a
  cursor-based pagination (ya hay endpoints donde `meta.next` es un
  link opaco).

La distinción permite, sin migración, que un syncer futuro emita un
cursor distinto del wall-clock (e.g. `lastCursor: lastSeenLink`)
manteniendo `last_synced_at` como métrica operativa.

### Backward compat

Rows existentes en `sync_state` tienen:

- `last_synced_at`: poblado (los runs anteriores lo escribían).
- `last_cursor`: `NULL` (nunca se escribió).

El fallback `acquired.lastCursor ?? acquired.lastSyncedAt` hace que el
**próximo run** después del fix lea el watermark correcto sin
necesidad de migración de data. A partir de ese run, `last_cursor`
queda poblado y la rama de fallback no se vuelve a tocar para esa
entidad.

## Consecuencias

**Positivas**

- "Incremental" pasa a ser literalmente incremental: cada run trae
  solo los recursos TT con `updated-at >= cursor`. Costo de red
  proporcional al delta.
- El cron horario deja de tener picos de tráfico TT.
- Idempotencia preservada: si el cursor incluye recursos modificados
  exactamente en `runStartedAt - 1ms` y el syncer no los re-trae, no
  se pierde data porque la próxima run los tomará. (Asumiendo TT
  ordena por `updated-at` ascendente, riesgo: si TT clamp-ea
  resoluciones <1s, una row modificada en el mismo segundo del cursor
  podría perderse. Mitigación: el filtro `>=` y la idempotencia del
  upsert; la próxima run la trae si la actualizamos otra vez.)

**Negativas**

- Si un syncer falla a mitad de run y el `releaseLock` con
  `status='error'` no avanza el cursor, el próximo run reintenta
  desde el watermark anterior — esto YA es el comportamiento del
  `last_synced_at` (línea 200-202 de `run.ts`), pero ahora también
  aplica al cursor. **Importante**: el caso "primeros N upserts OK,
  upsert N+1 falla" deja esos N como work duplicado en la próxima
  run. El upsert idempotente lo absorbe.

**Descartadas**

- Avanzar el cursor batch-por-batch (después de cada upsert exitoso)
  para minimizar el work duplicado en error. No se eligió porque
  añade complejidad transaccional y los syncers actuales no son tan
  caros en write — el upsert idempotente cubre el caso aceptable.
- Drop la columna `last_cursor` y reusar `last_synced_at` como única
  fuente. No se eligió por la separación de concerns explicada arriba
  (operabilidad vs estado del syncer).

## Plan de verificación

- Tests unitarios en `run.test.ts`:
  - `runIncremental` pasa `lastCursor: runStartedAt` a `releaseLock`
    en éxito (regresión).
  - `runIncremental` lee `acquired.lastCursor ?? acquired.lastSyncedAt`
    como input a `syncer.buildInitialRequest(cursor)`.
  - `runIncremental` NO escribe `last_cursor` en path de error
    (preserva el invariante de `last_synced_at`).
- Validación operativa post-fix: forzar dos `pnpm sync:incremental
candidates` consecutivos en dev DB, observar que el segundo trae 0
  (o ≤ delta) recursos en lugar de los 400.
