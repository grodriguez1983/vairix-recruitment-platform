# 📍 Status — Recruitment Data Platform

> Actualizado al final de **cada sesión** de Claude Code. Snapshot
> del estado; no es un registro histórico completo (para eso está
> el git log).

**Última actualización**: 2026-04-17
**Última sesión**: 2026-04-17 — F1-001 bootstrap + F1-002 primera migración
**Fase activa**: **Fase 1 — Fundación**

---

## ✅ Completado

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

1. **F1-003** — Schema de dominio + RLS base (13 migraciones + tests RLS).
2. **F1-004** — Cliente Teamtailor con rate limit.
3. **F1-005** — Primer syncer (stages + users).

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
- [ ] `pnpm test` — sin tests aún (vitest `passWithNoTests`)
- [ ] Coverage global ≥ 80% — _(sin código de dominio aún)_

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
