# 📍 Status — Recruitment Data Platform

> Actualizado al final de **cada sesión** de Claude Code. Snapshot
> del estado; no es un registro histórico completo (para eso está
> el git log).

**Última actualización**: 2026-04-19
**Última sesión**: 2026-04-19 — F3-001 evaluation slice (embeddings worker + CLI + embed-all integrado), RLS tests para `evaluation_answers`, F2-002 dry-run CLI (`pnpm normalize:rejections [--dry-run|--force|--batch=N]`), F2-004 needs_review admin UI (`/admin/needs-review` con reclassify + dismiss), F3-002 `/search/semantic` page, F3-003 `/search/hybrid` page con filtros structured + rerank, `SYNC_MAX_RECORDS` + `SYNC_SCOPE_BY_CANDIDATES` knobs para smoke-test seeding
**Fase activa**: **Fase 1 — Fundación** (+ F2-002/F2-004 cerradas, F3-001 4 slices completas, F3-002/F3-003 con UI)

---

## ✅ Completado

- **F3-001 evaluation slice** ✅ done — 2026-04-19 — `f307b3a`.
  - `src/lib/embeddings/sources/evaluation.ts`: source builder que
    agrega `evaluations` + `evaluation_answers` en un input por
    candidate. Orden cronológico de evals, orden lexicográfico de
    answers por `question_tt_id`, typed-column picker para
    number/boolean/date/range. Devuelve `null` cuando toda la data
    está vacía — el runtime salta la row.
  - `src/lib/embeddings/evaluation-worker.ts`: handler del
    `runEmbeddingsWorker` compartido. `source_type='evaluation'`,
    `source_id=null` (1 row por candidate).
  - `src/scripts/embed-evaluations.ts` + `pnpm embed:evaluations`.
    `embed-all` corre ahora `profile → notes → cv → evaluation`
    (el aggregate pesado queda último).
  - 9 tests unitarios en `evaluation.test.ts` (null cuando todo
    vacío, sort chronological, determinism bajo reshuffling,
    typed-column fallback, questionTitle→questionTtId fallback,
    header decision/score, no leaks de "null"/"undefined", collapse
    de whitespace). 226/226 unit tests verdes.

- **RLS tests para `evaluation_answers`** ✅ done — 2026-04-19 — `cbbc5b5`.
  - `tests/rls/evaluation-answers.test.ts`: 4 tests (anon SELECT
    denied, recruiter SELECT ok + INSERT denied, recruiter UPDATE +
    DELETE denied con re-read de service-role para confirmar que no
    es un zero-row silent success, admin R/W end-to-end).

- **F2-002 rejection normalizer dry-run CLI** ✅ done — 2026-04-19 — `4b06e3f`.
  - `src/scripts/normalize-rejections.ts` + `pnpm normalize:rejections`.
    Flags: `--dry-run` (clasifica + imprime samples, no escribe),
    `--force` (reclasifica incluso las ya normalizadas), `--batch=N`.
  - `src/lib/normalization/normalizer.ts`: agregado `dryRun?: boolean`
    y `samples[]` en el resultado (hasta 10 {reason→code}) para que
    el operador pueda spot-checkear. Integration test adicional
    verifica que dry-run NO escribe `rejection_category_id` ni
    `normalization_attempted_at`.
  - Workflow: `pnpm normalize:rejections --dry-run` → revisar
    samples → `pnpm normalize:rejections` para aplicar → revisar
    la cola `/admin/needs-review` para los fallbacks a `other`.

- **F2-004 needs_review admin UI** ✅ done — 2026-04-19 — `c0479b5`.
  - Cierra la mitad pendiente de F2-004 (la parte `sync_errors`
    había aterrizado el 2026-04-18).
  - `src/lib/needs-review/{service,errors}.ts`: `listNeedsReview` +
    `countNeedsReview` + `listRejectionCategories` +
    `reclassifyAndClear` + `dismissAndClear`. El reclassify valida
    que la categoría exista y no esté `deprecated_at`; bloquea
    doble-write con guardas `already_cleared`.
  - `/admin/needs-review/page.tsx` + `ReviewRow` client component:
    dropdown con categorías activas + botón "save" (reclasifica y
    limpia flag) + botón "dismiss" (acepta fallback `other`). Links
    a perfil de candidate desde el header de la row.
  - Landing `/admin` suma tarjeta "Needs review" con badge de
    pendientes (warning si >0).
  - 8 integration tests: lista + join a candidates, count, sort de
    categorías (other con sort_order=999 → último), reclassify
    happy, reclassify con UUID inexistente → error
    `invalid_category`, reclassify sobre row ya clara → error
    `already_cleared`, dismiss happy, dismiss sobre ya clara → error.

- **F3-002 `/search/semantic` page** ✅ done — 2026-04-19 — `8d47297`.
  - Server-rendered: form GET sobre `?q=`, llama a
    `semanticSearchCandidates` directo con client RLS-scoped (no
    round trip por `/api/search/semantic`), hidrata via nuevo
    `lib/search/hydrate.ts` (orden-preservante). Render con badge
    de score + source badges (profile/notes/cv/eval).

- **F3-003 `/search/hybrid` page** ✅ done — 2026-04-19 — `8d47297`.
  - Misma estrategia: GET form con `q` + filtros structured
    (status, rejected_after/before, job). Provider se resuelve lazy
    solo cuando hay query (structured-only no necesita
    `OPENAI_API_KEY` — mirror de `/api/search/hybrid`). Status line
    muestra el modo efectivo (`hybrid` | `structured` | `empty`).
  - Sidebar suma entry "Search" → `/search/hybrid`.

- **Smoke-test seeding knobs (`SYNC_MAX_RECORDS` + `SYNC_SCOPE_BY_CANDIDATES`)** ✅ done — 2026-04-19.
  - Motivador: traer 50 candidatos con data completa a local para
    smoke-test manual sin un full backfill.
  - `SyncerDeps.maxRecords?: number` en `src/lib/sync/run.ts`: runner
    corta pagination al llegar al cap. Undefined = sin cap. Cuenta
    resources yielded desde TT, no solo los que upsertan ok.
  - `SyncerDeps.scopeCandidateTtIds?: ReadonlySet<string>` consumido
    por applications/notes/interviews/uploads: filtra staging antes
    de FK resolution. Rows fuera de scope se descartan silenciosa­
    mente — **no** van a `sync_errors`. Uploads además skippea el
    download del binario (no pagamos bytes que íbamos a tirar).
  - CLI (`src/scripts/sync-incremental.ts`) lee `SYNC_MAX_RECORDS`
    (positive int) y `SYNC_SCOPE_BY_CANDIDATES` (1/true), y cuando
    scope está activo carga los teamtailor_id de `candidates` en un
    Set y los pasa via deps.
  - TDD full: commits `f302016` (RED cap) → `bcd195e` (GREEN cap) →
    `69f863e` (RED scope) → `8ff73c7` (GREEN scope) → `5ce5103` (CLI
    wiring). `.env.example` actualizado.
  - Workflow smoke-test:
    ```
    pnpm sync:incremental stages
    pnpm sync:incremental users
    pnpm sync:incremental jobs
    pnpm sync:incremental custom-fields
    SYNC_MAX_RECORDS=50 pnpm sync:incremental candidates
    SYNC_SCOPE_BY_CANDIDATES=1 pnpm sync:incremental applications
    SYNC_SCOPE_BY_CANDIDATES=1 pnpm sync:incremental notes
    SYNC_SCOPE_BY_CANDIDATES=1 pnpm sync:incremental evaluations
    SYNC_SCOPE_BY_CANDIDATES=1 pnpm sync:incremental files
    ```
  - 415/415 tests verdes (244 unit + 113 integration + 58 RLS).

