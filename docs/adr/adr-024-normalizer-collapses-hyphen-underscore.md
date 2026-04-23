# ADR-024 — Normalizer colapsa `-` y `_` entre alphanumerics a espacio

- **Estado**: Aceptado
- **Fecha**: 2026-04-23
- **Decisores**: Owner VAIRIX + Claude Code
- **Supersedes parcial**: ADR-013 §2 "Resolver pipeline" (agrega un
  paso `[a-z0-9][-_][a-z0-9] → '$1 $2'` antes del slug lookup)
- **Relacionado con**: ADR-013 (skills taxonomy),
  `src/lib/skills/resolver.ts`,
  `supabase/migrations/20260420000000_skills_catalog.sql`,
  `tests/integration/skills/resolver-equivalence.test.ts`

---

## Contexto

El normalizer de ADR-013 §2 convierte `"React Native"` y `"react native"`
a la forma canónica `"react native"`, pero NO colapsa `-` ni `_` entre
tokens alfanuméricos. Resultado: la variante `"React-Native"` (con
guión, como aparece habitualmente en CVs y stacks listados) normaliza a
`"react-native"` → no matchea slug `"react native"` ni alias (no hay
alias `react-native` poblado) → `skill_id = NULL` → el scorer la
descarta silenciosamente (ADR-015 §1: "uncataloged = invisible").

El caso concreto que expuso el gap: **German Bortoli**, `job_query_id
36cb36bc-2c83-44e8-ac52-c6c5f7e3684e` (Senior Full-Stack Engineer con
React Native como axis del rol). Bortoli tiene 3 años de React Native
en su experiencia Freelancer 2016-2019; el CV parser los extrajo
correctamente con `skill_raw = "React-Native"` pero el resolver los
dejó unresolved. Con ADR-023 (role_essentials gate), Bortoli cayó al
rank #120 con `gate=failed` por faltarle el axis `mobile`.

Revisando la cola de unresolved en `experience_skills`:

| skill_raw                      | n   |
| ------------------------------ | --- |
| react-testing-library          | 6   |
| material-ui                    | 4   |
| react-native                   | 4   |
| react-query                    | 2   |
| chakra-ui                      | 2   |
| styled-components              | 1   |
| redux-toolkit                  | 1   |
| redux-observable               | 1   |
| react-router                   | 1   |
| next-auth                      | 1   |
| (y 20 variantes más con guión) | 25  |

**50 rows de experience_skills y 25 candidatos distintos están
afectados.** La clase es recurrente, no un caso aislado.

## Opciones evaluadas

### A. Poblar aliases manualmente por skill

Agregar `react-native`, `react_native`, `reactnative` a
`skill_aliases` para cada skill afectado.

**Pros**: cambio de datos únicamente, no toca código. Quirúrgico.
**Contras**: no resuelve la clase — cualquier skill nuevo con guión
requiere un alias a mano. Genera deuda oculta.

### B. Paso de normalización que colapsa `-`/`_` entre alphanumerics a espacio

Agregar al normalizer (ADR-013 §2) un paso:

```
([a-z0-9])[-_](?=[a-z0-9])  →  '$1 '
```

**Pros**: resuelve la clase completa. Idempotente: `"react native"` ya
está normalizado, `"react-native"` llega a lo mismo. `react-router`,
`styled-components`, `material-ui`, etc. todos se recuperan sin tocar
el catálogo.
**Contras**: modifica la semántica del resolver canónico →
requiere ADR, migration SQL espejo (ADR-013 §2), backfill de aliases
ya existentes con guión, backfill de `experience_skills` unresolved,
actualización de tests de equivalencia.

### C. Fallback en cascada (intentar original, luego variante colapsada)

Al no matchear, intentar una segunda resolución con `-`/`_` → espacio.

**Pros**: menos disruptivo que B porque el "camino feliz" sigue igual.
**Contras**: duplica la lógica y la divergencia TS↔SQL es más difícil
de mantener. La complejidad se paga cada vez que alguien lee el
resolver. B es más limpio.

## Decisión

**Opción B.** El normalizer colapsa `[a-z0-9][-_][a-z0-9]` a
`[a-z0-9] [a-z0-9]` antes del slug/alias lookup, en ambos lados
(TS `normalizeSkillInput` y SQL `public.resolve_skill`).

Invariantes preservados:

- Puntuación interna con símbolos no-alphanum se preserva tal cual:
  `node.js`, `c++`, `c#`, `ci/cd`, `.net` siguen resolviendo igual.
- Lookahead (no consuming) asegura que `a-b-c` → `a b c` en una sola
  pasada (vs replace global que deja `a b-c`).

Cambios asociados:

1. `src/lib/skills/resolver.ts` agrega el paso en `normalizeSkillInput`.
2. Migration `20260423XXXXXX_resolver_collapses_hyphen_underscore.sql`:
   - `CREATE OR REPLACE` de `public.resolve_skill(text)` con el paso
     espejo.
   - `UPDATE skill_aliases SET alias_normalized = regexp_replace(...)`
     para los 3 aliases existentes con guión (`c-sharp`, `ci-cd`,
     `gitlab-ci`). Previamente verificado: no hay colisión con las
     variantes con espacio.
   - `UPDATE experience_skills SET skill_id = public.resolve_skill(skill_raw)
 WHERE skill_id IS NULL` — backfill idempotente sobre los 50 rows
     recuperables.
3. Tests de equivalencia incluyen `react-native`, `styled-components`,
   `material-ui` como inputs con match esperado.

## Consecuencias

**Positivas:**

- 50 rows / 25 candidatos recuperan los skill_ids correctos sin
  re-correr el CV parser. Caso Bortoli: recupera 3 años de React
  Native y debería aprobar el gate `mobile` de ADR-023 en el próximo
  scorer run.
- La clase queda cerrada: `skill-a`, `skill_a`, `skill a` todos
  normalizan a la misma forma, sin requerir aliases por cada variante.

**Negativas / riesgos:**

- `content_hash` de `job_queries` NO se invalida (el decomposer corre
  antes del resolver en el pipeline y el resolver trabaja sobre el
  output). Los jobs decompuestos siguen siendo válidos; lo que cambia
  es la RESOLUCIÓN, que se re-ejecuta cada match run contra el
  catálogo vigente.
- El slug `e2e-react` (único slug con guión en el catálogo hoy) se
  indexa en el `slugMap` interno también bajo la forma `"e2e react"`.
  Tanto `"e2e-react"` como `"e2e react"` input resuelven al mismo
  skill_id. Si el admin en el futuro crea otro skill con slug
  `"e2e react"`, chocaría — pero el `CHECK` de unicidad del slug
  (sólo contra el valor literal) no lo prevendría. Mitigación: el
  seed-applier rejeta slugs que normalicen a formas ya existentes
  (nota para F4-\*).

## Referencias

- ADR-013 §2 — pipeline canónico del resolver.
- ADR-015 §1 — "uncataloged = invisible" para el scorer.
- ADR-023 — role_essentials gate que expuso el gap.
