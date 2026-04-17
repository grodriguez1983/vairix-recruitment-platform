# CLAUDE.md — Recruitment Data Platform

> **Sentinel de arquitectura.** Este archivo es lo primero que Claude Code
> lee en cada sesión. Contiene las reglas inviolables del sistema.
> Cualquier generación que viole estas reglas es inválida por
> construcción, no por preferencia.
>
> **Fuente canónica del producto**: `docs/spec.md` (en Project Knowledge).
> Si algo acá contradice a spec.md, ganá spec.md y levantá un ADR.

---

## 🎯 Project Identity

- **Nombre**: Recruitment Data Platform
- **Owner**: VAIRIX (herramienta **interna**, 5–15 usuarios)
- **Primary Language**: TypeScript 5.x estricto
- **Framework**: Next.js 14+ (App Router)
- **Data Layer**: Supabase (Postgres + pgvector + Storage + Auth)
- **Domain**: Talent Intelligence sobre data de Teamtailor (ATS)
- **Sensitive Data**: ⚠️ PII de candidatos (nombre, email, teléfono,
  LinkedIn, CV). No hay compliance formal (GDPR/SOC2) pero la
  confidencialidad es obligatoria de facto.

---

## 📏 Las 7 propiedades que gobiernan este repo

Toda decisión técnica debe pasar el chequeo de las 7 propiedades de
Generative Specification. En orden de aplicación:

1. **Self-describing** — los artefactos se explican solos; sin memoria
   humana implícita.
2. **Bounded** — archivos ≤ 300 líneas, funciones ≤ 50, un archivo = un
   concern.
3. **Verifiable** — typecheck + lint + tests son condición de
   "completado". Nunca "escribí el archivo" = "está bien".
4. **Defended** — operaciones destructivas estructuralmente bloqueadas
   (ver `docs/operation-classification.md`).
5. **Auditable** — conventional commits + ADRs para toda decisión no
   trivial + `docs/status.md` por sesión.
6. **Composable** — clean architecture, dependencias siempre hacia
   abajo, interfaces explícitas en los seams.
7. **Executable** — pasa los tests contra runtime real (Supabase
   local o Teamtailor fixtures), no solo compila.

---

## 🏛️ Architecture Rules (inviolables)

### Capas (dependencias solo hacia abajo)

```
┌──────────────────────────────────────────────┐
│  UI (Next.js App Router pages & components)  │  ← thin, validación + delegación
├──────────────────────────────────────────────┤
│  API Routes / Server Actions                 │  ← auth + input validation + call services
├──────────────────────────────────────────────┤
│  Services (business logic)                   │  ← orquesta, depende SOLO de interfaces
├──────────────────────────────────────────────┤
│  Domain models + Types                       │  ← puro, sin I/O, sin framework
├──────────────────────────────────────────────┤
│  Repositories / Adapters                     │  ← DB, Storage, Teamtailor, OpenAI
└──────────────────────────────────────────────┘
```

**Regla**: una capa nunca importa desde una capa superior. El ETL es
infraestructura, nunca importa de `app/`. La UI nunca importa de
`lib/teamtailor` directo; pasa por un service.

### Multi-tenant hedge (ADR-003)

- Toda tabla de dominio tiene columna `tenant_id uuid` **nullable**.
- En Fase 1 queda en `null` o en un UUID fijo por env.
- Toda query de servicio DEBE aceptar `tenant_id` como parámetro
  (aunque en Fase 1 no filtre). Esto evita un refactor masivo en
  Fase 2.

### Auth y RLS (ADR-003)

- **RLS activa en todas las tablas de dominio**. No se deshabilita.
- Cliente Supabase en backend con JWT del usuario → RLS aplica.
- Cliente Supabase con **service role key** SOLO en ETL y worker de
  embeddings. Nunca se expone al cliente ni en routes disparadas por
  usuario.
- Toda API route empieza con `requireAuth()` y validación de rol.

