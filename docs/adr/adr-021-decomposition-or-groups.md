# ADR-021 — Alternativas OR en `DecompositionResult` (`alternative_group_id`)

- **Estado**: Aceptado
- **Fecha**: 2026-04-23
- **Decisores**: Owner VAIRIX + Claude Code
- **Supersedes**: ADR-014 §2 (schema de requirements — ahora cada
  requirement tiene `alternative_group_id: string | null`); ADR-015 §1
  invariante "recall AND sobre must-have skills" (parcial — ahora AND
  entre grupos, OR dentro de cada grupo)
- **Relacionado con**: ADR-013 (skills catalog), ADR-014 (decomposition),
  ADR-015 (matching & ranking), ADR-016 (rescue FTS),
  `src/lib/rag/decomposition/types.ts`, `src/lib/matching/pre-filter.ts`,
  `src/lib/matching/score-aggregator.ts`

---

## Contexto

Las JDs reales combinan requisitos con conectores de **alternativa**:

- _"Manejo de CSS moderno (Tailwind **o** styled-components)"_
- _"Next.js **o** Remix"_
- _"GraphQL / Apollo Client"_
- _"testing (Jest, Playwright)"_

Humanamente, el criterio es _"al menos uno de estos"_. Pero el schema
original de `DecompositionResult` (ADR-014 §2) modela cada skill como un
requirement independiente con su `must_have: boolean`, sin ningún link
entre alternativas. Dos problemas encadenados:

1. El prompt v4 (commit `6c1e355`) correctamente desagrega "A o B" en
   dos requirements (para que el catálogo pueda resolverlos), pero
   ambos salen con `must_have: true` cuando están en la sección
   "Requisitos excluyentes".
2. El recall (`pre-filter.ts:87`) exige que el candidato tenga
   **todos** los resolved must-have skill_ids. Aplicado a dos
   alternativas independientes del mismo par → es AND, no OR → el
   candidato debe saber Tailwind **y** styled-components para pasar.

### Incidente gatillante (2026-04-23)

JD de Senior Frontend con:

```
Requisitos excluyentes:
- Manejo de CSS moderno (Tailwind o styled-components)
```

Investigación independiente contra la DB mostró que el sistema dejó
fuera a 3 candidatos que califican humanamente:

| Candidato      | React | TS  | Tailwind | styled-components |
| -------------- | ----- | --- | -------- | ----------------- |
| Elena Tibekina | ✅    | ✅  | ❌       | ✅                |
| Juan Jose Diaz | ✅    | ✅  | ❌       | ✅                |
| Victor Abeledo | ✅    | ✅  | ❌       | ✅                |

Ninguno fue evaluado. Con un catálogo completo (con styled-components
agregado), el recall AND **empeoraría**: ningún candidato real usa los
dos estilos al mismo tiempo, así que nadie pasaría el gate.

## Decisión

**Modelar alternativas como un flat `alternative_group_id` en cada
`Requirement`.**

```ts
interface Requirement {
  skill_raw: string;
  // ... campos existentes ...
  alternative_group_id: string | null;
}
```

**Semántica**:

- Un grupo es el conjunto de requirements que comparten el mismo
  `alternative_group_id`. Los requirements con `id = null` son
  **singletons** (grupo de 1). Sin cambios respecto al comportamiento
  anterior — el rendering por defecto es exactamente el mismo.
- Dentro de un grupo, la operación es **OR**: basta con que una
  alternativa se satisfaga para cubrir el grupo.
- Entre grupos, la operación sigue siendo **AND**: todos los grupos
  must-have deben tener al menos una alternativa satisfecha.
- Todos los miembros de un grupo **deben** tener el mismo
  `must_have`. Emitir un grupo con `must_have` mixto es un error de
  schema (el prompt lo prohíbe explícitamente).
- La contribución del grupo al score es **max de sus alternativas**,
  no la suma. El peso del grupo en el denominador es el peso de una
  alternativa (must_have=2, nice=1), no N×peso.