- **Remediación F3-002/F3-003 (audit de procedimiento)** ✅ done — 2026-04-19.
  - Usuario cuestionó el bundle anterior por bypass de TDD
    ([GREEN] sin [RED] previo) y falta de ADR para el patrón
    server-rendered. Remediación en 4 pasos:
    1. `tests/integration/search/hydrate.test.ts` — 6 tests
       retro-cobertura de `hydrateCandidatesByIds` (order
       preservation, RLS drop, empty input, dedupe, ids
       inexistentes, mapeo full de card fields). Commit `11a2421`.
    2. Full suite verde: 217 unit + 110 integration + 58 RLS = 385
       tests. Sin regresiones del bundle.
    3. `docs/adr/adr-011-server-rendered-search-pages.md` — pattern
       documentado (form GET + server render + service call directo +
       lazy provider + RLS hydration), alternativas descartadas,
       triggers de reevaluación. Commit `c0746ac`.
    4. Chronicle: 3 memorias persistidas (vitest script gotcha,
       pattern architectural, TDD-gap insight).

- **F1-011 CV viewer tab** ✅ done — 2026-04-18.
  - `src/app/api/files/[id]/signed-url/route.ts`: `GET` que mintea un
    URL firmado de 1h al bucket privado `candidate-cvs`. Auth: cualquier
    usuario autenticado (recruiter o admin); RLS sobre `files` ya
    enforce el matriz de visibilidad — `maybeSingle()` null = 404 sin
    distinguir "no existe" de "RLS lo escondió". Soft-deleted → 410.
    Resuelve `fileName` desde `raw_data.originalFileName` (uploads
    manuales) o `raw_data.attributes.fileName` (TT-synced) con
    fallback al basename del `storage_path`. URL no se persiste; se
    mintea on-click para que no quede en el HTML rendered.
  - `src/app/(app)/candidates/[id]/open-file-button.tsx`: client
    component que hace fetch del signed-url y `window.open` con
    `noopener,noreferrer`. Estado de loading con `useTransition` y
    error inline.
  - `src/app/(app)/candidates/[id]/page.tsx`: nueva sección
    "Currículums" lista los `files` con `kind='cv'` (no
    soft-deleted), muestra nombre + tipo + estado de parseo, y un
    botón "Abrir" por archivo. La sección "Planilla VAIRIX" ahora
    también renderiza un botón "Abrir" cuando hay archivo subido. El
    placeholder "More coming soon" queda solo para evaluations + notes.
  - 9 tests adversariales en `src/app/api/files/[id]/signed-url/
route.test.ts` (401 unauth, 400 invalid_id, 400 SQL-injection
    shape, 404 not visible, 410 soft-deleted, 500 sign failure,
    happy path con TTL ~1h, fallback `attributes.fileName` para
    TT-synced, fallback al basename). 271/271 unit tests verdes.
  - Downstream: el parser marca `parse_error` y se muestra inline en
    la lista; el operador puede abrir el binario para diagnosticar.

- **F1-011 Evaluations + Notes sections** ✅ done — 2026-04-18.
  - `evaluations-section.tsx`: lista cada `evaluations` (candidate
    interview scorecard) con decisión + score + evaluator + notes +
    las `evaluation_answers` estructuradas (scorecard custom
    questions). Typed-column picker para answer values (value_text /
    value_number / value_range / value_boolean / value_date).
  - `notes-section.tsx`: lista cada `notes` (Teamtailor free-form)
    con author + body + fecha. Read-only — la creación sigue en TT.
  - Ambos fetchs son server-side bajo RLS, dispatcheados en el
    `Promise.all` del page para paralelizar.
  - **Refactor**: page.tsx bajó de 507 → 127 líneas extrayendo 6
    secciones a archivos propios (`applications-section.tsx`,
    `metadata-vairix-section.tsx`, `vairix-sheet-section.tsx`,
    `profile-header.tsx`, + las dos nuevas). Todos los archivos ≤ 300
    líneas cumpliendo `CLAUDE.md §Code Standards`. 262/262 tests verdes.
  - Removido el placeholder "More coming soon" — todas las tabs de
    F1-011 están implementadas (identity, metadata, applications,
    VAIRIX sheet, CVs, evaluations, notes, tags, shortlists).

- **F1-008 CV parser worker** ✅ done — 2026-04-18 — commits
  `6f3cd33` (dispatcher previo) → `d50c26c` (RED) → `5de9156`
  (GREEN) → `cab9bfe` (CLI + integration test).
  - `src/lib/cv/parse-worker.ts`: runtime puro (I/O inyectado) que
    pulla filas pendientes (`deleted_at IS NULL AND parsed_text IS
NULL AND parse_error IS NULL`), descarga por `storage_path`,
    dispatcha a `parseCvBuffer`, y escribe el resultado. Las filas
    terminales (parseadas o con error) no se reprocesan; para
    reintentar un error hay que poner `parse_error=null` a mano.
    Errores de descarga se clasifican como `parse_failure`.
  - `src/scripts/parse-cvs.ts`: CLI `pnpm parse:cvs [--batch=N]`
    (default 50). pdf-parse + mammoth se importan lazy así los
    scripts de sync/embeddings no pagan el costo.
  - 6 unit tests (`src/lib/cv/parse-worker.test.ts`) + 1 integration
    test (`tests/integration/cv/parse-worker.test.ts`) que seedea
    Supabase + Storage locales con 2 pending + 1 parseada + 1 errored,
    corre el worker, verifica que sólo tocó las pendings, y prueba
    que un segundo run es no-op. 348/348 tests verdes.
  - Downstream: F3-001 cv embeddings ya consume `parsed_text` via
    `cvSourceHandler` — no requiere cambios.

