# 🧪 Test Architecture

> La estrategia de tests es **parte de la spec**, no un detalle de
> implementación. Este documento es gate de la propiedad _Verifiable_
> (paper §4.3) y de la propiedad _Executable_.
>
> **Regla**: un feature no existe hasta que los tests pasan contra
> un runtime real. "Compila" no es "funciona".

---

## 1. Pirámide (objetivo de distribución)

```
         ┌──────┐
         │ E2E  │  10%  (Playwright, happy paths críticos)
         ├──────┤
         │ Int. │  30%  (vitest + Supabase local + MSW)
         ├──────┤
         │ Unit │  60%  (vitest, puro)
         └──────┘
```

Cada capa tiene reglas propias de qué pertenece y qué no.

---

## 2. Unit tests

**Qué SÍ**: funciones puras, parsers, transformers, matcher de
rejection categories, hash de content, validators de input,
utilidades.

**Qué NO**:

- Tests que mockean el cliente Supabase. Eso va a integration.
- Tests que mockean `fetch`. Usar MSW en integration.
- Tests de componentes UI con lógica compleja — eso va a E2E.

**Convenciones**:

- Archivo: `<source>.test.ts` al lado del source o en
  `__tests__/<source>.test.ts`.
- Naming: `test_<behavior>_<condition>`. Ejemplos:
  - `test_extracts_text_from_valid_pdf`
  - `test_throws_on_unsupported_format`
  - `test_rejects_content_hash_mismatch`
- Assertion de un comportamiento por test. Nada de "mega-test" de 80
  líneas.

---

## 3. Integration tests

**Qué**: cruzar al menos un boundary real: DB, storage, HTTP externo.

### Against DB (Supabase local)

**Instancia dedicada para tests** (ADR-019). Los tests corren contra
una segunda instancia de Supabase, independiente de la de dev.

- **Arranque**: `pnpm test:db:start` (wrapper de
  `supabase start --workdir supabase-test`).
- **Reset**: `pnpm test:db:reset` es seguro de correr siempre — no
  toca la DB de dev.
- **Puertos**: dev = 54321/54322, test = 64321/64322. `.env.test`
  apunta `SUPABASE_TEST_*` al bloque 64xxx.
- **Migraciones**: `supabase-test/supabase/migrations` es un
  symlink a `supabase/migrations` — single source of truth.
- Auth se simula con JWTs generados vía helper `makeTestJwt({role})`.

**Por qué**: correr tests contra la DB de dev destruía data
productiva local (incidente 2026-04-22). Los tests siguen
hitteando Postgres real — solo que ahora uno disposable.

**Ejemplos obligatorios**:

- Policies RLS — un test por policy, usando JWT de role distinto.
- Queries de `src/lib/db/*` — cubren el happy path y al menos un
  error path.
- Triggers `updated_at` — test que modifica row y verifica.

### Against Teamtailor API (MSW)

- **Prohibido** pegar a Teamtailor real en CI.
- Usar MSW (`mock-service-worker`) con fixtures en
  `tests/fixtures/teamtailor/` (respuestas JSON reales anonimizadas).
- Test requeridos:
  - Paginación: 3+ páginas, el cliente las recorre todas.
  - 429 con `Retry-After`: cliente respeta, retrying.
  - 5xx transitorio: backoff y retry hasta N veces.
  - 4xx persistente: no retry, error claro.
  - Rate limit global: 100 requests en < 10s respetan el bucket.

### Against OpenAI

- MSW también. Mock de `/embeddings` retorna vector estable por
  input hash (determinístico) para que los asserts sean reales.
- Test: `test_embedding_worker_skips_when_hash_matches` — al segundo
  run con igual input, NO hay request a OpenAI.

---

## 4. E2E tests

Playwright contra `next dev` + Supabase local.

**Cobertura mínima** (derivada de `use-cases.md`):

- UC-01 Re-descubrimiento — búsqueda híbrida completa.
- UC-04 Perfil consolidado — abrir candidate, ver CV firmado.
- UC-03 Shortlist — create, add, archive.

