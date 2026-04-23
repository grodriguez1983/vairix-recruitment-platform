# ADR-023 — `role_essentials` derivados del título del JD + seniority `above` simétrico

- **Estado**: Aceptado
- **Fecha**: 2026-04-23
- **Decisores**: Owner VAIRIX + Claude Code
- **Supersedes parcial**: ADR-015 §3 "Score" (delta de seniority — ahora
  `above` suma +5, no 0); ADR-015 §1 "Recall AND sobre must-have skills"
  (ahora hay un gate previo derivado del rol, independiente de
  `must_have` de cada requirement)
- **Relacionado con**: ADR-014 (decomposition), ADR-015 (matching &
  ranking), ADR-021 (OR groups), ADR-022 (seniority-derived min_years),
  `src/lib/rag/decomposition/types.ts`,
  `src/lib/matching/score-aggregator.ts`

---

## Contexto

El ranker de matching no sabe **qué skills definen el rol** vs cuáles
son "stack de apoyo mencionado". Con el prompt v5 (ADR-021), el
decomposer es correctamente conservador y emite casi todas las skills
como `must_have: false`, `min_years: null`. El scorer las pondera
igual (peso 1.0) y el must-have gate se activa solo para lo que el JD
llama _excluyente_ textualmente.

Dos distorsiones encadenadas:

1. Un candidato con **muchas skills secundarias** (infra listada de
   pasada) vence al que tiene **el core stack del título** porque la
   suma de parciales gana a la suma de perfectos.
2. El delta de seniority (ADR-015 §3) da `+5` si el bucket matchea y
   `0` si es `above`. Eso es un **-5 implícito** contra el candidato
   más senior.

### Incidente gatillante (2026-04-23, job_query `ccfd19d3-...`)

JD: _"Senior Full-Stack Engineer (React / Next.js / React Native /
Node.js)"_. Ranking producido:

| Rank | Candidato      | Core stack (R/N/RN/Node) | Score | Seniority |
| ---- | -------------- | ------------------------ | ----- | --------- |
| 1    | **Lucas Diez** | 6.6 / 1.1 / 0 / **0**    | 39.08 | match     |
| 2    | Victor Abeledo | 6.6 / 4.6 / 3.2 / 3.2    | 38.33 | match     |
| 3    | German Bortoli | 2.7 / 1.6 / 0 / **13.2** | 36.47 | above     |

Lucas Diez gana por 0.12 contra Victor porque 4 infras parciales
(GCP/K8s/Terraform/GraphQL a 0.94) suman más que los 5 core perfectos
de Victor, y porque "son tantos bullets nice-to-have que el denominador
es enorme". Al mismo tiempo, Lucas Diez **no es full-stack**: 0 años
de Node. Feedback explícito del owner: _"Lucas Diez no es full stack,
tiene 0 de Node y no tiene que ser considerado"._

Además, German Bortoli (16.9y total, 13y de Node, 6y de Mongo, 5.6y de
Docker) sufre el `-5` implícito del `above` y cae al 3 lugar debajo de
Lucas Diez pese a ser el candidato senior real.

## Decisión

### Parte A: `role_essentials` derivados del título del JD

**Extender `DecompositionResult` con un campo `role_essentials`** que
captura los ejes funcionales del rol extraídos del título/intro:

```ts
interface RoleEssentialGroup {
  label: 'frontend' | 'backend' | 'mobile' | 'data' | 'devops';
  skill_ids: string[]; // OR semantics dentro del grupo
}

interface DecompositionResult {
  // ... existente ...
  role_essentials: RoleEssentialGroup[];
}
```

**Semántica**:

- Un `role_essentials` group = "para hacer este rol, hay que tener al
  menos una de estas skills". Se pobla SOLO con skills que aparecen
  textualmente en el **título** o la **primera oración** del JD. No
  se infiere desde el body.
- Para un JD _"Senior Full-Stack Engineer (React / Next.js / React
  Native / Node.js)"_ → 2 grupos:
  - `frontend`: [React, Next.js, React Native]
  - `backend`: [Node.js]
- Para un JD _"Senior Backend Engineer (Node.js)"_ → 1 grupo:
  - `backend`: [Node.js]