### Ejemplos concretos

| JD fragment                      | Salida esperada                                                         |
| -------------------------------- | ----------------------------------------------------------------------- |
| `"Tailwind o styled-components"` | 2 requirements, mismo `alternative_group_id`, `must_have` según sección |
| `"Next.js o Remix"`              | 2 requirements, mismo group_id                                          |
| `"React"`                        | 1 requirement, `alternative_group_id: null`                             |

## Consecuencias

### Positivas

- Los 3 false negatives medidos (Elena, Juan Jose, Victor) pasan a
  ser evaluados sin relajar ningún criterio humano.
- Desbloqueada la interpretación correcta de patrones `"A o B"`,
  `"A / B"`, `"A, B"` bajo una umbrella común — algo que aparece en
  > 40% de las JDs revisadas en producción.
- Compatibilidad ascendente garantizada: rows existentes en
  `job_queries.decomposed_json` sin el campo se leen como `null`
  (singletons) sin cambios semánticos.

### Negativas / riesgos

- **Prompt más complejo**: el LLM debe emitir group_ids consistentes
  cuando ve listas de alternativas. Mitigación: ejemplos
  CORRECT/WRONG concretos en el prompt (regla nueva en v5) +
  validación post-parse que rechaza grupos con `must_have` mixto.
- **Scorer y recall más ramificados**: grupo con una alt resuelta + N
  unresolved tiene que ser tratado como "el resolved gobierna el
  gate/score; las unresolved son invisibles". Los tests cubren cada
  combinación.
- **Rescue FTS amplificado**: cuando una must-have group falta en
  `experience_skills`, el rescue debe buscar por FTS todas las
  alternativas del grupo en `files.parsed_text`. Más matches posibles
  pero también más falsos positivos. Mitigación: tomar el mejor
  match por grupo, no sumar.
- **Bump de prompt** → invalida `job_queries.content_hash` → todos
  los decompose cacheados se recalculan en el próximo hit. Igual que
  el bump v3 → v4 del commit `6c1e355`. No requiere migración.

### Descartadas

- **Completar el catálogo** (agregar styled-components, Remix, etc.):
  no resuelve el problema — con el recall AND, candidatos con solo
  una alternativa siguen siendo excluidos. Peor: agregar ambas al
  catálogo hace que nadie pase porque en la realidad son mutuamente
  exclusivas.
- **Nested schema** `{ alternatives: Requirement[], must_have: bool }`:
  requiere tocar cada capa dos veces (Requirement y
  RequirementGroup), y pierde la propiedad de "cada alternativa sigue
  siendo un requirement normal con su breakdown individual".
- **"Skill groups" en el catálogo** (ej. un grupo "css-styling" que
  contiene Tailwind + styled-components): los grupos dependen del JD,
  no del catálogo. Este tipo de agrupación universal sobre-restringe
  contextos donde la JD no permite alternativas.

## Implementación

- `src/lib/rag/decomposition/types.ts` — campo en Zod.
- `src/lib/rag/decomposition/providers/openai-decomposer.ts` — campo
  en `RESPONSE_JSON_SCHEMA` con `strict: true`.
- `src/lib/rag/decomposition/prompts/decompose-v1.ts` — bump a
  `'2026-04-v5'`, nueva regla con ejemplos CORRECT/WRONG.
- `src/lib/matching/pre-filter.ts` — reemplazar `covered.size ===
mustHaveCount` por agrupación por `alternative_group_id` + AND
  entre grupos, OR dentro.
- `src/lib/matching/score-aggregator.ts` — contribución = max por
  grupo; denominador = sumatoria de pesos de grupos (no de
  requirements).
- `src/lib/matching/run-match-job.ts` — propagar los grupos faltantes
  al rescue.

No requiere migración de schema DB (campo en jsonb es aditivo).
