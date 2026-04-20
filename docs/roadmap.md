# 🗺️ Roadmap — Prompt-Bound Execution Plan

> **Paper GS §6.3**: un item del roadmap sin prompt pre-generado es
> solo un título. Para que Claude Code pueda ejecutar sin
> reconstituir contexto, **cada item abajo trae un prompt listo**
> que referencia artefactos concretos del repo.
>
> El gate de cada item es la Definition of Done en
> `CLAUDE.md` + los tests listados en `use-cases.md`.

---

## Cómo leer este documento

Cada item tiene:

- **ID**: referencia estable (ej: `F1-003`).
- **Fase**: 1, 2, 3 o 4 (según `spec.md` §10).
- **Depende de**: IDs bloqueantes.
- **Prompt**: texto exacto para pegar a Claude Code al iniciar la tarea.
- **DoD**: acceptance criteria concretos.
- **Estimación**: horas ideales, no "días hombre".

Status: `⏳ TODO` / `🏃 IN PROGRESS` / `✅ DONE` / `🚫 BLOCKED`.

---

## Fase 1 — Fundación

> **Estado al 2026-04-18**: 14 / 15 items ✅ done (F1-008 CV parser
> worker cerrado, F1-007 CV download + Storage cerrado, F1-006b
> upload manual admin-only cerrado); 1 🏃 parcial (F1-006b CV Sheet
> worker externo pendiente), 1 🏃 parcial derivado (F1-011 tabs
> faltantes).
> Ver `docs/status.md` para detalle por sesión.

### F1-001 — Bootstrap del repo ✅ DONE (2026-04-14, `078f6f2`)

**Prompt**:

> Iniciá el repo siguiendo `claude-code-conventions.md` §1. Creá
> `package.json` con Next.js 14 + TS estricto + pnpm. Configurá
> `.nvmrc`, `.prettierrc`, `.eslintrc`, `tsconfig.json` con
> `strict: true` y `noUncheckedIndexedAccess: true`. No agregues
> dependencies no mencionadas en ADRs o convenciones. Commit:
> `chore(infra): bootstrap repo scaffolding`.

**DoD**:

- `pnpm install` limpio.
- `pnpm typecheck` verde (sin código aún, solo config).
- `.env.example` copiado a su lugar final.

**Estimación**: 2 h.

---

### F1-002 — Supabase local + primera migración ✅ DONE (2026-04-14, `be7d1f9`)

**Depende de**: F1-001.

**Prompt**:

> Inicializá Supabase local con `supabase init`. Creá la primera
> migración `001_extensions_and_helpers.sql` que instale
> `uuid-ossp`, `vector`, `pg_trgm` y cree la función
> `set_updated_at()` documentada en `data-model.md`. Corré
> `supabase db reset` local y verificá que aplica. No toques ninguna
> tabla aún — esta migración es solo extensions + helpers. Commit:
> `feat(db): add extensions and updated_at trigger helper`.

**DoD**:

- Migración aplica sin errores en local.
- `supabase db diff` vacío después de aplicarla.

**Estimación**: 1 h.

---

### F1-003 — Schema de dominio + RLS base ✅ DONE (2026-04-15, `04789fa`..`dbb324f`)

**Depende de**: F1-002.

**Prompt**:

> Creá las migraciones necesarias para implementar todas las tablas
> de `data-model.md` §§1-15. Una migración por "grupo lógico":
> `002_app_users.sql`, `003_candidates.sql`, `004_users.sql`,
> `005_jobs_stages.sql`, `006_applications.sql`,
> `007_rejection_categories.sql`, `008_evaluations_notes.sql`,
> `009_files.sql`, `010_tags.sql`, `011_shortlists.sql`,
> `012_embeddings.sql`, `013_sync_state_errors.sql`. RLS policies
> van en archivos separados `0XX_rls_<tabla>.sql`, siguiendo ADR-003.
> Regenerá tipos con `supabase gen types typescript`. Tests RLS
> obligatorios (uno por tabla mínimo) en `tests/rls/`. Commit por
> migración: `feat(db): add <table> schema and RLS policies`.

**DoD**:

- Todas las migraciones aplican en orden.
- Seed de `rejection_categories` aplicado.
- Tipos TS generados en `src/types/database.ts`.
- Tests RLS verdes (mínimo un test por tabla de dominio).

**Estimación**: 12 h.

---

### F1-004 — Cliente Teamtailor con rate limit ✅ DONE (2026-04-16, `09b52a7` + `f23e30a`)

**Depende de**: F1-001.

**Prompt**:

> Implementá `src/lib/teamtailor/client.ts` con:
>
> - Token bucket (~4 req/s, burst 10).
> - Backoff exponencial + jitter ante 429/5xx.
> - Parser de respuestas JSON:API → objetos planos.
> - Paginación iterable: `for await (const page of client.paginate('/candidates'))`.
> - Respeta `Retry-After`.
> - Tipa las entidades según `teamtailor-api-notes.md` §5.
>   Fixtures en `tests/fixtures/teamtailor/` con respuestas reales
>   anonimizadas. Tests con MSW que cubran: paginación completa, 429
>   con Retry-After, 5xx transitorio, 4xx persistente, rate limit
>   respetado. Commit: `feat(teamtailor): add rate-limited JSON:API client`.

**DoD**:

- Todos los tests de `docs/test-architecture.md` §3 "Against Teamtailor" pasan.
- Cobertura de `src/lib/teamtailor/` ≥ 90%.

**Estimación**: 8 h.

---

### F1-005 — Skeleton de ETL con sync_state ✅ DONE (2026-04-17, `4f48cbe` + `956bd17`)

**Depende de**: F1-003, F1-004.

**Prompt**:

> Implementá el esqueleto del ETL en `src/lib/sync/` con:
>
> - `acquireLock(entity)` / `releaseLock(entity)` sobre `sync_state`,
>   respetando stale timeout de 1h (ADR-004 §Concurrencia).
> - `runIncremental(entity)` genérico que toma un `EntitySyncer`
>   y ejecuta el loop (fetch pages → upsert → log errors).
> - Un `EntitySyncer` concreto para `stages` (la más chica, para
>   validar el shape). Los otros vienen en items siguientes.
> - Manejo de errores: row error → `sync_errors`, batch continúa;
>   fatal → `last_run_status='error'`, `last_synced_at` NO avanza.
> - Entry point como script: `pnpm sync:incremental <entity>`.
>   Tests: `test_sync_upsert_is_idempotent`,
>   `test_sync_stale_lock_is_reclaimed`,
>   `test_sync_fatal_error_preserves_last_synced_at`,
>   `test_sync_row_error_does_not_stop_batch`.
>   Commit: `feat(sync): add ETL skeleton and stages syncer`.

**DoD**:

- Los 4 tests adversariales del use case UC-05 pasan.
- `pnpm sync:incremental stages` corre contra Supabase local + MSW.

**Estimación**: 10 h.

---

### F1-006 — Syncers por entidad (users, jobs, candidates, applications, evaluations, notes) 🏃 PARTIAL (2026-04-18, `1f8ef78`)

> ✅ stages, users, jobs, candidates (+ custom-field-values sideload),
> applications, notes, **evaluations (F1-006a)**, **VAIRIX CV Sheet
> filter + profile section (F1-006b)** (2026-04-18, `6f4fbff`).
>
> **F1-006b scope simplificado**: en lugar de integrar Google Drive/Sheets,
> se expone (a) un filtro `has_vairix_cv_sheet` en `/candidates` que
> encuentra candidatos con planilla asociada (URL en `evaluation_answers`
> para question_tt_id=24016 "Información para CV", o archivo subido en
> `files.kind='vairix_cv_sheet'`), y (b) una sección "Planilla VAIRIX"
> en el perfil del candidato que muestra la URL clickeable y el archivo
> subido (si lo hay). **La integración con Google Drive/Sheets queda
> diferida** hasta terminar el resto del roadmap. La subida manual del
> xlsx depende de F1-007 (creación del bucket `candidate-cvs`).

**Depende de**: F1-005.

**Prompt**:

> Implementá un `EntitySyncer` por entidad listada en
> `spec.md` §5. Respetá el orden de sync. Cada syncer:
>
> - Mapea respuesta Teamtailor → schema interno (ver
>   `data-model.md`).
> - Resuelve FKs externas a `uuid` interno antes del insert (ej:
>   `application.job_id` se resuelve del `teamtailor_id` del job).
> - Guarda `raw_data` con el payload original.
> - Test unitario por mapeo + integration con fixtures.
>   Commits separados por syncer: `feat(sync): add <entity> syncer`.

**DoD**:

- Todos los syncers pasan contra fixtures.
- `pnpm sync:incremental` (sin arg) ejecuta el orden completo.

**Estimación**: 16 h.

---

### F1-007 — CV download + Storage upload ✅ DONE (2026-04-18)