- Para un JD que no tenga título normalizable (ej. "Buscamos
  desarrollador para proyecto X") → `role_essentials: []`. **Lista
  vacía desactiva el gate**.
- Los `skill_ids` de cada grupo deben **también existir en
  `requirements`**. El scorer los usa como lista de IDs para buscar
  años; el breakdown sigue vinculado al requirement.
- Etiquetas posibles: `frontend | backend | mobile | data | devops`.
  Un rol puede aportar múltiples (ej. full-stack = frontend +
  backend; mobile-backend = mobile + backend).

**Nuevo gate** (antes del must-have gate de ADR-021):

- Para cada grupo en `role_essentials`, el candidato debe tener al
  menos UNA skill con `years > 0`.
- Si falla algún grupo → `total_score = 0`, `must_have_gate =
'failed'`. Breakdown se preserva para auditar por qué.

### Parte B: `seniority_match === 'above'` → +5 (simétrico con `match`)

**Reemplazar** la regla `above → 0` por `above → +5`.

- Razonamiento: un candidato en bucket superior al pedido está
  **sobrecalificado**, no descalificado. Darle `0` mientras `match`
  da `+5` es una penalización implícita de 5 puntos contra los
  candidatos más senior. Si el rol requiere senior y el candidato es
  lead, es una señal positiva, no neutra.
- Si en el futuro se quiere penalizar overqualification (ej. por
  presupuesto), que sea un campo explícito `max_seniority` en el
  JD, no un artefacto del scoring.

### Parte C: Peso 2× para skills en `role_essentials`

- En el aggregator, las skills que aparecen en algún `role_essentials`
  group se ponderan con `weight = 2.0` (antes 1.0 si `must_have:
false`, 2.0 si `must_have: true`). El resto de las skills mantienen
  su peso según `must_have`.
- Efecto: una skill del core-stack del título nunca pesa menos que un
  must_have explícito. Esto resuelve el caso de prompt v5 que no
  marca must_have por falta de "excluyente" textual.

## Consecuencias

### Positivas

- **Lucas Diez cae del ranking** para el JD full-stack (Node=0 →
  role_essentials backend gate fails → score=0). Sin tocar el resto
  del sistema.
- **German Bortoli sube** (+5 por seniority above correctamente
  simétrico; peso 2× en Node 13y y React 2.7y).
- **Victor Abeledo sube** (peso 2× en los 4 core stack skills que
  cubre perfectamente).
- El gate es declarativo: una JD "Backend Engineer" emite
  `role_essentials: [{label: backend, skill_ids: [Node]}]` y
  automáticamente filtra candidatos sin Node, sin depender del
  heurístico de "must_have".
- Backward-compatible: `role_essentials: []` → comportamiento
  anterior exacto. Rows existentes en `job_queries.decomposed_json`
  sin el campo se leen como `[]`.

### Negativas / riesgos

- **Prompt más complejo** (v6): el LLM debe distinguir "título vs
  body" y clasificar en los 5 labels. Mitigación: ejemplos
  CORRECT/WRONG + validación post-parse que rechaza labels fuera del
  enum + requirement de que los `skill_ids` existan en
  `requirements`.
- **Títulos ambiguos** (ej. "Developer" sin más): el LLM debe emitir
  `role_essentials: []`. Mejor false-negative (no filtrar) que
  false-positive (filtrar de más).
- **Over-matching por labels incorrectos**: si el LLM clasifica
  Node.js como `frontend` por error, un candidato solo con Node
  falla el gate falsamente. Mitigación: post-parse validator que
  rechaza decomposiciones con etiquetas sospechosas (ej.
  mobile-only skills tagged backend). Fuera de scope de v6 — la
  revisión humana del resolved panel en la UI lo detecta.
- **Bump del prompt v5 → v6** invalida `content_hash` y regenera
  todos los decompose cacheados. Mismo patrón que ADR-021.
- **Re-ranking disruptivo**: los match_runs previos contra JDs con
  seniority concreta y `role_essentials` derivable producen
  resultados distintos al re-correr. No breaking para la DB (sólo
  `match_runs` nuevos); los históricos quedan intactos.

### Descartadas

- **Threshold N-of-M** ("candidato pasa si cubre ≥ K de las M core
  skills"): pierde la distinción entre frontend y backend —
  Lucas Diez con React 6.6y y Next 1.1y cubre 2 de 4 y pasa con
  K=2. Los grupos por rol (frontend vs backend) codifican la
  intuición correcta: un full-stack _necesita_ ambos lados.
- **Forzar `must_have: true` sobre todas las skills del título**:
  con la semántica actual de must_have (AND entre requirements, no
  OR) rompería los JDs full-stack donde distintos candidatos cubren
  frontend vs backend con stacks diferentes. El grupo OR (`[React,
Next, RN]`) es exactamente lo que necesitamos.
- **Nested schema** `{ role: { frontend: string[], backend:
string[] } }`: fixed keys obliga a definir todos los labels por
  adelantado y rompe si el rol no es clasificable en ninguno.
  Array de `{ label, skill_ids }` con enum cerrado es más
  extensible.

## Implementación

- `src/lib/rag/decomposition/types.ts` — `RoleEssentialGroupSchema` +
  campo `role_essentials` en `DecompositionResultSchema`.
- `src/lib/rag/decomposition/resolve-requirements.ts` — propagar
  `role_essentials` tal cual en `ResolvedDecomposition` (son
  `skill_ids` del catálogo, ya resueltos).
- `src/lib/rag/decomposition/providers/openai-decomposer.ts` — campo
  en el `response_format.json_schema` con `strict: true` + enum de
  labels.
- `src/lib/rag/decomposition/prompts/decompose-v1.ts` — bump a
  `'2026-04-v6'`, regla nueva con ejemplos CORRECT/WRONG.
- `src/lib/matching/score-aggregator.ts`:
  - `seniority_match === 'above'` devuelve `+5` (igual que `match`).
  - Pre-check de `role_essentials` al inicio: si cualquier grupo no
    tiene una alt con `years > 0`, retornar `score=0`,
    `must_have_gate='failed'`.
  - Peso 2.0 para requirements cuyo `skill_id` aparece en algún
    `role_essentials.skill_ids`.

No requiere migración de schema DB (campos en jsonb son aditivos).
