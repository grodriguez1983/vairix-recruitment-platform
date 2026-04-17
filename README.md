# Recruitment Data Platform

> Plataforma interna de VAIRIX para transformar la base de CVs de
> Teamtailor en un **motor de decisiones de hiring basado en datos**.
>
> Este repo está construido siguiendo la metodología **Generative
> Specification** ([whitepaper](https://pragmaworks.dev)): toda
> decisión está documentada en artefactos derivables por un agente
> stateless, sin necesidad de memoria institucional humana.

---

## 🚀 Setup

### 1. Clonar y bootstrap

```bash
git clone <repo>
cd recruitment-platform

# Instalar Node 20 (si usás nvm)
nvm use

# Validar tooling y copiar .env.local
bash scripts/bootstrap.sh
```

### 2. Editar `.env.local`

Completá con credenciales reales. Ver `.env.example` para la
descripción de cada variable.

### 3. Instalar y arrancar

```bash
pnpm install
supabase start
pnpm dev
```

### 4. Aplicar migraciones + tipos

```bash
supabase db reset   # aplica todo desde cero (solo local)
pnpm supabase:types  # regenera src/types/database.ts
```

### 5. Correr tests

```bash
pnpm test:unit          # rápido, sin DB
pnpm test:integration   # requiere supabase local
pnpm test:rls           # policies RLS
pnpm test:e2e:smoke     # smoke E2E
```

---

## 📚 Estructura de la documentación

Todo lo que un humano o un agente necesita para entender y
extender el sistema vive acá:

| Archivo | Propósito |
|---|---|
| `CLAUDE.md` | **Sentinel** — reglas inviolables, primero que lee cualquier agente. |
| `docs/spec.md` | Spec funcional canónica del producto. |
| `docs/architecture.md` | C4 + container diagrams, flujos principales. |
| `docs/data-model.md` | Schema completo con índices, triggers, RLS. |
| `docs/domain-glossary.md` | Glosario; usar estos términos consistentemente. |
| `docs/use-cases.md` | UCs con sequence + state diagrams. Contratos de comportamiento. |
| `docs/test-architecture.md` | Estrategia de tests (pirámide, adversariales, coverage, mutation). |
| `docs/operation-classification.md` | Tiers de operaciones por reversibilidad. **Leer antes de ejecutar algo destructivo.** |
| `docs/roadmap.md` | Plan ejecutable con prompt pre-generado por item. |
| `docs/status.md` | Estado actual — actualizar al final de cada sesión. |
| `docs/teamtailor-api-notes.md` | Integración con Teamtailor. |
| `docs/ui-style-guide.md` | Kit de marca VAIRIX aplicado al producto. |
| `docs/adr/` | Architecture Decision Records. |
| `docs/runbooks/` | Procedimientos operativos (backfill, rollback, etc.). |

### ADRs

| ADR | Tema |
|---|---|
| ADR-001 | Supabase + pgvector |
| ADR-002 | Estrategia de sync (incremental por `updated_at`) |
| ADR-003 | Auth, roles y RLS |
| ADR-004 | Orquestación del ETL (runtime híbrido) |
| ADR-005 | Pipeline de embeddings |
| ADR-006 | Storage y parsing de CVs |
| ADR-007 | Normalización de rejection reasons |

Nuevas decisiones → `/new-adr` (slash command).

---

## 🤖 Trabajar con Claude Code

Este repo está configurado para **Claude Code** con el ecosistema
completo:

### Comandos útiles

```
/new-adr          crear nuevo ADR desde template
/new-migration    crear migración Supabase con naming consistente
/cascade-check    correr spec-guardian y detectar drift
```

### Subagents disponibles

Claude Code puede invocarlos cuando la tarea lo requiera:

- `schema-reviewer` — revisa migraciones y cambios de schema
- `security-reviewer` — busca leaks, bypass de RLS, endpoints sin auth
- `test-hunter` — genera tests adversariales
- `spec-guardian` — detecta drift entre spec y código

### Skills disponibles

Skills por dominio cargadas selectivamente:

- `teamtailor-integration` — API, rate limits, JSON:API
- `supabase-migrations` — workflow y naming
- `etl-sync` — syncers, lock, error handling
- `embeddings-pipeline` — provider, hash, búsqueda vectorial
- `cv-parsing` — download, parsing, storage privado
- `rls-policies` — patrones y tests
- `tdd-workflow` — ciclo RED/GREEN con gates estructurales
- `ui-components` — componentes respetando kit de marca

### Hooks activos

- `pre-tool-use` — bloquea operaciones Tier 3 (DROP, TRUNCATE, force push)
- `post-edit` — valida límite de 300 líneas y uso de `any`
- `pre-commit` — typecheck + lint + tests changed
- `commit-msg` — valida Conventional Commits + TDD phase `[RED]`/`[GREEN]`
- `prompt-guard` — inyecta recordatorios del sentinel en tareas estructurales

---

## 🛡️ Convenciones no negociables

1. **TypeScript estricto**: cero `any`, tipos retorno explícitos.
2. **Archivos ≤ 300 líneas**, funciones ≤ 50. El hook `post-edit` avisa.
3. **TDD estructural**: commits `[RED]` → `[GREEN]` → opcional `refactor`.
4. **Conventional Commits** validados por hook.
5. **RLS siempre activa** en tablas de dominio. Service role key
   NUNCA en código con identidad de usuario.
6. **Operaciones destructivas**: ver `docs/operation-classification.md`.
7. **Sync incremental por `updated_at`**, nunca full en producción.
8. **Upsert por `teamtailor_id`**, siempre idempotente.
9. **Embeddings NO viven en el ETL** (ADR-005).
10. **CV en bucket privado**, signed URLs TTL 1h.

---

## 🔄 Loop de trabajo típico

### Para una feature nueva

1. Tomar item del `docs/roadmap.md` (ej: `F1-003`).
2. Copiar su prompt y dárselo a Claude Code.
3. Si es estructural: Claude propone plan antes de ejecutar.
4. Escribir test RED primero (commit `test: [RED] ...`).
5. Implementación GREEN (commit `feat: [GREEN] ...`).
6. Refactor si aplica.
7. `pnpm typecheck && pnpm lint && pnpm test` → verde.
8. `docs/status.md` actualizado.
9. PR; `security-reviewer` + `schema-reviewer` corren en revisión.
10. Merge tras aprobación humana.

### Para un bug

1. Reproducir con test que falle (commit `test: [RED] ...`).
2. Fix mínimo (commit `fix: [GREEN] ...`).
3. Validar que el test pasa y ninguno se rompió.
4. `/cascade-check` si el fix tocó algo estructural.

### Para una decisión estructural

1. `/new-adr`.
2. Completar Contexto, Decisión, Alternativas, Consecuencias.
3. Cuando se apruebe: estado `Aceptado`, PR.
4. Si invalida spec: update en mismo PR.

---

## 🧪 Testing — distribución esperada

```
         ┌──────┐
         │ E2E  │  10%  Playwright
         ├──────┤
         │ Int. │  30%  Supabase local + MSW
         ├──────┤
         │ Unit │  60%  Vitest puro
         └──────┘
```

Coverage gates: global ≥ 80%, `src/lib/` ≥ 90%, auth ≥ 95%.

**Cada UC en `use-cases.md` tiene tests nombrados**. Buscarlos
por grep para verificar existencia.

---

## 📦 Stack

- **Framework**: Next.js 14 (App Router) + TypeScript estricto
- **DB**: Supabase (Postgres + pgvector + Storage + Auth)
- **Embeddings**: OpenAI `text-embedding-3-small`
- **CV parsing**: `pdf-parse` + `mammoth`
- **Testing**: Vitest + Playwright + MSW + Stryker (mutation)
- **Runtime ETL**: Supabase Edge Functions + GitHub Actions
- **Hosting**: Vercel

Ver ADRs para justificación de cada decisión.

---

## 🆘 Quién es el responsable de qué

- **Sentinel** (`CLAUDE.md`): cambios requieren revisión + ADR.
- **Spec** (`docs/spec.md`): cambios via PR, referenciar ADR.
- **Schema** (`data-model.md` + migraciones): `schema-reviewer` antes de merge.
- **Auth/RLS**: `security-reviewer` antes de merge.
- **Operaciones Tier 2+**: confirmación humana + runbook.
- **Operaciones Tier 3**: humano ejecutándolas, no el agente.

---

## 📖 Para más contexto

- Paper de la metodología: *Generative Specification: A Pragmatic
  Programming Paradigm for the Stateless Reader* (Ghiringhelli, 2026).
- Kit de marca VAIRIX: `docs/brand/` (pendiente de subir).
- `docs/README.md`: estado de decisiones y backlog de ADRs.

---

## ⚠️ Notas al operador

Los hooks de shell (`.claude/hooks/*.sh`, `scripts/bootstrap.sh`,
`.husky/*`) necesitan ser ejecutables tras clonar:

```bash
chmod +x .claude/hooks/*.sh scripts/*.sh .husky/pre-commit .husky/commit-msg
```

`pnpm install` corre `pnpm prepare` que instala husky. Si algo
falla, `bash scripts/bootstrap.sh` diagnostica.