> Commits: `f53955a` (migration + bucket + is_internal + storage RLS)
> → `480077a` (RED downloader) → `413f1ba` (GREEN downloader) →
> `f823860` (uploads syncer + CLI) → `ef9bc30` (F1-006b upload
> endpoint) → `8b2cacc` (F1-006b admin UI form).
>
> Bucket `candidate-cvs` privado, 10 MB cap, MIME whitelist
> (pdf/doc/docx/xls/xlsx/csv/txt/rtf). RLS: recruiter+admin SELECT,
> admin ALL. Paths: `<candidate_uuid>/<file_uuid>.<ext>`.
> Content-addressed: si `existingHash === contentHash` se salta el
> upload (ADR-006 §2). El syncer invalida `parsed_text/parsed_at/
parse_error` cuando re-sube, así F1-008 re-parsea sólo lo cambiado.
> Row-level errors (orphan FK, download failure) → `sync_errors`.
>
> CLI: `pnpm sync:incremental files`.
>
> **Pendiente** (no bloqueante, próxima sesión):
>
> - Dry-run contra el tenant VAIRIX con `page[size]=5` antes de
>   un run completo.

---

### F1-008 — CV parser (pdf-parse, mammoth) ✅ DONE (2026-04-18)

> Commits: `6f3cd33` (dispatcher `parseCvBuffer` + 12 tests) →
> `d50c26c` (RED worker) → `5de9156` (GREEN worker) → `cab9bfe`
> (CLI + integration test).
>
> Pipeline: `files` filas que llegan via F1-007 con `parsed_text=null`
> y `parse_error=null` → worker las toma, descarga de Storage, llama
> `parseCvBuffer(file_type, buffer, deps)` → escribe `parsed_text`
> (éxito) o `parse_error` (`unsupported_format | parse_failure |
empty_text | likely_scanned`) siempre con `parsed_at` sellado.
> Las filas terminales no se reprocesan — para reintentar un error
> hay que limpiar `parse_error`. Errores de descarga se clasifican
> como `parse_failure`. Integration test cubre 4 rows (2 pending,
> 1 parseado, 1 errored) contra Supabase + Storage locales.
>
> CLI: `pnpm parse:cvs [--batch=N]` (default 50).
>
> Downstream: F3-001 cv embeddings ya levanta `parsed_text` via
> `cvSourceHandler` — no requiere cambios.

---

### F1-009 — Auth + layout UI base ✅ DONE (2026-04-18, `5fa2e07` + `6928c55`)

**Depende de**: F1-003.

**Prompt**:

> Implementá auth en Next.js App Router siguiendo ADR-003:
>
> - `src/lib/auth/` con `requireAuth()`, `requireRole('admin')`.
> - Custom claim `role` inyectado vía función
>   `auth.jwt_custom_claims` que lee `app_users.role`.
> - Login page con magic link (sin registro público).
> - Layout base con sidebar + header según `ui-style-guide.md` §13.
> - Toggle dark/light, dark por default.
> - Font loading con `next/font/google` (DM Sans + Inter).
> - Tailwind config con todos los CSS vars de §11.
>   Tests E2E: login exitoso, logout, acceso denegado sin JWT.
>   Commit: `feat(auth): add supabase auth and base layout`.

**DoD**:

- Login + logout funcionan en local.
- Dark/light switch persiste.
- RLS activa en todas las queries de UI.

**Estimación**: 10 h.

---

### F1-010 — Búsqueda estructurada ✅ DONE (2026-04-18, `537b0cd`..`593e3f2`)

**Depende de**: F1-006, F1-009.

**Prompt**:

> Implementá la búsqueda estructurada (UC-01 sin la parte semántica).
>
> - `/api/search` route con auth + filters (status, date range,
>   skills, rejection_category, job).
> - UI: barra de búsqueda tipo Google + drawer de filtros lateral.
> - Card de candidate según `ui-style-guide.md` §8 (corner
>   asimétrico en shortlisted).
> - Paginación simple.
>   Tests E2E: búsqueda devuelve resultados esperados, filtros
>   aplican, RLS respeta soft delete.
>   Commit: `feat(ui): add structured search and candidate cards`.

**DoD**:

- Smoke E2E UC-01 (parte estructurada) verde.
- Performance: p95 < 300 ms con 5k candidates en local.

**Estimación**: 14 h.

---

### F1-011 — Perfil consolidado del candidate ✅ DONE (2026-04-18)

> ✅ Identity header, applications list, custom fields
> ("Metadata VAIRIX"), VAIRIX sheet, **CV viewer** (signed-url
> endpoint + OpenFileButton + Currículums), **Evaluations**
> (scorecard answers + decision), **Notes** (TT free-form),
> tags, "Add to shortlist" form.
> Page refactored into one file per section (all ≤ 300 LOC).

**Depende de**: F1-010, F1-008.

**Prompt**:

> Implementá UC-04: drawer/página de perfil con tabs CV,
> Applications, Evaluations, Tags, Notes. Endpoint
> `/api/files/:id/signed-url` que genera URL de 1h. UI muestra CV
> en iframe o abre en nueva pestaña.
> Tests E2E UC-04 acceptance criteria.
> Commit: `feat(ui): add candidate profile with consolidated view`.

**DoD**:

- UC-04 E2E verde.
- Signed URL expira en 1h (test unitario del TTL).

**Estimación**: 10 h.

---

### F1-012 — Tags manuales ✅ DONE (2026-04-18, `f7036bb`)

**Depende de**: F1-011.

**Prompt**:

> Implementá CRUD de tags + `candidate_tags`. UI: chips editables
> inline en perfil, autocomplete de tags existentes.
> Tests: tag duplicado rechazado, solo creator o admin puede borrar.
> Commit: `feat(ui): add manual tag management`.

**Estimación**: 6 h.

---

### F1-013 — Shortlists ✅ DONE (2026-04-18, `a506e34`..`2e9df5c`)

**Depende de**: F1-011.

**Prompt**:

> Implementá UC-03. Modelo ya en schema (F1-003). UI: lista de
> shortlists en sidebar, "Add to shortlist" desde resultado de
> búsqueda y desde perfil, vista de shortlist con acciones archive
> y export CSV.
> Tests UC-03 completos.
> Commit: `feat(ui): add shortlists management`.

**Estimación**: 10 h.

---

### F1-014 — Hooks + CI pipeline ✅ DONE (2026-04-17, `1db2e5c` + `.github/workflows/ci.yml`)

**Depende de**: F1-001.

**Prompt**:

> Configurá husky + lint-staged con:
>
> - pre-commit: prettier + eslint + typecheck sobre files
>   staged.
> - commit-msg: validar Conventional Commits (`@commitlint/cli`).
> - pre-push: correr tests unitarios.
> - Hook custom `pre-commit-phase` que rechaza `feat:` commits sin
>   `test: [RED]` previo en el mismo scope (lee git log).
>   GitHub Actions `.github/workflows/ci.yml` con el pipeline de
>   `docs/test-architecture.md` §10.
>   Commit: `ci: add pre-commit hooks and github actions pipeline`.

**DoD**:

- Commit con test skippeado es bloqueado.
- Commit sin formato conventional es bloqueado.
- CI corre typecheck + lint + unit + integration en PR.

**Estimación**: 6 h.

---

### F1-015 — Runbook del backfill inicial ✅ DONE (`docs/runbooks/initial-backfill.md`)

**Depende de**: F1-006, F1-008.

**Prompt**:

> Escribí `docs/runbooks/initial-backfill.md` con:
>
> - Pre-flight checks.
> - Orden de ejecución.
> - Qué monitorear.
> - Estimación de tiempo.
> - Plan de rollback si algo sale mal.
> - Comandos exactos a ejecutar.
>   Commit: `docs(runbook): add initial backfill procedure`.

**Estimación**: 2 h.

---

## Fase 2 — Enriquecimiento

(Items a detallar cuando se active Fase 2. Prompts listos pero no
expandidos acá para no inflar el documento.)

- F2-001 — Webhook receiver de Teamtailor.
- F2-002 — Rejection normalizer job (ADR-007). ✅ **DONE** (2026-04-18,
  `0a4dbb9`..`1971318`; CLI 2026-04-19, `4b06e3f`).
  `src/lib/normalization/{classify,normalizer}.ts` + 24 tests.
  Operator CLI `pnpm normalize:rejections [--dry-run] [--force]
[--batch=N]` imprime samples + counts; dry-run skippea writes.
- F2-003 — Tags automáticos desde CV.
- F2-004 — Panel admin para sync errors y needs_review. ✅ **DONE**
  (2026-04-18 `5e1450f`..`9ac52cb` para sync_errors; 2026-04-19
  `c0479b5` para needs_review). Parte `sync_errors`:
  `src/lib/sync-errors/service.ts` + `/admin/sync-errors` (filtros +
  paginación + resolve action) + 8 integration tests. Parte
  `needs_review`: `src/lib/needs-review/service.ts` +
  `/admin/needs-review` (categoría picker + dismiss, rechaza
  categorías deprecated o rows ya clearadas) + 8 integration tests.
- F2-005 — Observabilidad (logs agregados + métricas Supabase).

## Fase 3 — Semántica