### Separación de capas del dato (ADR-005, ADR-006)

- El **ETL** hace upsert de data estructurada. No genera embeddings.
  No parsea CVs.
- El **worker de embeddings** corre post-ETL, lee `content_hash`,
  regenera solo lo cambiado.
- El **CV parser** corre post-upload a Storage, idempotente por
  `files.content_hash`.
- **Prohibido** mezclar estas responsabilidades.

---

## 📦 Module Hierarchy

```
src/
├── app/                      # Next.js routes — thin
├── lib/
│   ├── teamtailor/           # cliente + tipos + rate limiter
│   ├── db/                   # queries tipadas (usa tipos generados)
│   ├── embeddings/           # provider abstraction + worker
│   ├── cv/                   # parsers (pdf, docx, ...)
│   ├── rag/                  # retrieval + LLM orchestration
│   ├── auth/                 # requireAuth, requireRole
│   ├── normalization/        # rejection-rules.ts (ADR-007)
│   └── shared/               # utils cross-dominio (logger, errors, hash)
├── scripts/                  # CLIs: sync, backfill, reindex
├── types/                    # tipos globales, nunca `any`
└── app/api/                  # endpoints
```

**Regla**: no imports laterales entre dominios (`teamtailor` no
importa de `rag`). Si dos dominios necesitan algo en común, va a
`lib/shared`.

---

## 🔥 Error Handling

- **Jerarquía de errores custom por dominio**. No `throw new Error(...)`
  pelado. Usar `TeamtailorError`, `SyncError`, `EmbeddingError`, etc.
- Errores cargan contexto: `teamtailor_id`, `candidate_id`,
  `operation`, `timestamp`.
- **Fail fast, fail loud**. No atrapar para loggear y seguir.
  Excepción única: ETL de un registro puntual en loop → loggear en
  `sync_errors`, continuar.
- En ETL no existe "error silencioso". Todo error actualiza
  `sync_state.last_run_status` o `sync_errors`.

---

## 🎨 Code Standards

- **TypeScript estricto**: `"strict": true`, `noImplicitAny`,
  `noUncheckedIndexedAccess`. **Jamás `any`**, usar `unknown` +
  narrowing.
- **Tipos retorno explícitos** en funciones exportadas.
- Longitud máxima por archivo: **300 líneas**. Por función:
  **50 líneas**. Si excedés, extraé.
- Naming:
  - Archivos: `kebab-case.ts`
  - Componentes y tipos: `PascalCase`
  - Variables, funciones: `camelCase`
  - Constantes reales: `SCREAMING_SNAKE_CASE`
  - Tablas y columnas SQL: `snake_case`
- **Sin abreviaciones** salvo universalmente conocidas (`id`, `url`,
  `http`, `db`, `api`).
- Imports absolutos con alias `@/` apuntando a `src/`.
- **Naming bilingüe**: entidades de dominio (candidate, application,
  evaluation, job, stage) en inglés en código y schema. Labels de UI
  y docs de producto en español.

---

## 🧪 Testing Protocol (ver docs/test-architecture.md)

- **TDD obligatorio** para lógica no trivial (parsers, normalización,
  ETL transformations, RLS policies).
- Flujo: **RED → GREEN → REFACTOR**, con commits separados:
  - `test(scope): [RED] <desc>` ← test que falla
  - `feat(scope): [GREEN] <desc>` ← implementación mínima que pasa
  - `refactor(scope): <desc>` ← limpieza
- El CI **rechaza** un `feat:` que no tenga un `test: [RED]` previo
  tocando el mismo scope (hook en `.claude/hooks/`).
- **Cobertura mínima**: 80% global, 90% en `src/lib/`, 95% en
  `src/lib/auth/` y policies RLS.
- Tests **adversariales** (§4.3 Verifiable): buscan romper, no
  documentar. Naming: `test_rejects_<cosa_mala>`,
  `test_denies_cross_tenant_access`, no `test_basic_flow`.
