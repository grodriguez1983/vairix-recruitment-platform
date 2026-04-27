# ADR-028 — Orquestadores `sync:full` y `sync:backfill`

- **Estado**: Aceptado
- **Fecha**: 2026-04-27
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: ADR-002 (ETL incremental), ADR-027 (cursor
  persistence), `package.json` scripts, `.github/workflows/backfill.yml`

---

## Contexto

`package.json` declara dos scripts:

```json
"sync:full": "tsx src/scripts/sync-full.ts",
"sync:backfill": "tsx src/scripts/backfill.ts"
```

Ninguno de los dos archivos existía en el tree. El workflow
`.github/workflows/backfill.yml:79-83` los invoca:

```bash
if [[ "${{ inputs.entity }}" == "all" ]]; then
  pnpm sync:full
else
  pnpm sync:backfill --entity=${{ inputs.entity }}
fi
```

Resultado: el workflow está roto — un dispatch manual para `entity=all`
falla con `Cannot find module '.../sync-full.ts'` antes de empezar.

### Naming pre-existente

- `sync:incremental <entity>` ya existe y es el path operativo común
  (cron horario). Lleva el watermark `last_cursor` (ADR-027) — solo
  trae el delta desde el último run.
- `sync:full` (faltante): orquestador para correr todas las entidades
  en orden canónico de dependencias en una sola invocación. Sigue
  siendo "incremental" — usa el cursor.
- `sync:backfill` (faltante): re-sincroniza una entidad (o todas)
  **ignorando el cursor**, forzando full scan desde la primera
  página de Teamtailor. Operación Tier 2 (ver
  `docs/operation-classification.md`).

## Decisión

### `sync:full`

Itera la **lista canónica de entidades en orden de FK**, llamando a
`runIncremental` para cada una con la misma instancia compartida de
`SupabaseClient` y `TeamtailorClient`. Orden:

```
stages → users → jobs → custom-fields →
candidates → applications → notes → evaluations → files
```

El orden refleja FKs físicas:

- `candidates` antes de `applications/notes/files` (FK a
  `candidates.id`).
- `jobs` y `stages` antes de `applications` (FK a ambas).
- `users` antes de `evaluations/notes` (FK a evaluador).
- `custom-fields` antes de `candidates` (sideload necesita el def).

**Política de fallos**: fail-fast. Si una entidad termina con error
(release con `status='error'`), las restantes NO se ejecutan y el
proceso sale con código de salida 4 indicando la entidad fallida.
Razón: las entidades posteriores dependen del estado actualizado de
las anteriores; correr `applications` con `candidates` en error
arrastra el error sin agregar valor.

**Env vars respetados** (sin override forzado por el orquestador):

- `SYNC_MAX_RECORDS` aplica a TODA entidad iterada. Solo se usa para
  smoke tests; producción no lo setea.
- `SYNC_SCOPE_BY_CANDIDATES=1` aplica a las entidades hijas. La
  scope set se re-lee del DB antes de cada hijo (después de que
  candidates corrió), garantizando que recoja los upserts recientes.

### `sync:backfill`

Acepta dos formas:

```
pnpm sync:backfill --entity=<entity>
pnpm sync:backfill --entity=all
```

Comportamiento:

1. **Reset del watermark**: para la(s) entidad(es) target, hace
   `UPDATE sync_state SET last_cursor=NULL, last_synced_at=NULL`. La
   próxima `runIncremental` arranca sin filtro `updated-at` y trae
   todo desde la página 1 de TT.
2. **Ejecución**:
   - `--entity=X` → reset(X) + `runIncremental(X)`.
   - `--entity=all` → reset(todas) + comportamiento idéntico a
     `sync:full`.

Validación: `--entity` es required y debe estar en la lista canónica
o ser literal `all`. Un valor inválido aborta con código 1 antes de
tocar DB.

**Operación Tier 2**: `docs/operation-classification.md` clasifica el
backfill manual como Tier 2 — el workflow `backfill.yml` ya gatekeea
con un input `confirm` literal `yes`. Este script no agrega un gate
extra (asume invocación supervisada por el operador o por el
workflow). En CLI local, el operador lee el aviso del runbook y
asume responsabilidad.

### Helper compartido

Las tres entradas (`sync:incremental`, `sync:full`, `sync:backfill`)
comparten:

- Carga de env vars (URL Supabase, secret key, token TT).
- Construcción del registro `entity → EntitySyncer` (incluye el hook
  de download de resumes para `candidates`).
- Loader de `scopeCandidateTtIds`.

Se extrae a `src/lib/sync/cli.ts` para evitar drift entre las tres
copias. `sync-incremental.ts` se refactoriza para consumir el helper.

### Lista canónica como dato

`CANONICAL_ENTITY_ORDER: readonly EntityName[]` queda en
`src/lib/sync/orchestration.ts` con un test que asegura paridad con
las keys de `buildSyncers()`. Eso evita que un syncer nuevo entre al
build y quede excluido del full sync (o al revés).

## Consecuencias

**Positivas**

- El workflow `backfill.yml` deja de estar roto — el dispatch manual
  funciona con `entity=all` o entidad puntual.
- Operación de backfill se hace explícita en código (un comando, no
  una secuencia manual de 9 invocaciones más un SQL de reset).
- El orden canónico es un dato testeable, no folklore en runbooks.

**Negativas**

- El orquestador es secuencial. Un full sync en prod puede tardar
  horas (el workflow ya lo asume con `timeout-minutes: 360`). Mover
  a paralelo entre entidades independientes (stages + users + jobs +
  custom-fields no dependen entre sí) es un follow-up — requiere
  pensar el throttling agregado contra el rate-limit TT compartido.
- `SupabaseClient` y `TeamtailorClient` se comparten entre runs.
  Cualquier estado mutable que arrastren (rate-limiter, conexiones)
  cruza entidades. Hoy ambos clients son idempotentes para esto; si
  cambia, hay que aislar.

**Descartadas**

- Shell-out (`spawn pnpm sync:incremental <entity>` por entidad).
  Más simple pero introduce overhead de proceso por entidad y rompe
  la observabilidad (logs van a stdout/stderr de subprocesos
  separados; el workflow ya parsea el log unificado).
- `sync:backfill` sin reset (mero alias de `sync:incremental`). No,
  porque la semántica de "backfill" implica ignorar el cursor —
  reusar `incremental` confunde al operador.
- Confirmación interactiva en CLI (prompt "yes/no"). El gate ya vive
  en el workflow; agregarlo al script local rompe automatización.

## Plan de verificación

- Test unitario: `CANONICAL_ENTITY_ORDER` matchea exactamente
  `Object.keys(buildSyncers(db))`.
- Test unitario: `parseBackfillArgs(['--entity=candidates'])` →
  `{ entity: 'candidates' }`; `--entity=all` → `{ entity: 'all' }`;
  invalid o ausente → throws con mensaje accionable.
- Test unitario: `runOrchestration({entities, runOne})` itera en
  orden, fail-fast, retorna lista de resultados; `runOne` que tira
  → orchestrator throws envolviendo la entidad fallida.
- Validación operativa post-fix: `pnpm sync:full` en dev DB con
  cursor ya poblado → cada entidad reporta delta-only en
  `recordsSynced`. `pnpm sync:backfill --entity=stages` → la
  entidad re-trae todo desde la primera página de TT (verificable
  en `sync_state.records_synced` antes vs después).