- F3-001 — Embeddings worker (ADR-005). ✅ **DONE — 4 sources**
  (2026-04-18 `adae0c2`..`83996a7` para profile+notes+cv;
  2026-04-19 `f307b3a` para evaluation). Provider abstraction
  (`EmbeddingProvider` + OpenAI impl + stub determinístico), helper
  de hash (SHA-256 con model como sal), source builders `profile`,
  `notes`, `cv` (más reciente parsed, trunca a 30k chars) y
  `evaluation` (agrega `evaluations` + `evaluation_answers` por
  candidate), workers `runProfileEmbeddings`, `runNotesEmbeddings`,
  `runCvEmbeddings` y `runEvaluationEmbeddings` (idempotentes vía
  content_hash). CLIs `pnpm embed:{profiles,notes,cv,evaluations}`
  y `pnpm embed:all` (orden: profile → notes → cv → evaluation).
  46 tests nuevos en total.
- F3-002 — Query de búsqueda con embeddings. ✅ **DONE**
  (2026-04-18 `26c8e53`..`9461dc4` para servicio + API; 2026-04-19
  `8d47297` para UI). Migración RPC `semantic_search_embeddings`
  (cosine similarity, RLS vía `security invoker`), servicio
  `semanticSearchCandidates`, endpoint `POST /api/search/semantic`,
  UI server-rendered en `/search/semantic` con score badges +
  source badges + hydration RLS-scoped.
- F3-003 — Búsqueda híbrida (structured + vector). ✅ **DONE**
  (2026-04-18 `1f14e69`..`a98b743` para servicio + API; 2026-04-19
  `8d47297` para UI). RPC extendida con `candidate_id_filter
uuid[]`. Servicio `hybridSearchCandidates` con 3 modos: `hybrid`,
  `structured`, `empty`. Endpoint `POST /api/search/hybrid` con
  provider lazy. UI server-rendered en `/search/hybrid` con
  filtros (status, rejected dates, job) + query opcional, muestra
  modo efectivo. Sidebar incluye entry "Search".
- F3-004 — OCR opt-in para CVs escaneados.

## Fase 4 — Inteligencia

> **Eje principal F4**: matching por descomposición de llamado (UC-11).
> Gobernado por ADRs 012 (extracción CVs), 013 (catálogo skills),
> 014 (decomposition LLM), 015 (matching & ranking), 016 (señales
> complementarias FTS/vector). Sliced en F4-001..F4-009 abajo, con
> F4-007 bis y F4-008 bis agregadas al aceptar ADR-016. Los
> ex-items F4-010/F4-011 (RAG, insights) quedan como trabajo de Fase
> 4 fuera del eje matching.

### F4-001 — Schema + RLS de tablas F4

**Depende de**: F1-003 (para patrón RLS), ADRs 012-015 Accepted.

**Prompt**:

> Creá las migraciones para las 9 tablas de `data-model.md` §16:
> `skills`, `skill_aliases`, `skills_blacklist`,
> `candidate_extractions`, `candidate_experiences`,
> `experience_skills`, `job_queries`, `match_runs`, `match_results`.
> Una migración por grupo lógico:
>
> - `0XX_skills_catalog.sql` (skills + aliases + blacklist +
>   `resolve_skill()` helper SQL).
> - `0XX_candidate_extractions.sql` (extractions + experiences +
>   experience_skills).
> - `0XX_job_queries.sql`.
> - `0XX_match_runs.sql` (runs + results).
>   RLS policies en archivos separados `0XX_rls_<tabla>.sql`
>   siguiendo ADR-003. Invariantes: `decomposed_json`,
>   `breakdown_json`, `raw_output` inmutables post-insert (trigger o
>   policy). Regenerá tipos con `supabase gen types typescript`.
>   Tests RLS mínimos: `test_job_queries_rls_denies_cross_tenant`,
>   `test_match_results_rls_denies_cross_tenant`,
>   `test_decomposed_json_update_is_rejected`,
>   `test_breakdown_json_update_is_rejected`.
>   TDD: `test(db): [RED] ...` por cada test, luego
>   `feat(db): [GREEN] ...` por migración.

**DoD**:

- Migraciones aplican idempotentemente.
- Tipos TS generados incluyen las 9 tablas.
- Tests RLS verdes.
- Equivalencia `resolve_skill()` SQL ↔ `resolveSkill()` TS:
  al menos 1 test propiedad-based comparando 20 inputs.

**Estimación**: 10 h.

---

### F4-002 — Skills catalog seed + resolver

**Depende de**: F4-001.

**Prompt**:

> Implementá ADR-013 §2 y §4:
>
> - `src/lib/skills/resolver.ts` con `resolveSkill(raw): Promise<{ skill_id: string | null }>`.
>   Pipeline: lowercase → trim → strip terminal punct → preserve
>   internal punct (`c++`, `c#`, `node.js`) → slug match → alias
>   match → null. Blacklist check pre-resolución.
> - Seed curado ~50-80 skills en `src/lib/skills/seed.ts` + migración
>   `0XX_skills_seed.sql` que aplica el insert.
> - CLI `pnpm skills:reconcile` que re-ejecuta el resolver sobre
>   `experience_skills WHERE skill_id IS NULL` y puebla `skill_id`.
> - `tests/skills/resolver.test.ts` con 15+ tests incluyendo
>   punctuation preservation, empty input, whitespace-only, aliases,
>   blacklist hits.
> - Test de equivalencia TS↔SQL que compara 30 inputs random.

**DoD**:

- Cobertura ≥ 95% en `src/lib/skills/`.
- `skills:reconcile` es idempotente (dos runs consecutivos → 0
  updates en el segundo).
- Test de equivalencia verde.

**Estimación**: 8 h.

---

### F4-003 — CV variant classifier

**Depende de**: F1-008 (CV parser produce `parsed_text`).

**Prompt**:

> Implementá ADR-012 §1:
>
> - `src/lib/cv/variant-classifier.ts` con `classifyVariant(parsedText): 'linkedin_export' | 'cv_primary'`.
>   Determinístico: busca señales textuales típicas de LinkedIn
>   export ("linkedin.com/in/", headers "Contact", "Experience",
>   "Education" en orden, patrones de fecha MM/YYYY - Present).
> - Tests adversariales: CV con link a LinkedIn pero formato CV
>   normal → `cv_primary`. LinkedIn export sin URL pero con todos
>   los headers → `linkedin_export`. Texto vacío → fallback
>   `cv_primary`.
> - Sin LLM: si la señal es ambigua, default `cv_primary` (más
>   seguro para scoring, ADR-012 §7).

**DoD**:

- Cobertura ≥ 95% en `src/lib/cv/variant-classifier.ts`.
- Fixtures reales (5 de cada tipo) en `tests/fixtures/cv-variants/`,
  anonimizadas.

**Estimación**: 4 h.

---

### F4-004 — ExtractionProvider + persistencia

**Depende de**: F4-001, F4-003.

**Prompt**:

> Implementá ADR-012 §3-§6:
>
> - `src/lib/cv/extraction/provider.ts` con interface
>   `ExtractionProvider` + implementación `OpenAiExtractionProvider`
>   usando `gpt-4o-mini` + `response_format: { type: 'json_schema' }`
>   - prompt versionado `EXTRACTION_PROMPT_V1 = '2026-04-v1'`.
> - Stub determinístico `StubExtractionProvider` para tests (no
>   hace calls, devuelve fixture).
> - Worker `runCvExtractions()` en `src/lib/cv/extraction/worker.ts`:
>   lee `files` con `parsed_text IS NOT NULL` + sin
>   `candidate_extractions` para ese `content_hash`, clasifica
>   variant, llama provider, persiste en `candidate_extractions`.
> - CLI `pnpm extract:cvs [--batch=N]`.
> - Idempotencia: `content_hash` unique impide duplicados.
> - Errores de provider → `sync_errors` con
>   `entity='cv_extraction'`.
> - Tests: `test_extraction_is_idempotent_by_content_hash`,
>   `test_provider_failure_logs_to_sync_errors`,
>   `test_prompt_version_bump_creates_new_row`.

**DoD**:

- 10+ tests cubriendo happy path + errores + idempotencia.
- Dry-run local contra 5 fixtures variados (CVs cortos, largos,
  con tablas, scans fallidos).
- Zero-retention confirmado con OpenAI antes de mergear (ver
  `docs/status.md` §Deuda de seguridad).

**Estimación**: 12 h.

---

### F4-005 — Derivación de experiences + experience_skills

**Depende de**: F4-002, F4-004.

**Prompt**:

> Implementá ADR-012 §4 + ADR-013 §3:
>
> - Servicio `deriveExperiences(extraction_id)`:
>   lee `candidate_extractions.raw_output` → inserta filas en
>   `candidate_experiences` (una por experience del raw_output) →
>   por cada skill mencionada, inserta en `experience_skills` con
>   `skill_id = await resolveSkill(skill_raw)`.
> - Invocado automáticamente al final del worker de F4-004.
> - Idempotente: si ya existen rows para ese `extraction_id`, skip.
> - Tests: `test_derivation_from_raw_output`,
>   `test_unresolved_skills_stored_with_null_skill_id`,
>   `test_derivation_is_idempotent`.

**DoD**:

- Integration test end-to-end: file parseado → extraído → derivado
  → contable en SQL (`SELECT COUNT(*) FROM experience_skills WHERE
experience_id = ...`).
- `/admin/skills/uncataloged` (F4-009) puede listar las skills null.

**Estimación**: 8 h.

---

### F4-006 — DecompositionProvider + job_queries