**Reglas**:

- Seeds fixtos, idempotentes. Cada run parte del mismo estado.
- Un user por role: `recruiter@test.local`, `admin@test.local`.
- Screenshots de fallos guardados como artifacts en CI.

---

## 5. Tests adversariales (paper §4.3 _Verifiable_)

**El test es un cazador, no un testigo.** Para CADA use case debe
existir al menos un test que intente:

- Un input malformado que debería ser rechazado.
- Un cross-tenant access attempt (usando un JWT con `tenant_id` distinto).
- Una transición de estado inválida (ver state machines en
  `use-cases.md`).
- Un rate limit bypass attempt.
- Un signed URL expirado o tampered.
- Una race condition (dos syncs en paralelo).

**Naming**: `test_denies_<thing>`, `test_rejects_<thing>`.

No se acepta un PR con use case nuevo sin al menos un test
adversarial cubriéndolo.

---

## 6. RLS tests (obligatorios)

Cada policy en `supabase/migrations/*_rls_*.sql` tiene su test
correspondiente en `tests/rls/<table>.test.ts`.

Matriz mínima por tabla:

- `recruiter` puede leer lo permitido.
- `recruiter` NO puede leer soft-deleted.
- `recruiter` NO puede insertar en tablas admin-only.
- `admin` tiene todos los permisos esperados.
- `anon` (sin JWT) NO puede nada.
- Usuario con `tenant_id` distinto NO ve data de otro tenant (si
  multi-tenant activado).

Fixture: `tests/helpers/rls.ts` expone `asUser(role)`, `asAdmin()`,
`asAnon()`.

---

## 7. Mutation testing (gate pre-release)

**Herramienta**: Stryker Mutator (Node).

**Cuándo corre**: antes de cada release a staging (pre-release loop,
paper §6.5). NO en cada PR — es caro.

**Targets**:

- `src/lib/normalization/` — score mínimo 90% (lógica crítica).
- `src/lib/teamtailor/` — score mínimo 80%.
- `src/lib/auth/` — score mínimo 95%.
- `src/lib/embeddings/` — score mínimo 80%.

Mutantes sobrevivientes son **gaps de tests**, no riesgos a absorber.

---

## 8. Coverage

| Scope           | Mínimo                | Gate             |
| --------------- | --------------------- | ---------------- |
| Global          | 80%                   | CI fail si < 80% |
| `src/lib/`      | 90%                   | CI fail si < 90% |
| `src/lib/auth/` | 95%                   | CI fail si < 95% |
| `src/app/api/`  | 85%                   | CI fail          |
| RLS policies    | 100% (todas con test) | revisión manual  |

Cobertura se mide con c8/v8. Reportes en CI artifacts.

---

## 9. Anti-patterns prohibidos

**No hacer**:

- Tests que verifiquen estado interno (campos privados, llamadas a
  mock específicas). Se rompen en refactors válidos, pasan en
  violaciones que preservan estructura.
  → usar tests contra la interfaz pública.
- Snapshots que ocupan más de 20 líneas. Legibilidad importa.
- `skip`, `only`, `todo` mergeados a main. Hook los detecta.
- `console.log` en tests. Hook los detecta.
- Mockear `Date.now()` con timers sin cleanup. Crea flakiness.
- `setTimeout` en tests. Usar `vi.useFakeTimers()`.

---

## 10. CI gate

El pipeline de `ci.yml` ejecuta en orden:

1. Install + build
2. Typecheck
3. Lint
4. Unit tests + coverage
5. Boot Supabase local (cache si posible)
6. Integration tests
7. E2E tests (smoke set; full en nightly)
8. (Pre-release) Mutation testing

**Cualquier fallo bloquea el merge a `main`**. No hay skip.

---

## 11. Hotfix exception

En hotfix loop (paper §6.5), el orden cambia: fix + test de
regresión + merge, y las otras cosas (mutation, E2E full) corren
post-deploy. Documentar en `docs/status.md` el hotfix.