- **F1-007 CV download + Storage** ✅ done — 2026-04-18 — commits
  `f53955a` (migration + bucket) → `480077a` (RED downloader) →
  `413f1ba` (GREEN downloader) → `f823860` (uploads syncer + CLI) →
  `ef9bc30` (F1-006b upload endpoint) → `8b2cacc` (F1-006b admin UI).
  - Migration `20260418235000_candidate_cvs_bucket.sql`: crea el
    bucket privado `candidate-cvs` (10 MB cap, MIME whitelist
    pdf/doc/docx/xls/xlsx/csv/txt/rtf), agrega `files.is_internal
boolean not null default false`, y dos policies `storage.objects`
    (recruiter+admin SELECT por bucket_id, admin ALL). Idempotente
    (`on conflict (id) do update`).
  - `src/lib/cv/downloader.ts`: `downloadAndStore(args)` hace fetch
    del URL firmado de TT, SHA-256, y sube a
    `<candidate_uuid>/<file_uuid>.<ext>` con `upsert: true`. Si
    `existingHash === contentHash`, salta el upload y devuelve
    `uploadedFresh: false` (skip idempotente del binario — ADR-006
    §2). 10 tests adversariales (HTTP !== 2xx, hash match/mismatch,
    storage error, content-type inference).
  - `src/lib/sync/uploads.ts`: syncer factory
    `makeUploadsSyncer({ storage, fetch?, randomUuid? })` que
    consume `/v1/uploads?include=candidate`. Reusa `files.id` cuando
    el `teamtailor_id` ya existe, pasa `existingHash` al downloader,
    y si `uploadedFresh` inserta fila con `parsed_text/parsed_at/
parse_error = null` (invalida el parser — ADR-006). Row-level
    errors (orphan FK, download failure) → `sync_errors`; batch no
    aborta. Entity key es `files` (matches seed de `sync_state`).
  - `src/scripts/sync-incremental.ts`: registra
    `files: makeUploadsSyncer({ storage: db.storage.from('candidate-cvs') })`.
    Ejecutable con `pnpm sync:incremental files`.
  - **F1-006b upload manual (admin-only)**: endpoint POST
    `/api/candidates/[id]/vairix-sheet` acepta multipart/form-data
    (xlsx/xls/csv/pdf, ≤10 MB) y hace soft-delete del
    `vairix_cv_sheet` activo anterior antes de insertar la nueva
    fila (satisface el partial unique index de `20260418230000`).
    `is_internal=true`. UI: `VairixSheetUpload` client component
    renderizado sólo cuando `auth.role === 'admin'` en el profile.
  - **Integration test cerrado** `3e05bd4` — 3 tests E2E contra
    Supabase local + Storage con TT y binary URLs mockeados por MSW:
    happy path (2 files subidos + orphan en sync_errors + bytes en
    bucket), idempotencia (re-run con mismos binarios preserva
    parsed_text), binary change (nuevo hash + parsed_text reset a
    null). Lockea el contrato content-addressed contra regresiones.
  - **Tipos DB regenerados** — `pnpm supabase:types` no produjo
    cambios: `is_internal` ya estaba en `src/types/database.ts`.
  - **Pendiente para próxima sesión**: probe manual del sync
    completo contra el tenant VAIRIX (dry-run con `page[size]=5`
    antes de un run completo, siguiendo la regla de validación
    incremental).

- **F1-007 desbloqueado** ✅ 2026-04-18 — probe en
  `src/scripts/probe-uploads.ts` confirmó que `/v1/uploads` existe
  top-level, `include=candidate` popula la relationship, atributos
  son `url` (S3 signed, expira), `fileName`, `internal` (bool),
  `createdAt`, `updatedAt`. Sin `size`/`mimeType` — derivar de la
  extensión (.pdf/.doc/.docx → cv, .xlsx/.csv → vairix_cv_sheet).
  Detalle completo en `docs/teamtailor-api-notes.md §5.7`. F1-007
  pasa de 🚫 BLOCKED a 🔓 UNBLOCKED. Pendiente de input del usuario
  sobre política del bucket `candidate-cvs` antes de implementar el
  downloader.

- **F1-006b VAIRIX CV Sheet filter + profile section** ✅ done —
  2026-04-18 — commits `2604b7c` (migration files.kind) → `c0d0418`
  (RED search) → `2582a9a` (GREEN search filter) → `6f4fbff` (UI:
  list toggle + profile section).
  - **Alcance simplificado a pedido del usuario**: se difiere la
    integración con Google Drive/Sheets hasta terminar el resto del
    roadmap. En su lugar esta iteración entrega dos cosas concretas:
    (a) filtro `has_vairix_cv_sheet` en `/candidates` que matchea por
    `evaluation_answers.value_text` con `question_tt_id='24016'`
    ("Información para CV") **o** por `files.kind='vairix_cv_sheet'`
    no soft-deleted, y (b) sección "Planilla VAIRIX" en
    `/candidates/[id]` que muestra la URL clickeable de TT y el
    nombre del archivo subido (si lo hay).
  - Migration `20260418230000_files_kind.sql`: agrega `kind` a
    `files` (`cv | vairix_cv_sheet`) + partial unique index por
    candidato + índice en `kind`.
  - Backend `src/lib/search/search.ts`: `candidateIdsWithVairixCvSheet()`
    une los dos orígenes (TT URL + archivo) y se intersecta con los
    filtros de applications ya existentes. 3 tests adversariales
    nuevos (URL match, file match, `hasVairixCvSheet=false` tratado
    como sin filtro).
  - UI: `SearchForm` agrega un checkbox "Only candidates with a VAIRIX
    CV sheet"; el perfil muestra la URL cuando existe y un placeholder
    "Carga manual disponible en F1-007 (bucket de Storage)" porque el
    endpoint de upload depende de que F1-007 cree el bucket
    `candidate-cvs` con RLS. Esa parte queda para F1-007.

- **F1-006a interviews/evaluations ingest** ✅ done — 2026-04-18 —
  commits `ab61d0b` (migration) → `7b346e9` (RED) → `1f8ef78` (GREEN).
  - **Descubrimiento clave**: `/v1/interviews` está expuesto por TT
    (1908 registros en el tenant VAIRIX) a pesar de no estar en la
    docs pública. Carga `note`, `status`, relationships candidate/
    job/user y sideload `answers`/`questions`. Esto **unbloquea F1-006
    desde TT** sin depender de Google Docs. La planilla CV por
    candidato sigue externa (F1-006b pendiente, pide auth a Google).
  - Migration `20260418220000_evaluation_answers.sql` +
    `20260418220001_rls_evaluation_answers.sql`: scorecard Q&A con
    columnas tipadas (`value_text|number|boolean|date|range`) keyed
    by `question_tt_id`. Evita bakear IDs custom del tenant en schema.
    Policies espejan `evaluations` (recruiter R, admin R/W).
  - `src/lib/sync/interviews.ts`: syncer con `includesSideloads=true`
    y `include=answers,answers.question`. Candidate requerido →
    orphan a `sync_errors`. Resuelve `application_id` por
    `(candidate_id, job_id)` lookup. Idempotente.
  - Wired a CLI como `pnpm sync:incremental evaluations`.
  - 2 integration tests (happy path + idempotencia) + fixture con
    la URL real de "Información para CV" (q=24016) intacta.

- **Embeddings worker hardening** ✅ done — 2026-04-18 — rango de
  commits `28181bc..6d2e4f6`.
  - `src/lib/embeddings/worker-runtime.ts` — runtime compartido para
    los workers por-source. Los tres workers (profile/notes/cv) pasan
    a ser wrappers de ~80 líneas que sólo aportan su loader
    `buildContents`. Elimina ~250 líneas duplicadas.
  - **Bug latente arreglado**: los workers usaban `.limit(batchSize=500)`
    como tope hard, descartando silenciosamente candidatos >500. El
    runtime ahora paginea con `.range()` hasta agotar. Test de
    regresión `worker-pagination.test.ts` (7 candidatos / batchSize=3
    → 3 páginas, todos embebidos).
  - **Logs estructurados** (JSON a stderr) en cada `embed.page` y
    `embed.done`, con pageSize, totales, `reuseRatio`, `durationMs`
    — base de observabilidad sin decisión de destino (subset de
    F2-005).
  - CLI `pnpm embed:all` que corre profile → notes → cv
    secuencialmente; aborta en la primera falla.