**Depende de**: F4-002.

**Prompt**:

> Implementá ADR-014:
>
> - `src/lib/matching/decomposition/provider.ts` con interface
>   `DecompositionProvider` + `OpenAiDecompositionProvider`
>   (`gpt-4o-mini`, `DECOMPOSITION_PROMPT_V1 = '2026-04-v1'`).
> - Stub determinístico para tests.
> - Servicio `decomposeJobQuery(raw_text, user)`:
>   1. preprocess → normalized_text
>   2. `content_hash = SHA256(normalized_text || NUL || prompt_version)`
>   3. lookup en `job_queries.content_hash`:
>      - hit: re-resolve skills contra catálogo actual, update
>        `resolved_json` + `unresolved_skills`, return.
>      - miss: call provider, persist `decomposed_json` +
>        `resolved_json`.
>   4. return `JobQueryResult { id, resolved, unresolved_skills }`.
> - Server action `/api/matching/decompose` con auth.
> - Tests 10+ incluyendo cache hit, cache miss, empty input,
>   schema_violation, provider_failure, unresolved_skills
>   triggering actionable error.

**DoD**:

- Cache hit no invoca provider (mock assertion).
- `decomposed_json` inmutable verificado (intent de UPDATE lanza
  policy error).

**Estimación**: 10 h.

---

### F4-007 — Variant merger + years calculator + ranker

**Depende de**: F4-005, F4-006.

**Prompt**:

> Implementá ADR-015 §§1-3, §7:
>
> - `src/lib/matching/variant-merger.ts`: `mergeVariants(experiences): CandidateExperience[]`
>   con heurística company + title norm + date overlap > 50%.
>   Diagnostics en return para debugging.
> - `src/lib/matching/years-calculator.ts`:
>   `yearsForSkill(skill_id, experiences): number` con sweep-line.
>   Solo `kind='work'`. Excluye `skill_id IS NULL`.
> - `src/lib/matching/score-aggregator.ts`: aplica weights
>   must_have=2.0 / nice_to_have=1.0, language bonus ±5/-10,
>   seniority ±5, normaliza a [0, 100].
> - `src/lib/matching/ranker.ts`: `DeterministicRanker` que orquesta.
> - Un archivo ≤ 300 LOC, funciones ≤ 50 LOC.
> - 21 tests de ADR-015 §Tests requeridos.

**DoD**:

- Los 21 tests verdes.
- Test de idempotencia: mismo input → mismo output bit-a-bit.
- Cobertura ≥ 95% en `src/lib/matching/`.

**Estimación**: 16 h.

---

### F4-007 bis — `candidate_experiences.description_tsv` (ADR-016 §3)

**Depende de**: F4-001 sub-block 2 (candidate_experiences).

**Prompt**:

> Migración aditiva que agrega columna `description_tsv` a
> `candidate_experiences`:
>
> ```sql
> alter table candidate_experiences
>   add column description_tsv tsvector generated always as
>     (to_tsvector('simple', coalesce(description, ''))) stored;
> create index idx_candidate_experiences_description_tsv
>   on candidate_experiences using gin (description_tsv);
> ```
>
> Regenerar types. No requiere cambios en el worker de extracción
> (la columna es stored-generated).

**DoD**:

- Test que inserta una experience con `description = 'Led a team
using React and Node.js'` y verifica que
  `description_tsv @@ plainto_tsquery('simple', 'react')`.
- `supabase gen types` refleja la nueva columna.

**Estimación**: 3 h.

---

### F4-008 — API routes + persist match runs

**Depende de**: F4-007.

**Prompt**:

> Expón el matching via API:
>
> - `POST /api/matching/run` — body: `{ job_query_id, filters }`.
>   Crea `match_runs` row status='running', ejecuta pre-filter
>   bitmap por must-have skill presence, carga candidatos,
>   corre `DeterministicRanker`, persiste `match_results`, cierra
>   run con status='completed' + `finished_at`.
> - `GET /api/matching/runs/:id` — metadata del run.
> - `GET /api/matching/runs/:id/results?offset=&limit=` —
>   paginado con breakdown.
> - `POST /api/matching/decompose` ya existe de F4-006.
> - Middleware `requireAuth()` + tenant check.
> - Logging estructurado: run_id, candidates_evaluated, duration_ms.

**DoD**:

- Integration test end-to-end: JD pegado → decompose → run →
  top-10 esperado contra fixture de 20 candidates.
- Performance: 100 candidatos < 3s p50 en local.

**Estimación**: 10 h.

---

### F4-008 bis — `match_rescues` + complementary-signals module (ADR-016 §1)

**Depende de**: F4-008, F4-007 bis.

