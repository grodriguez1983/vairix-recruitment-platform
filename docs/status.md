# 📍 Status — Recruitment Data Platform

> Actualizado al final de **cada sesión** de Claude Code. Snapshot
> del estado; no es un registro histórico completo (para eso está
> el git log).

**Última actualización**: 2026-04-18
**Última sesión**: 2026-04-18 — F1-006 notes, F1-008 CV parser, F1-012 tags, F1-013 shortlists, F2-002 rejection normalizer (ready-to-run), F2-004 sync_errors admin, F3-001 profile+notes embeddings, F3-002 semantic search
**Fase activa**: **Fase 1 — Fundación** (+ F2-002/F2-004 adelantadas, F3-001 profile+notes slices, F3-002 base)

---

## ✅ Completado

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
  - Pendiente: UI/API endpoint (UC-02 pure semantic), hydration
    de candidate cards, hybrid search (F3-003).

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