- **Adversarial schema coverage** ✅ done — 2026-04-18 — 35 tests
  (commit `647d2ab`).
  - Exporta `semanticSearchRequestSchema` y `hybridSearchRequestSchema`
    y cubre los bordes de Zod: query vacía/over-sized/non-string,
    limit fuera de rango/no-entero, sourceTypes desconocidos/excedido,
    UUID inválido en jobId, datetime no-ISO, status desconocido,
    coerción empty-string → null, SQL-injection-looking strings
    (pasan verbatim — parameterization downstream).

- **F3-001 cv slice** ✅ done — 2026-04-18 — CV source para el
  embeddings worker (ADR-005 §Fuentes a embeber), rango de commits
  `11965ca..83996a7`.
  - `src/lib/embeddings/sources/cv.ts` — `buildCvContent` elige el
    CV más reciente por candidato (parsed_at desc, tie-break por
    id), ignora files soft-deleted y files sin parsed_text, colapsa
    whitespace y trunca a `CV_CONTENT_MAX_CHARS=30000` (margen
    sobre el límite de 8192 tokens del modelo, Fase 1 trunca al
    primer chunk).
  - `src/lib/embeddings/cv-worker.ts` — `runCvEmbeddings` mirrors
    el notes-worker: una fila por candidate
    (`source_type='cv'`, `source_id=null`), idempotente vía
    `content_hash` (sal=provider.model). Invalida la caché cuando
    se agrega un CV más nuevo o cambia el parsed_text del último.
  - `src/scripts/embed-cv.ts` + `pnpm embed:cv` (flag `--stub`).
  - Tests: 8 unit (`sources/cv.test.ts`) + 4 integration
    (`cv-worker.test.ts`). Total del repo: 270.
  - Pendiente de F3-001: source `evaluation` (bloqueado por F1-006
    evaluations ingest).

- **F3-003** ✅ done (base, sin UI) — 2026-04-18 — Hybrid search
  (UC-01), rango de commits `1f14e69..a98b743`.
  - Migración `20260418210000_hybrid_search_fn.sql` — extiende
    `semantic_search_embeddings` con parámetro `candidate_id_filter
uuid[] default null` para empujar el filtro al RPC y que el
    planner prune el scan ivfflat a la intersección con el set
    pre-filtrado. PostgREST resuelve tanto llamadas con 3 args
    (pure semantic) como 4 args (hybrid).
  - `src/lib/rag/hybrid-search.ts` — `hybridSearchCandidates`:
    resuelve filtros estructurales → candidate_ids, y después
    elige entre 3 modos: `hybrid` (query + filtros → rerank
    restringido), `structured` (sin query → devuelve ids sin
    ranking), `empty` (intersección vacía o input totalmente
    vacío). Garantiza que candidatos fuera del filtro **nunca**
    aparecen en el output ranqueado (propiedad core de UC-01).
  - `src/lib/rag/semantic-search.ts` — extendido con opción
    `candidateIds` que se propaga al RPC; backward-compat (default
    undefined ⇒ comportamiento previo).
  - `src/app/api/search/hybrid/route.ts` — `POST /api/search/hybrid`
    con Zod validando query nullable + filtros estructurados + limit
    - sourceTypes. Provider se resuelve **lazy**: structured-only
      no requiere `OPENAI_API_KEY`.
  - Tests: 4 integration (hybrid/structured/empty/date-filter).
    Los 9 tests previos de F3-002 siguen verdes (no regresión).
  - Pendiente: UI (cómo integrar esto al `/search` existente o como
    página separada).

- **F3-002** ✅ done (base, sin UI) — 2026-04-18 — Query de búsqueda
  semántica (ADR-005 §Consumo), rango de commits `26c8e53..9461dc4`.
  - Migración `20260418200000_semantic_search_fn.sql` — función
    `public.semantic_search_embeddings(query_embedding float8[],
max_results int default 20, source_type_filter text[] default null)`
    que devuelve `(candidate_id, source_type, score)` ordenado por
    proximidad coseno. `security invoker` → RLS de `embeddings`
    aplica; `set search_path = public, extensions` (ADR-009);
    casting interno `float8[]::vector` porque PostgREST no parsea
    el formato textual de pgvector.
  - `src/lib/rag/semantic-search.ts` — `semanticSearchCandidates`
    embeda la query y llama al RPC; short-circuit en query vacía;
    valida dimensión del vector; `dedupeByCandidate` colapsa hits
    por candidate_id tomando el mejor score y acumulando source
    types matcheados, ordenado score DESC.
  - Tests: 5 unit (dedupe helper) + 4 integration (end-to-end con
    stub provider, source filter, limit, exact-match ≈ 1.0).
  - `src/app/api/search/semantic/route.ts` — `POST /api/search/semantic`
    expuesto: body Zod `{query, limit?, sourceTypes?}`, 401 anon,
    503 si falta `OPENAI_API_KEY`, respuesta `{matches: [{candidateId,
bestScore, matchedSources}]}`. Comparte `resolveEmbeddingProvider()`
    con los dos CLIs (refactor que dedup-ea el switch stub/OpenAI).
  - Pendiente: UI (UC-02), hydration de candidate cards,
    hybrid search (F3-003).

- **F3-001** 🏃 en curso — 2026-04-18 — Pipeline de embeddings
  (ADR-005). Sources `profile` y `notes` landeados (`adae0c2..e6bd61e`).
  - Notes slice: `src/lib/embeddings/sources/notes.ts` (concatenación
    cronológica, whitespace normalizado, `null` cuando no hay nada
    útil), `src/lib/embeddings/notes-worker.ts` (mismo patrón que el
    profile worker: hash-based cache, 1 embedding por candidate con
    `source_id=null`, service-role requerido), `src/scripts/embed-notes.ts`
    - `pnpm embed:notes`. 11 tests nuevos (7 unit + 4 integration).
      Cubre first-run, idempotencia, cambio de note (regen) y cambio
      de modelo.

- **F3-001** ✅ done (profile source slice) — 2026-04-18 — Pipeline de embeddings (ADR-005), rango de commits `adae0c2..d36ba17`.
  - `src/lib/embeddings/provider.ts` — interfaz `EmbeddingProvider`
    ({ model, dim, embed(texts) }). Vendor lock-in confinado a los
    archivos de provider (ADR-005 §Consecuencias).
  - `src/lib/embeddings/hash.ts` — `contentHash(model, content)`:
    SHA-256 con separador `\x00` entre model y content. El model
    forma parte del hash → cambiar de modelo invalida todo el caché
    automáticamente.
  - `src/lib/embeddings/stub-provider.ts` — provider determinístico
    para tests y smoke-runs (sin OpenAI). Expande SHA-256 del texto
    a `dim` floats en [-1, 1). Misma entrada ⇒ mismo vector.
  - `src/lib/embeddings/openai-provider.ts` — wrapper thin sobre
    `POST /v1/embeddings`. Realinea la respuesta por `data[].index`.
    Short-circuit en input vacío. Retries/backoff fuera de acá
    (worker). 5 unit tests con `globalThis.fetch` stub.
  - `src/lib/embeddings/sources/profile.ts` —
    `buildProfileContent({firstName, lastName, headline, summary, tags})`:
    compone `"<first> <last> — <headline>\n<summary>\nTags: a, b, c"`
    (tags ordenadas + dedup), normaliza whitespace, devuelve `null`
    cuando no hay contenido útil ⇒ el worker skipea.
  - `src/lib/embeddings/profile-worker.ts` —
    `runProfileEmbeddings(db, provider, {candidateIds?, batchSize?})`:
    carga candidatos + tags + embeddings existentes en paralelo,
    compara hash (match ⇒ reuse), regenera solo lo cambiado, upsert
    manual (read-then-insert/update). Devuelve
    `{processed, skipped, regenerated, reused}`. 4 integration tests
    contra Supabase local con stub provider: first-run, idempotencia,
    content-change, model-change invalida todo.
  - `src/scripts/embed-profiles.ts` + `pnpm embed:profiles` —
    CLI con flag `--stub` para smoke. Exit codes 0/2/4.
  - **Sources pendientes** (mismo patrón, bloqueados por datos):
    `cv` (depende de F1-007/F1-008), `evaluation` (depende de F1-006
    evaluations), `notes` (desbloqueado; pendiente de implementar).