- Tests contra **interfaces**, nunca contra implementación interna.

---

## 📝 Commit Protocol

Conventional Commits estricto:

```
<type>(<scope>): <subject>

<body opcional>

<footer opcional — BREAKING CHANGE, refs, ADR-N>
```

- `type` ∈ `feat | fix | refactor | docs | test | chore | perf | build | ci`
- `scope` ∈ `etl | db | ui | rag | embeddings | teamtailor | sync | auth | cv | rls | infra`
- Prefijos especiales para TDD: `test(scope): [RED] ...`,
  `feat(scope): [GREEN] ...`
- **Atomicidad**: un commit = un cambio lógico. Nada de "WIP",
  "fixes", "asdf".
- Cada commit debe pasar typecheck + lint + tests. El pre-commit
  hook lo valida.

---

## 🚫 Operaciones prohibidas sin autorización explícita

**Requieren confirmación humana** (ver `docs/operation-classification.md`):

- `DROP TABLE`, `TRUNCATE`, `DELETE` sin `WHERE` estricto.
- Cambios a `public.auth.users` (tabla de Supabase Auth).
- Deshabilitar RLS en cualquier tabla, aunque sea "por un rato".
- Hard delete (no soft) de candidates, applications, evaluations.
- Ejecutar el ETL en modo `--full-resync` (backfill).
- Borrado masivo de archivos en bucket `candidate-cvs`.
- Push a `main`. **Siempre vía PR**.
- Agregar deps > 100kb.
- Cambiar el stack (Next.js, Supabase, pgvector) — requiere ADR.

---

## 📚 Lectura obligatoria por tarea

Antes de editar código, Claude Code lee (como mínimo):

| Toca...               | Lee...                                                              |
| --------------------- | ------------------------------------------------------------------- |
| Schema DB / migración | `docs/spec.md` §4, `data-model.md`, ADR relevante                   |
| Teamtailor API        | `teamtailor-api-notes.md`, ADR-004                                  |
| ETL                   | `spec.md` §5, ADR-002, ADR-004, `docs/runbooks/initial-backfill.md` |
| Embeddings            | ADR-005, `.claude/skills/embeddings-pipeline/SKILL.md`              |
| CV parsing            | ADR-006, `.claude/skills/cv-parsing/SKILL.md`                       |
| UI                    | `ui-style-guide.md`, `.claude/skills/ui-components/SKILL.md`        |
| RLS                   | ADR-003, `.claude/skills/rls-policies/SKILL.md`                     |
| Cualquier test        | `docs/test-architecture.md`                                         |

---

## 🔄 Session loop invariant (gate de cierre)

Antes de considerar una sesión "cerrada", Claude Code debe:

1. ✅ `pnpm typecheck` limpio
2. ✅ `pnpm lint` limpio
3. ✅ `pnpm test` verde
4. ✅ Si hubo migración: `supabase db diff` aplicado + tipos
   regenerados
5. ✅ Si hubo decisión estructural: ADR creado en `docs/adr/`
6. ✅ `docs/status.md` actualizado con lo hecho y lo siguiente
7. ✅ Commits en Conventional Commits, atómicos
8. ✅ No quedó código muerto, imports sin usar, `console.log`

Si algo de esto no pasa: la sesión no cerró. Documentar en
`status.md` qué quedó abierto.

---

## 🔗 Referencia cruzada

- Producto: `docs/spec.md`
- Schema: `docs/data-model.md`
- Glosario: `docs/domain-glossary.md`
- API externa: `docs/teamtailor-api-notes.md`
- UI: `docs/ui-style-guide.md`
- ADRs: `docs/adr/`
- Arquitectura: `docs/architecture.md`
- Use cases: `docs/use-cases.md`
- Roadmap ejecutable: `docs/roadmap.md`
- Operaciones críticas: `docs/operation-classification.md`
- Test architecture: `docs/test-architecture.md`
