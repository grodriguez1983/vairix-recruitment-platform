# 🤖 Claude Code — Convenciones del repo

> Cómo debe operar Claude Code dentro del repositorio
> `recruitment-platform`. Este documento es la fuente canónica de
> convenciones; Claude Code lee un resumen de esto desde `CLAUDE.md`.

---

## 1. Estructura del repo

```
recruitment-platform/
├── CLAUDE.md                    # memoria principal de Claude Code
├── .mcp.json                    # MCP servers disponibles
├── .claude/
│   ├── skills/                  # SKILL.md + assets, uno por dominio
│   ├── agents/                  # subagents con contexto aislado
│   ├── commands/                # slash commands custom
│   └── hooks/                   # scripts de pre/post tool use
├── supabase/
│   ├── migrations/
│   └── seed.sql
├── src/
│   ├── app/                     # Next.js App Router
│   ├── lib/
│   │   ├── teamtailor/          # cliente + tipos
│   │   ├── db/                  # queries + tipos generados
│   │   ├── embeddings/
│   │   └── rag/
│   ├── scripts/                 # scripts ejecutables (sync, backfill)
│   └── types/
├── tests/
├── docs/
│   ├── spec.md                  # mirror del Project
│   ├── adr/
│   └── runbooks/
└── package.json
```

---

## 2. Stack y versiones

- **Node**: LTS actual (≥ 20).
- **Package manager**: pnpm (lockfile commiteado).
- **TypeScript**: estricto (`"strict": true`, sin `any` implícito).
- **Next.js**: App Router.
- **Supabase**: CLI local para migraciones.
- **Tests**: Vitest + Playwright (e2e).
- **Lint/format**: ESLint + Prettier. Biome aceptado como alternativa.

---

## 3. Convenciones de código

### TypeScript
- Nunca `any`. Si no se conoce el tipo, `unknown` + narrowing.
- Preferir `type` sobre `interface` excepto para extensión pública.
- Imports absolutos con alias `@/` apuntando a `src/`.
- Funciones exportadas tipadas explícitamente en sus retornos.

### Naming
- Archivos: `kebab-case.ts`.
- Tipos y componentes: `PascalCase`.
- Variables y funciones: `camelCase`.
- Constantes: `SCREAMING_SNAKE_CASE` solo cuando son verdaderas constantes.
- Tablas y columnas SQL: `snake_case`.

### Organización de módulos
- Un dominio por carpeta (`teamtailor`, `embeddings`, `rag`).
- Cada carpeta expone su API por `index.ts`.
- No importar entre dominios lateralmente; si hace falta, extraer a `lib/shared`.

### Errores
- Nunca atrapar errores solo para loggearlos y seguir.
- Usar `Result<T, E>` o throws tipados; evitar excepciones genéricas.
- En el ETL: errores de un registro no pueden tumbar el batch entero.

---

## 4. Base de datos

- **Tipos generados** con `supabase gen types typescript`.
  Nunca editarlos a mano. Regenerar tras cada migración.
- Queries en `src/lib/db/<entity>.ts`.
- No usar el cliente Supabase directamente desde componentes;
  siempre pasar por la capa `db/`.
- Migraciones versionadas: `supabase/migrations/YYYYMMDDHHMMSS_*.sql`.
- **Antes de cualquier migración**: Claude Code debe correr
  `supabase db diff` y mostrar el SQL propuesto.

---

## 5. Git workflow

### Branches
- `main` — protegida, solo vía PR.
- `feat/<scope>-<short-desc>` — features.
- `fix/<scope>-<short-desc>` — bugfixes.
- `chore/<short-desc>` — mantenimiento.
- `docs/<short-desc>` — solo documentación.

### Commits
- **Conventional Commits**. Formato:
  ```
  <type>(<scope>): <subject>

  <body opcional>

  <footer opcional>
  ```
- Types válidos: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`,
  `perf`, `build`, `ci`.
- Scopes típicos: `etl`, `db`, `ui`, `rag`, `embeddings`, `teamtailor`,
  `sync`, `auth`.
- Subject en imperativo y minúscula: "add candidate search endpoint".
- Nunca commit con `WIP`, `asdf`, o mensajes vacíos.

### PRs
- Título en formato Conventional Commit (se usa para merge).
- Descripción con:
  - **Qué** cambia
  - **Por qué** (link a issue / ADR si aplica)
  - **Cómo probarlo**
  - Screenshots si hay UI
- Un PR = un tema. PRs grandes se parten.

---

## 6. Tests

- **Unit** para lógica pura (parsers, transformers, utils).
- **Integration** para queries DB (contra Supabase local).
- **E2E** para flows críticos de UI (búsqueda, perfil).
- Cobertura mínima sugerida: 70% en `src/lib/`.
- Tests de ETL con fixtures JSON en `tests/fixtures/teamtailor/`.

---

## 7. Cómo debe comportarse Claude Code

### Antes de editar
1. Leer `CLAUDE.md` y las skills relevantes.
2. Si la tarea toca DB: consultar `data-model.md` en `docs/`.
3. Si la tarea toca Teamtailor: consultar `teamtailor-api-notes.md`.
4. Proponer plan antes de ejecutar cambios grandes (>3 archivos o
   cambios de schema).

### Durante
- Preferir cambios pequeños y verificables.
- Correr `pnpm typecheck` y `pnpm test` tras cambios significativos.
- Nunca dejar imports sin usar ni código muerto.
- Si encuentra algo que contradice el spec: detenerse y preguntar.

### Después
- Actualizar docs si el cambio afecta convenciones o schema.
- Sugerir ADR si la decisión es estructural.
- Preparar mensaje de commit en Conventional Commits.

### Qué NO hacer sin autorización explícita
- Cambiar el stack (Next.js, Supabase, pgvector).
- Agregar dependencias pesadas (>100kb) sin justificación.
- Ejecutar `DROP`, `TRUNCATE`, `DELETE` sin `WHERE` específico.
- Exponer endpoints sin auth.
- Llamar a la API de Teamtailor en producción desde tests.
- Hacer commits directos a `main`.
- Pushear si los tests fallan.

---

## 8. Variables de entorno

- Documentadas en `.env.example` con descripción de cada una.
- Secretos nunca en el repo. Nunca `.env` commiteado.
- Convenciones de naming:
  - `TEAMTAILOR_*` para todo lo de Teamtailor
  - `SUPABASE_*` para DB/Storage
  - `OPENAI_*` o `ANTHROPIC_*` para LLMs
- Variables server-only **no** llevan `NEXT_PUBLIC_`. Revisar siempre.

---

## 9. Observabilidad mínima (POC)

- Log estructurado (JSON) en stdout para scripts y API routes.
- Campos base: `timestamp`, `level`, `scope`, `message`, `meta`.
- Errores de ETL → tabla `sync_state.last_run_error`.
- Métricas deferred a Fase 2+.

---

## 10. Checklist de Definition of Done

Para considerar una tarea completada:

- [ ] Código tipado estricto, sin `any`
- [ ] Tests unitarios pasando
- [ ] `pnpm typecheck` limpio
- [ ] `pnpm lint` limpio
- [ ] Migración aplicada en local si hubo cambios de schema
- [ ] Tipos de DB regenerados si aplica
- [ ] Docs actualizados si aplica
- [ ] Commit en Conventional Commits
- [ ] PR con descripción completa