- **F2-004** ✅ done (parte sync_errors) — 2026-04-18 — Admin panel de ETL failures.
  - `src/lib/sync-errors/service.ts` — `listSyncErrors` (default
    unresolved-only, filter por entity, paginación offset+limit),
    `countSyncErrors` (head count con mismos filtros),
    `resolveSyncError` (guard not_found + already_resolved, setea
    `resolved_at`). Error class `SyncErrorAdminError` con codes
    tipados. 8 integration tests verdes.
  - `src/app/(app)/admin/sync-errors/page.tsx` — Server Component
    admin-only (`requireRole('admin')`): filtros por entity +
    includeResolved (GET form), tabla paginada (50/página) con
    badges de entity/error_code/resolved, payload colapsable en
    `<details>`. Inline `ResolveButton` vía server action +
    `useTransition` + `revalidatePath`.
  - `src/app/(app)/admin/page.tsx` — ya no es stub: tile que
    linkea a `/admin/sync-errors` con contador de unresolved.
  - **Pendiente (parte `needs_review`)**: la admin queue de
    rejections clasificadas como `other` depende de F2-002 corriendo
    sobre datos reales — bloqueado por F1-006 evaluations.

- **F2-002** ✅ done (código listo, sin datos en prod) — 2026-04-18 — Rejection normalizer (ADR-007).
  - `src/lib/normalization/rejection-rules.ts` — tabla versionada
    de 10 categorías con keywords ES+EN (technical_skills,
    experience_level, communication, culture_fit,
    salary_expectations, availability, location, no_show,
    ghosting, position_filled). Prioridad explícita.
  - `src/lib/normalization/classify.ts` — función pura
    `classifyRejectionReason(text)`. Case-insensitive, first-match-wins,
    fallback a `{ code: 'other', needsReview: true }`. 21 unit tests.
  - `src/lib/normalization/normalizer.ts` — orquestador
    `normalizeRejections(db, {force?, batchSize?})`: lee
    evaluations con `rejection_reason` no-null y category null
    (a menos que force=true), clasifica, escribe
    `rejection_category_id` + `needs_review` + `normalization_attempted_at`.
    Service-role client requerido (es un job interno post-sync,
    ADR-007 §2). 3 integration tests: batch mixto,
    idempotencia, force-reclassify.
  - **No corre en prod aún**: depende de F1-006 evaluations
    (bloqueado en TT endpoint — ver "Blockers" abajo). El código
    está listo para activarse apenas haya datos.

- **F1-013** ✅ done — 2026-04-18 — Shortlists CRUD + CSV export (UC-03).
  - `src/lib/shortlists/errors.ts` — `ShortlistError` con codes
    tipados (invalid_name, not_found, already_archived,
    already_in_shortlist, not_in_shortlist, db_error,
    app_user_not_found).
  - `src/lib/shortlists/service.ts` — reglas de dominio:
    `normalizeShortlistName` (trim, ≤120), `createShortlist`,
    `listActiveShortlists` (con `candidate_count` via embedded
    aggregate), `getShortlist`, `addCandidateToShortlist`
    (idempotente, bloquea en archived), `removeCandidateFromShortlist`
    (404 on non-member), `archiveShortlist` (rechaza double-archive),
    `listShortlistCandidates`, `candidatesToCsv` (RFC 4180).
  - `tests/integration/shortlists/service.test.ts` — 9 tests:
    normalización, lifecycle (create/list/add/remove/archive),
    idempotent add, archive-blocks-add, CSV escaping.
  - `src/app/(app)/shortlists/actions.ts` — server actions
    (`createShortlistAction`, `createShortlistAndRedirect`,
    `addCandidateAction`, `removeCandidateAction`,
    `archiveShortlistAction`) con `requireAuth` + `revalidatePath`.
  - `src/app/(app)/shortlists/page.tsx` — list + create form.
  - `src/app/(app)/shortlists/[id]/page.tsx` +
    `shortlist-detail.tsx` — detail con archive button, export
    CSV link, per-row remove; archived → read-only.
  - `src/app/api/shortlists/[id]/export.csv/route.ts` — GET
    route handler, `text/csv` + `Content-Disposition: attachment`,
    filename sanitizado.
  - `src/app/(app)/candidates/[id]/add-to-shortlist.tsx` — client
    component con `<select>` de active shortlists + input de nota
    opcional en el perfil del candidato.
  - Sidebar entry "Shortlists" agregado.

- **F1-012** ✅ done — 2026-04-18 — Tags: servicio + UI con creator-or-admin delete.
  - `src/lib/tags/errors.ts` — `TagError` con codes.
  - `src/lib/tags/service.ts` — `normalizeTagName` (trim+lowercase,
    ≤64), `ensureTag` (upsert race-safe), `addTagToCandidate`
    (idempotente), `removeTagFromCandidate` con guard
    **creator-or-admin** (recruiter solo borra sus propios tags),
    `listTagsForCandidate`, `listAllTagNames`.
  - `tests/integration/tags/service.test.ts` — 10 tests, incluye
    auth: recruiter borra su tag, admin borra cualquier tag,
    recruiter no-creador recibe `forbidden`. Helper
    `ensureAuthUser` crea usuarios reales en `auth.users` via
    `auth.admin.createUser` (app_users.auth_user_id tiene FK a
    auth.users).
  - UI: `candidate-tags.tsx` client component con datalist
    autocompletion + chips, optimistic UI via `useTransition`.

- **F1-008** ✅ done — 2026-04-18 — CV parser dispatcher.
  - `src/lib/cv/parse.ts` — `parseCV(file, deps)` dispatcher por
    MIME/extension: pdf, docx, txt; codes de error tipados
    (`unsupported_format`, `parse_failure`, `empty_text`,
    `likely_scanned`). Threshold `SCANNED_MIN_CHARS=200`.
    Normaliza CR/LF, colapsa tabs+espacios, tres o más newlines
    a `\n\n`. Deps inyectadas (`parsePdf`, `parseDocx`) para
    testear sin binarios reales.
  - `src/lib/cv/parse.test.ts` — 12 unit tests (happy path por
    formato, vacíos, scanned detection, unsupported, propagación
    de errores del provider).
  - **Pendiente F1-008 full**: wiring a Storage webhook +
    worker que hace `download → parseCV → upsert files.text +
content_hash`; ver F1-009 (embeddings pipeline).