**Prompt**:

> Implementá el recall-fallback de ADR-016:
>
> - Migración `match_rescues` con shape de ADR-016 §Notas:
>
>   ```sql
>   create table match_rescues (
>     match_run_id   uuid not null references match_runs(id) on delete cascade,
>     candidate_id   uuid not null references candidates(id) on delete cascade,
>     tenant_id      uuid,
>     missing_skills text[] not null,
>     fts_snippets   jsonb not null,
>     fts_max_rank   numeric(6, 4) not null,
>     primary key (match_run_id, candidate_id)
>   );
>   ```
>
>   - RLS paralela a `match_results` (recruiter R propios, admin R/W).
>
> - `src/lib/rag/complementary-signals.ts`:
>   - `FTS_RESCUE_THRESHOLD = 0.1`
>   - `fetchFtsRescues(jobQueryId, runId, gateFailedCandidates)`:
>     por cada candidato gate-failed, ejecuta `plainto_tsquery` sobre
>     `files.parsed_text` con los slugs `must_have` ausentes. Si algún
>     skill supera `FTS_RESCUE_THRESHOLD`, escribe fila en
>     `match_rescues`.
>   - `fetchEvidenceSnippets(candidateId, requirementSlugs)`: lectura
>     ad-hoc para el evidence panel, usa `hybrid_search_fn` existente.
>     Retorna top-`EVIDENCE_SNIPPET_LIMIT` por slug. NO persiste.
> - El ranker de F4-008 invoca `fetchFtsRescues()` tras cerrar el run
>   oficial. `match_results` y `rank` no cambian.
> - Endpoint: `GET /api/matching/runs/:id/rescues` (paginado).

**DoD**:

- Test: JD con `must_have = ['react']` + candidato sin `react` en
  `experience_skills` pero con `React` mencionado 3 veces en CV →
  aparece en `match_rescues`, NO en `match_results`.
- Test: mismo candidato con `react` estructurado → NO aparece en
  rescues (ya pasó el gate).
- Evidence panel snippet devuelve el término con highlight.

**Estimación**: 4 h.

---

### F4-009 — UI: pegar JD, resultados, admin

**Depende de**: F4-008, F4-008 bis.

**Prompt**:

> UI según UC-11 acceptance criteria:
>
> - `/matching/new`: textarea para pegar JD + botón "Decomponer".
>   Muestra `DecompositionResult` parseado + skills unresolved
>   accionables (link a `/admin/skills`).
> - `/matching/runs/:id`: ranking con breakdown expandible por
>   candidato, sección aparte "No cumplen must-have". Al expandir
>   un candidato, **evidence panel** (ADR-016 §2): snippets de
>   `fetchEvidenceSnippets()` con highlight del término, agrupados
>   por skill del requirement.
> - `/matching/runs/:id/rescues`: tabla separada del recall-fallback
>   con `missing_skills`, `fts_snippets` y acción "revisar
>   manualmente" (link al detalle del candidato con el panel ya
>   abierto en los skills rescatados).
> - `/admin/skills`: CRUD de skills + aliases (admin-only).
> - `/admin/skills/uncataloged`: lista `experience_skills WHERE
skill_id IS NULL` agrupadas por skill_raw + count + acción
>   "Agregar al catálogo" → crea `skill` + corre
>   `skills:reconcile` incremental.
> - `/admin/job-queries`: monitoring de LLM calls + cost tracking
>   (opcional F4-009).
> - Style según `ui-style-guide.md`.

**DoD**:

- Smoke E2E UC-11 completo (Cypress o Playwright).
- UX: recruiter puede pegar JD, ver ranking, expandir breakdown,
  agregar skill uncataloged al catálogo, re-ejecutar run — todo
  sin salir de la app.
- Evidence panel visible para al menos un candidato del smoke test
  (valida que `fetchEvidenceSnippets()` está integrado).

**Estimación**: 20 h (16 base + 4 evidence panel por ADR-016).

---

### Items Fase 4 fuera del eje matching

- F4-010 — RAG sobre historial del candidate.
- F4-011 — Insights dashboard (rejection trends, bottlenecks).
- F4-012 — Scoring y matching candidate ↔ job legacy — **🗑️ DROPPED**:
  superseded por F4-001..F4-009 (matching por descomposición es
  una implementación rigurosa del mismo goal).

---

## Convenciones de actualización

- Al completar un item, actualizar status `⏳` → `✅` con fecha y
  commit hash.
- Al agregar un item nuevo, reservar ID consecutivo por fase.
- Items retirados se marcan `🗑️ DROPPED` con razón. No se borran.
- Cada item ejecutado debe dejar traza en `docs/status.md`.
