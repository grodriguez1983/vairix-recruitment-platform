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

### F1-001 — Bootstrap del repo ⏳ TODO

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

### F1-002 — Supabase local + primera migración ⏳ TODO

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

### F1-003 — Schema de dominio + RLS base ⏳ TODO

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

### F1-004 — Cliente Teamtailor con rate limit ⏳ TODO

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

### F1-005 — Skeleton de ETL con sync_state ⏳ TODO

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

### F1-006 — Syncers por entidad (users, jobs, candidates, applications, evaluations, notes) ⏳ TODO

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

### F1-007 — CV download + Storage upload ⏳ TODO

**Depende de**: F1-006.

**Prompt**:

> Implementá `src/lib/cv/downloader.ts` que:
>
> - Toma un `file` entity de Teamtailor, descarga el binario con
>   la URL presignada (que expira) dentro de su ventana.
> - Calcula SHA-256 del binario.
> - Si el hash matchea `files.content_hash` persistido, skip.
> - Si no, sube a Supabase Storage en path
>   `<candidate_uuid>/<file_uuid>.<ext>`, persiste metadata en
>   `files` (incluyendo `content_hash`).
> - Rechaza archivos > 10 MB con log warning.
>   Tests integration con Storage local + MSW.
>   Commit: `feat(cv): add downloader and storage upload`.

**DoD**:

- Tests de UC-07 acceptance criteria verdes.
- Un archivo re-descargado sin cambios NO se re-sube.

**Estimación**: 6 h.

---

### F1-008 — CV parser (pdf-parse, mammoth) ⏳ TODO

**Depende de**: F1-007.

**Prompt**:

> Implementá `src/lib/cv/parser.ts` que:
>
> - Recibe un `file` recién subido.
> - Descarga desde Storage (service role).
> - Elige parser según `file_type`: `pdf-parse` para pdf,
>   `mammoth` para docx, `fs.readFile` para txt.
> - Persiste `files.parsed_text`, setea `parsed_at`.
> - En caso de error, setea `parse_error` con código:
>   `unsupported_format`, `parse_failure`, `empty_text`,
>   `likely_scanned` (si PDF y texto útil < 200 chars).
>   Tests: parseo de CV válido, scanned PDF detectado, DOCX parsea.
>   Commit: `feat(cv): add parser with pdf, docx, txt support`.

**DoD**:

- Tests de UC-07 pasan.
- CVs escaneados marcados correctamente.

**Estimación**: 6 h.

---

### F1-009 — Auth + layout UI base ⏳ TODO

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

### F1-010 — Búsqueda estructurada ⏳ TODO

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

### F1-011 — Perfil consolidado del candidate ⏳ TODO

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

### F1-012 — Tags manuales ⏳ TODO

**Depende de**: F1-011.

**Prompt**:

> Implementá CRUD de tags + `candidate_tags`. UI: chips editables
> inline en perfil, autocomplete de tags existentes.
> Tests: tag duplicado rechazado, solo creator o admin puede borrar.
> Commit: `feat(ui): add manual tag management`.

**Estimación**: 6 h.

---

### F1-013 — Shortlists ⏳ TODO

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

### F1-014 — Hooks + CI pipeline ⏳ TODO

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

### F1-015 — Runbook del backfill inicial ⏳ TODO

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
- F2-002 — Rejection normalizer job (ADR-007).
- F2-003 — Tags automáticos desde CV.
- F2-004 — Panel admin para sync errors y needs_review.
- F2-005 — Observabilidad (logs agregados + métricas Supabase).

## Fase 3 — Semántica

- F3-001 — Embeddings worker (ADR-005).
- F3-002 — Query de búsqueda con embeddings.
- F3-003 — Búsqueda híbrida (structured + vector).
- F3-004 — OCR opt-in para CVs escaneados.

## Fase 4 — Inteligencia

- F4-001 — RAG sobre historial del candidate.
- F4-002 — Insights dashboard (rejection trends, bottlenecks).
- F4-003 — Scoring y matching candidate ↔ job.

---

## Convenciones de actualización

- Al completar un item, actualizar status `⏳` → `✅` con fecha y
  commit hash.
- Al agregar un item nuevo, reservar ID consecutivo por fase.
- Items retirados se marcan `🗑️ DROPPED` con razón. No se borran.
- Cada item ejecutado debe dejar traza en `docs/status.md`.