- **F1-006** ✅ done — 2026-04-18 — notes syncer (UC-07 slice).
  - `tests/fixtures/teamtailor/notes-page-1.json` — 4 notes: happy
    path, FKs nulos (user/application opcionales), body vacío,
    candidate huérfano.
  - `src/lib/sync/notes.ts` + `notesSyncer` registrado en
    `SYNCERS` (post-users/applications). Valida relationship
    candidate + body no vacío (row-level `ParseError`);
    reconcilia FKs via `buildIdMap` para candidates/applications/users;
    orphan candidate → `sync_errors`.
  - `tests/integration/sync/notes.test.ts` — 2 integration tests.

- **Blockers documentados para el usuario** (requieren decisión humana):
  - **F1-007 evaluations syncer**: Teamtailor **no expone** el endpoint
    `/v1/evaluations`. Las evaluaciones reales viven en Google Docs
    por llamado (ver auto-memory `project_custom_data_sources.md`).
    Requiere definir la estrategia de ingest (scraping/manual/otro)
    antes de escribir código.
  - **F1-010 CV downloader / files syncer**: docs marcan el shape de
    `/v1/uploads` como `[VERIFICAR]`. Antes de escribir el syncer,
    confirmar contra una llamada real a TT qué formato viene (ej.
    vs. `/v1/candidates` with sideload). Una vez verificado, el
    parser (F1-008) ya está listo para consumir los archivos.

- **F1-006b** ✅ done — 2026-04-18 — ADR-010 core ingest de custom fields.
  - `docs/adr/adr-010-teamtailor-custom-fields.md` — decisión: EAV
    por owner con columnas tipadas (`custom_fields` catálogo +
    `candidate_custom_field_values` con `value_text/date/number/boolean`
    - `raw_value` siempre); sideload via `paginateWithIncluded`; orden
      `… → custom-fields → candidates → applications`.
  - Migrations 20260418154329..32: tablas nuevas + RLS + seed
    `sync_state` para `custom-fields`. Tipos DB regenerados.
  - `src/lib/teamtailor/paginate-with-included.ts` — async iterator
    que preserva `included` por página junto a cada recurso primario
    (5 unit tests).
  - `src/lib/teamtailor/client.ts` — método `paginateWithIncluded()`
    expuesto usando el mismo pipeline de retry/rate-limit.
  - `src/lib/sync/custom-fields.ts` + `customFieldsSyncer` registrado
    en `SYNCERS` entre `jobs` y `candidates`. 3 integration tests.
  - `src/lib/sync/run.ts` — `EntitySyncer.includesSideloads` flag;
    cuando está activa, el runner itera via `paginateWithIncluded` y
    pasa `included` a `mapResource(resource, included)`. Los 4
    syncers existentes siguen andando sin tocar (reciben `[]`).
  - `src/lib/sync/candidates.ts` — ahora emite
    `{ candidate, customFieldValues[] }`. En `upsert()` hace: (1)
    upsert de candidates con `.select()` para recuperar UUIDs locales,
    (2) lookup batched del catálogo, (3) cast `raw_value` → columna
    tipada según `field_type` (Text/Date/Number/Boolean; raw_value
    siempre preservado), (4) upsert idempotente por
    `teamtailor_value_id`. 2 integration tests.
  - **F1-011b** ✅ — `/candidates/[id]` renderiza la sección
    "Metadata VAIRIX" con los valores del candidato; display por
    `field_type` (Text/Date/Number/Boolean) con fallback a
    `raw_value`; badge "private" visible cuando el catálogo lo marca.
    Sección se oculta cuando no hay valores.
  - **NOTA**: full resync queda documentado pero **no corrido**. Validar
    mapeo con muestras de ~10 candidates antes de escalar.

- **F1-009e** ✅ done — 2026-04-18 — Playwright e2e smoke suite.
  - `playwright.config.ts` — `webServer` arranca `next dev` en
    puerto 3100 forzando `NEXT_PUBLIC_SUPABASE_*` al stack local
    aunque `.env.local` apunte a remoto. `workers: 1`,
    `fullyParallel: false`, `storageState` compartido.
  - `tests/e2e/seed.ts` — seed idempotente (`wipeE2EArtifacts` +
    `seedE2EFixtures`) que crea admin auth user, `app_users` admin,
    3 candidates (Alice/Bob/Carla), 1 job "Backend Engineer" y 1
    application activa (Alice→backend). Identificable por email
    `@e2e.test` y `teamtailor_id` prefijo `e2e-`. Corre también
    stand-alone con `pnpm test:e2e:seed`.
  - `tests/e2e/global-setup.ts` — mintea sesión admin sin round-trip
    browser: `admin.generateLink` → `email_otp` → `verifyOtp` con
    anon client → serializa la sesión con el mismo formato que
    `@supabase/ssr` (cookie `sb-127-auth-token`, prefijo `base64-`,
    base64url de JSON, chunking a 3180 chars) y escribe
    `playwright/.auth/admin.json` directo. Esto esquiva el hecho
    de que `generateLink` devuelve implicit-flow (hash tokens)
    mientras que el callback de la app es PKCE-only.
  - `tests/e2e/smoke.spec.ts` — 8 tests `@smoke`: home autenticado,
    empty state de candidates, query devuelve Alice, filtro status,
    click → profile, 404 en UUID inválido, logout, redirect a
    `/login` en no-autenticado. Todos verdes en ~13s.
  - Fix lateral: `src/app/login/login-form.tsx` tenía
    `useActionState` (React 19) pero el proyecto usa React 18.3;
    cambiado a `useFormState` desde `react-dom`.
  - Nuevo script `pnpm test:e2e:smoke` para correr la suite.

- **F1-005** ✅ done — 2026-04-17 — commits
  `5543446`/`fbe9c1e` (F1-005a: lock),
  `956bd17` (F1-005c: CLI), con F1-005b entre ambos
  (`test(sync): [RED] runIncremental...` + `feat(sync): [GREEN] runIncremental...`).
  - `src/lib/sync/`:
    - `errors.ts` — `SyncError`, `LockBusyError`, `UnknownEntityError`.
    - `lock.ts` — `acquireLock` con conditional UPDATE (no matchea
      si hay run activo dentro del stale window); `releaseLock`
      estampa `last_run_finished` + status, en 'error' NO avanza
      `last_synced_at`; `readSyncState` helper camelCase.
    - `run.ts` — `runIncremental` genérico + contrato
      `EntitySyncer` (buildInitialRequest / mapResource / upsert).
      Row error → `sync_errors`, batch continúa. Upsert falla
      o TT agota retries → release error + watermark pinned.
      Usa `last_run_started` como nuevo watermark al success.
    - `stages.ts` — primer syncer concreto: mapea
      `/stages` → tabla `stages` con `job_id = null` (la
      reconciliación con jobs viene en F1-006).
  - `src/scripts/sync-incremental.ts` — CLI entry point con
    exit codes distintos por escenario (0/1/2/3/4).
  - Tests: 10 nuevos integration tests contra Supabase local +
    MSW, cubren los 5 acceptance criteria de UC-05 (idempotency,
    stale lock reclaim, fatal preserves watermark, row error
    continues batch, upsert all pages).
  - Gotcha corregido: MSW `setupServer` por default bloquea
    TODOS los requests con `onUnhandledRequest: 'error'`;
    usamos un matcher custom para sólo bloquear calls al
    BASE_URL de Teamtailor y dejar pasar los de Supabase local.
  - Gotcha corregido: Postgres timestamptz vuelve como
    `+00:00` por PostgREST (no `.000Z`); las aserciones
    comparan por epoch ms.

- **F1-004** ✅ done — 2026-04-17 — commits
  `a4097e1`/`0a72be6` (F1-004a: errors/types/rate-limit/retry/parse),
  `0668b40`/`09b52a7` (F1-004b: client + paginate con MSW).
  - Módulos en `src/lib/teamtailor/`:
    - `errors.ts` — jerarquía `TeamtailorError` → `HttpError`,
      `RateLimitError`, `ParseError` con `context` opcional.
    - `types.ts` — tipos JSON:API (`TTJsonApiDocument`,
      `TTJsonApiResource`, `TTJsonApiLinks`) y parsed
      (`TTParsedDocument`, `TTParsedResource`). Attributes
      normalizadas shallow kebab→camel.
    - `rate-limit.ts` — `TokenBucket` con clock inyectable
      (`pendingWaitMs()` + `take()`; caller hace el sleep).
    - `retry.ts` — `defaultRetryPolicy()` (5 attempts, 1s→30s,
      jitter 50–100 %), `parseRetryAfter()` (segundos numéricos
      - RFC 7231), `shouldRetry()` y `computeBackoff()`.
    - `parse.ts` — `parseDocument()`/`parseResource()` con
      `ParseError` en shapes inválidas; coerce data single↔array.
    - `paginate.ts` — async iterator genérico que consume
      `links.next` y respeta break temprano del consumidor.
    - `client.ts` — `TeamtailorClient` compone todo:
      fetch (inyectable para MSW) + auth headers
      (`Authorization: Token token=<key>` / `X-Api-Version` /
      `Accept: application/vnd.api+json`) + bucket global +
      retry (429/5xx/network, honra Retry-After). Expone
      `get()` y `paginate()`.
  - Tests (vitest + msw/node): 52 unit tests en 6 suites,
    todos verdes en <1 s. Fixtures anonimizadas en
    `tests/fixtures/teamtailor/candidates-page-{1,2,3}.json`.
    Virtual clock (`now` + `sleep` inyectados) evita esperas
    reales en tests de retry/rate-limit.
  - Gotcha corregido: en el test de Retry-After el default
    jitter (50–100 %) hacía la aserción flaky; se usa jitter
    identidad en ese test para aserciones exactas.

- **F1-003** ✅ done — 2026-04-17 — commits
  `c851643`/`04789fa` (app_users), `36b97b0`/`8958273` + `036c934` (Wave 1),
  `cb08d1e`/`dbb324f` (Wave 2), `923e3d1`/`47f2bb2` (Wave 3),
  `20e7f3a`/`cbf5a92` (fixes al hook).
  - 17 tablas de dominio creadas con RLS enabled + forced. 4 policies
    por tabla (select/insert/update/delete) salvo sync_state y
    sync_errors (1 policy `for all` admin-only).
  - Helper `public.current_app_role()` (SECURITY DEFINER) resuelve rol
    desde `app_users` por `auth.uid()`. Divergencia explícita con
    ADR-003 §5 que proponía claim JWT; documentada en commit
    `04789fa`.
  - 24 migraciones (13 de schema + 11 de RLS).
  - 16 suites de tests RLS con 54 tests en total. `fileParallelism:
false` en `vitest.config.ts` — los tests comparten estado en la
    misma DB local y paralelizar causa race conditions en teardown.
  - Tipos TS regenerados al final de cada Wave.
  - Fixes colaterales del pre-commit hook:
    - `TDD_RED=1` permite saltear el paso de tests para commits
      `[RED]` intencionales (documentado en
      `.claude/skills/tdd-workflow/SKILL.md`).
    - Chequeo de "tipos regenerados" ahora acepta el caso de tipos
      ya al día en HEAD sin re-stagear (útil para commits
      secuenciales de migraciones en un batch); usa tempfile para
      evitar que `command substitution` corra los trailing newlines
      y rompa el diff.
  - Harness de RLS en `tests/rls/helpers.ts` firma JWT HS256 con
    `node:crypto` (sin dependencia externa).
  - Desvío del plan: `shortlist_candidates` se creó en Wave 2 junto
    con `shortlists` (el plan original lo listaba en Wave 3); el
    split natural es por dependencia del grafo (ambas tablas
    comparten FK a `app_users`).

- **F1-002** ✅ done — 2026-04-17 — commit `be7d1f9`
  - `supabase init` + stack local arriba (Postgres 15, pgvector 0.7.4,
    Studio en :54323, DB en :54322)
  - Migración `20260417201204_extensions_and_helpers.sql`:
    `uuid-ossp`, `vector`, `pg_trgm` + función `set_updated_at()`
  - `supabase db reset` aplica limpio; `supabase db diff` vacío
  - `src/types/database.ts` regenerado (scaffolding, sin tablas de
    dominio todavía)
  - Fixes colaterales del pre-commit hook:
    - Removida entrada `*.sql` de lint-staged (prettier sin parser SQL)
    - Agregado `--no-warn-ignored` al eslint de `*.{ts,tsx}` para que
      lint-staged no falle cuando toca archivos en `ignores`

- **F1-001** ✅ done — 2026-04-17 — commits `078f6f2`, `71b78bb`
  - `tsconfig.json` con `strict` + `noUncheckedIndexedAccess` + alias `@/`
  - `eslint.config.js` (flat config ESLint 9) + `@typescript-eslint`
    - `@next/eslint-plugin-next` con `no-explicit-any:error` y
      `consistent-type-imports:warn`. `no-undef:off` porque TS ya
      cubre globals (JSX, etc.)
  - `.prettierrc` (100 cols, singleQuote, trailingComma all) +
    `.prettierignore`
  - Skeleton App Router: `src/app/layout.tsx` + `src/app/page.tsx`,
    `next-env.d.ts`. `package.json` con `"type": "module"` para
    ESLint ESM
  - Fix colateral: el hook `.claude/hooks/pre-commit.sh` llamaba
    `pnpm test --run` y pnpm 9 interpretaba `run` como subcomando.
    Reemplazado por `pnpm exec vitest run`
  - `pnpm format` corrió contra todo el repo (commit separado
    `71b78bb` de solo reformato — 41 archivos docs/config)
  - DoD: `pnpm install` limpio, `pnpm typecheck` verde,
    `pnpm lint` verde

- **infra/chronicle-mcp** ✅ done — 2026-04-17 — commit `5953276`
  - `~/.chronicle/config.json` creado (userId=gabo,
    dbPath=$HOME/.chronicle/chronicle.db)
  - Entrada `chronicle` agregada en `.mcp.json` (mcpServers +
    tooling_boundaries), JSON validado con `jq`
  - Pre-descarga de `chronicle-mcp` vía `npx` OK
  - ADR-008 creado
  - **Etapa 3** ✅ seed de 15 items: 10 memorias Core
    (7 architectural ADR-001..007 + 3 procedural: rate limit TT,
    chmod post-unzip, regen tipos post-migración), 2 Working
    (semantic: quirk macOS Finder dotfiles, ausencia sandbox TT),
    3 preferences (pnpm, Conventional Commits, TS estricto)
  - **Etapa 4** ✅ 3 triggers activos: `backfill` (warning/T2),
    `drop-table` (critical/T3), `deploy` (warning/checklist
    pre-merge)
  - **Etapa 5** ✅ validación: `stats` = 12 mem + 3 prefs,
    `recall "RLS y roles"` devuelve ADR-001/002/003, los 3 `check`
    disparan OK
  - Railway sync **NO activado** (Fase 1 → requiere ADR dedicado)
  - Desvío del runbook: `docs/scaffolding-inventory.md` no existe
    en el repo; el step 7.1 se saltea y se documenta acá en lugar
    de crear el archivo out-of-scope
  - Quirk menor: `hostname` en macOS devolvió la IP local
    (192.168.1.8) como `deviceId`. No bloqueante; editable en
    caliente en `~/.chronicle/config.json`
  - Quirk Chronicle: las 2 memorias `semantic` quedaron en tier
    `working` en lugar de `buffer` (Chronicle auto-tiera por
    tipo/confirmación; no expone parámetro de tier explícito).
    No bloqueante

---

## 🏃 En progreso

_(nada todavía)_

---

## ⏳ Próximo (top 3 del roadmap)

1. **F1-006** — Syncers restantes por entidad (users, jobs,
   candidates, applications, evaluations, notes, files) + reconciliación
   de FKs (ej: `stages.job_id`).
2. **F1-007** — CV download + Storage upload.
3. **F1-008** — Dashboard mínimo (UI layer, post-ETL productivo).

Ver `docs/roadmap.md` para el plan completo con prompts.

---

## 🚫 Bloqueos

- ⏳ **Lista de custom fields de Teamtailor** (pendiente de acceso).
- ⏳ **Tenant de staging en Teamtailor** (no existe, hay que crear).
- ✅ **Verificar `X-Api-Version` vigente** — resuelto 2026-04-17:
  la vigente es `20240904` (la API la revela con HTTP 406 si falta
  el header). `.env.example` actualizado.

---

## ⚠️ Drift detectado entre docs

_(lista de inconsistencias encontradas y su plan de resolución)_

- ADR-002 lista orden de sync `jobs → candidates → …`; ADR-004 y
  `spec.md` dicen `stages → users → jobs → …`.
  **Plan**: actualizar ADR-002 con nota "orden actualizado en
  ADR-004" (pendiente F1-000).

---

## 📊 Health checks

- [x] `pnpm typecheck` — verde (2026-04-17)
- [x] `pnpm lint` — verde (2026-04-17)
- [x] `pnpm test` — 116/116 verde (2026-04-17), ~10s end-to-end
      (54 RLS + 52 unit de `src/lib/teamtailor` + 10 integration
      de `src/lib/sync`)
- [ ] Coverage global ≥ 80% — _(no medido formalmente todavía;
      teamtailor/ y sync/ con cobertura representativa por tests)_

---

## 📘 Cambios recientes de docs/infra

- **2026-04-17** — ADR-003 §7 agregado: nueva nomenclatura de API
  keys de Supabase (modelo 2025+). Env vars renombrados:
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SECRET_KEY`. Actualizados:
  `.env.example`, `scripts/bootstrap.sh`, `.claude/hooks/pre-commit.sh`
  (+ guardrail sobre prefijo `sb_secret_`),
  `.claude/agents/security-reviewer.md`,
  `.claude/skills/rls-policies/SKILL.md`,
  `docs/runbooks/initial-backfill.md`. Seed Chronicle como memoria
  semantic (Core).

---

## 🔐 Deuda de seguridad (acotada, con plazo)

- **🔄 Rotar `TEAMTAILOR_API_TOKEN` a least-privilege antes del
  primer backfill real (F1-004)**.
  - **Estado actual**: clave "Dev" con alcance **Administrador + Leer/Escribir**.
  - **Objetivo**: clave nueva `recruitment-platform-etl-ro` con
    alcance **Administrador + Leer** (sin Escribir). El ETL es
    read-only por ADR-002.
  - **Cuándo**: antes de habilitar `DRY_RUN=false` en el primer
    sync contra tenant productivo (F1-004, pre-flight del runbook
    `docs/runbooks/initial-backfill.md`).
  - **Cómo**: Teamtailor admin → Integraciones → Claves API →
    Nueva clave API → Alcance=Administrador, Leer=✓, Escribir=✗ →
    actualizar `.env.local` + secrets de Supabase Edge + secrets de
    GitHub Actions → smoke test → revocar la "Dev".

- **🔄 Rotar `SUPABASE_SECRET_KEY` antes de Fase 2 / staging**.
  - **Estado actual**: valor `sb_secret_0BfS...` compartido por
    chat durante el setup del 2026-04-17.
  - **Cuándo**: antes de cualquier ambiente no-dev. Ver ADR-003 §7
    sobre el modelo nuevo de keys rotables.

- **🔄 Rotar `OPENAI_API_KEY` antes de Fase 2 / staging**.
  - **Estado actual**: key project-scoped `sk-proj-Zp1N...`
    compartida por chat durante el setup del 2026-04-17.
  - **Cuándo**: antes de cualquier ambiente no-dev. Al rotar, usar
    el límite de gasto (usage limit) del proyecto de OpenAI para
    acotar blast radius.

---

## 🔗 Notas volátiles

_(cosas que se van descubriendo y hay que validar — no arquitectura
formal, solo memoria de trabajo)_

- Revisar si `text-embedding-3-small` sigue siendo el último
  modelo "small" al momento de F3-001.
- Al arrancar F1-004, confirmar rate limit real contra tenant de
  prueba (la doc dice ~50 req/10s; verificar).
- **[2026-04-18] Auditoría de muestra (900 candidates, 1 job, 10
  stages/users) sobre tenant productivo**: el syncer actual NO usa
  `?include=...` en las llamadas a TT. `raw_data.relationships`
  trae sólo links (`self`/`related`) pero no los recursos sideloaded.
  Consecuencia: `custom-field-values`, `form-answers`, `uploads`
  (CVs), `interviews`, `answers`, `questions` quedan sin persistir.
  Antes de full sync hay que:
  1. Listar los custom fields del tenant (`/custom-fields`) y
     decidir cuáles mapear a columnas vs dejar en `raw_data`.
  2. Decidir si los adjuntos de `uploads` se descargan al bucket
     `candidate-cvs` como parte del ETL o vía worker separado.
  3. Definir cómo entran los formularios de entrevista técnica que
     hoy viven en Google Docs (ADR nuevo: integración con Drive).
  4. Extender syncers con `include` params + sideload handling en
     `client.paginate` si aún no lo soporta.
- **Full sync DIFERIDO**: no correr `pnpm sync:full` hasta validar
  puntos 1–4 de arriba. Usar muestras capeadas vía cap temporal o
  `page[size]` bajo mientras se audita.

---

## Convención de entradas

Al cerrar una sesión, agregar una entrada en la sección correcta:

```
- **F1-003** ✅ done — 2026-04-18 — commit abc123
  - aplicadas 13 migraciones
  - 42 tests RLS verdes
  - tipos regenerados
  - nota: agregado índice extra sobre `evaluations.needs_review`
    que no estaba en data-model.md → PR al doc pendiente
```

Si quedó algo abierto, anotarlo explícitamente:

```
- **F1-005** 🏃 in progress — 2026-04-18 — commit def456
  - lock + stale timeout implementados
  - falta: tests de race condition entre dos runs
  - bloqueado por: decisión sobre advisory locks vs lock column
```
