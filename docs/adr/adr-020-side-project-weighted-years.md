# ADR-020 — `side_project` contribuye con peso reducido al cálculo de years-for-skill

- **Estado**: Aceptado
- **Fecha**: 2026-04-23
- **Decisores**: Owner VAIRIX + Claude Code
- **Supersedes**: ADR-015 §1 invariante "Solo `kind='work'` cuenta para
  years" (parcial — education sigue excluida)
- **Relacionado con**: ADR-015 (matching & ranking), ADR-012
  (extracción de CVs), `src/lib/matching/years-calculator.ts`,
  `src/lib/matching/pre-filter.ts`

---

## Contexto

ADR-015 §1 estableció como invariante: _"Solo `kind='work'` cuenta
para years. `side_project` y `education` pueden aparecer en la UI
como contexto, pero no suman."_ La motivación fue premiar experiencia
real de producción sobre código de hobby.

### Incidente gatillante (2026-04-23)

Corriendo el matching pipeline en la demo con 200 candidatos reales,
apareció el siguiente comportamiento inconsistente en la candidata
Graciela Benbassat:

- **Perfil real**: psicóloga clínica + programadora legacy (COBOL /
  mainframes, 1985–2001). En 2022-2023 completó "Backend Developer
  Certification" — un side_project de ~2 años donde aprendió Node.js,
  TypeScript y PostgreSQL.
- **Prefilter** (`pre-filter.ts`) la dejó pasar: tenía
  `experience_skills` rows para los 3 must-haves de la JD (aunque
  pegadas a un `candidate_experience` de `kind='side_project'`).
  Único filtro: "¿tiene un row en `experience_skills` para cada
  must-have?". No distingue `kind`.
- **Aggregator** (`years-calculator.ts`) excluía el side_project por
  completo → `candidate_years = 0` para los 3 → `years_ratio = 0` →
  `must_have_gate = 'failed'` → `total_score = 0`.

Resultado UI: Graciela rank #9 con status "FAILED" y score 0.00,
aunque **sí tiene** evidencia cataloged de los 3 skills. El recruiter
no tiene forma de distinguir "candidata con skill en bootcamp
reciente" de "candidata sin evidencia de skill alguna" — los dos
casos colapsan al mismo `score=0, status=missing`.

### El desajuste estructural

Pre-filter y aggregator tienen **contratos distintos** sobre qué
cuenta como "experiencia en un skill". El prefilter es inclusivo
(cualquier `experience_skills` row vale); el aggregator es estricto
(solo `kind='work'`). Todo candidato que pase el filtro y falle el
gate inmediatamente es síntoma de este gap.

Dos formas de cerrar el gap:

- **(A) Hacer más estricto al prefilter**: filtrar también por
  `kind='work'`. Graciela y similares quedan fuera desde el inicio.
  Consistencia simple, pero silently descarta candidates con skill
  solo en bootcamp/curso — es un falso negativo para devs que salen
  de bootcamp y aún no tienen experiencia laboral con esa tech.
- **(B) Relajar el aggregator** para que `side_project` cuente con
  peso reducido. Consistencia con modelo más fiel a realidad:
  bootcamps y side projects **son** evidencia, pero no equivalen a
  trabajo full-time.

Esta ADR elige (B).

## Decisión

### Invariante reemplazado

El invariante de ADR-015 §1 _"Solo `kind='work'` cuenta para years"_
se reemplaza por:

> **Years-for-skill se computa como suma ponderada de intervalos
> mergeados por kind**: `kind='work'` al 100%, `kind='side_project'`
> al 25% de su duración neta (no-solapada con work), `kind='education'`
> al 0% (sin cambios).

### Algoritmo

```
1. merged_work      := merge(intervals of kind='work' with skillId)
2. merged_side_raw  := merge(intervals of kind='side_project' with skillId)
3. merged_side_net  := merged_side_raw \ merged_work   // set-subtract
4. work_years       := sum(duration(merged_work))
5. side_years_net   := sum(duration(merged_side_net))
6. yearsForSkill    := work_years + SIDE_PROJECT_WEIGHT * side_years_net

   SIDE_PROJECT_WEIGHT = 0.25
```

**Invariantes**:

- `kind='education'` sigue excluido por completo (las 4 filas de
  Graciela con `kind='education'` no suman — son certificaciones /
  títulos, no experiencia activa).
- La sustracción set-theoretic (step 3) evita **double counting**:
  si alguien usa React en el trabajo Y paralelamente en un side
  project durante el mismo período, el tiempo solapado ya está
  contado a peso completo por work. El side_project solo suma en su
  porción no-solapada.
- Si `end <= start` o `start_date = null`, la experiencia sigue
  siendo saltada silenciosamente (ADR-015 regla preservada).
- Skills con `skill_id IS NULL` siguen sin contribuir (ADR-015 §1).

### Rationale del peso `0.25`

- 1 año de side_project aporta ~3 meses de señal equivalente-a-work.
  Suficiente para destrabar el gate de `years_ratio = 0` cuando hay
  evidencia real, pero no suficiente para rankear arriba de alguien
  con experiencia full-time en la stack.
- Coincide informalmente con la relación tiempo-dedicado de un
  side_project vs un rol full-time (20-30% del horario).
- Graciela con 2 años de side_project en Node.js queda con 0.5 years
  ponderados → `years_ratio = 0.1` contra `min_years = 5` → pasa el
  gate pero con `contribution` bajo, ranking muy por debajo de
  candidates con trabajo real en el stack. **Exactamente el
  comportamiento que queremos**: visible, auditable, subordinado.

### Efecto en el prefilter

**No se modifica** `pre-filter.ts`. Seguirá aceptando candidatos con
`experience_skills` en cualquier `kind`. La consistencia con el
aggregator ya está garantizada: si el prefilter deja pasar un
candidato, el aggregator le calculará years > 0 (aunque bajo) siempre
que haya un `kind='work'` o `kind='side_project'` con el skill.

Education sigue siendo la excepción: un candidato cuyo único
`experience_skills` para un must-have esté en `kind='education'`
todavía podría pasar el prefilter y fallar el gate. Aceptable: este
caso es raro y un curso universitario sin aplicación práctica
probablemente debe revisarse manualmente.

## Alternativas consideradas

### i) Status quo (ADR-015 §1 sin cambios — "work-only")

- **Pro**: simplicidad; invariante único de años.
- **Con**: genera falsos negativos visibles como el de Graciela.
  Peor: los colapsa a `score=0` sin distinguirlos de candidates
  realmente vacíos.
- **Descartada**: degrada la señal al recruiter.

### ii) Hacer más estricto al prefilter (opción A)

- **Pro**: consistencia con el invariante original.
- **Con**: los descarta silenciosamente antes del ranker. Recruiter
  nunca ve la evidencia de skill. Violación del principio
  "Auditable" (CLAUDE.md §5) — decisiones estructuralmente
  invisibles.
- **Descartada**: preferimos mostrar al candidato con score bajo
  antes que ocultarlo.

### iii) Peso `0.5` o `1.0` para side_project

- **Pro**: más generoso con bootcamps y autodidactas.
- **Con**: un senior con 5 años de side_project de React quedaría
  empatado o por encima de un mid con 3 años de trabajo real. No
  refleja el peso profesional real. A `1.0` ya es peor que
  `work-only` para el pool senior.
- **Descartada**: `0.25` es el sweet spot — destrabai el gate sin
  inflar el ranking.

### iv) Weight configurable por tenant

- **Pro**: futureproofing.
- **Con**: overkill para F4 (5–15 usuarios internos), agrega un
  setting que nadie sabe ajustar. Yagni.
- **Descartada**: el constante `SIDE_PROJECT_WEIGHT` en el código es
  suficiente; si hay demanda de tuning se promueve a config en un
  ADR futuro.

### v) Contar `kind='education'` también

- **Pro**: cursos certificados (Coursera, ej.) son señal de
  aprendizaje reciente.
- **Con**: overlap masivo con bootcamps (kind='side_project'
  existente cubre el caso real). Education incluye cosas como
  "Systems Engineer, Universidad X, 1985-1990" que no es evidencia
  de proficiencia actual. Ruido alto.
- **Descartada**: mantenemos education a `0` por ahora. Si el
  parser mejora para distinguir "curso técnico corto" vs "título
  universitario viejo", revisitar.

## Consecuencias

### Positivas

- **Graciela y similares quedan visibles pero subordinados**:
  pasan el gate con score bajo, rankean por debajo de candidates
  con experiencia de trabajo real. El recruiter ve la señal y
  decide.
- **Consistencia entre prefilter y aggregator**: ya no existen
  candidatos que "pasen el filtro pero fallen el gate por 0 años".
  Todo candidato que pase el filtro tendrá `candidate_years > 0`
  (salvo edge case de education-only).
- **Auditabilidad preservada**: el breakdown distingue qué
  porcentaje de years vino de work vs side_project (ver "Notas de
  implementación" para el campo `candidate_years_breakdown` si se
  agrega).

### Negativas

- **Complica marginalmente el cálculo**: interval subtraction no es
  trivial y requiere un helper. Mitigado por test adversariales.
- **El número `0.25` es una elección de producto sin A/B test**.
  Puede cambiar post-lanzamiento. Aceptable: es una constante
  explícita y versionada en código.
- **Breaks backward compatibility del ADR-015 §1**: tests
  existentes que esperan `side_project → 0` deben actualizarse
  (específicamente `test_side_project_excluded_from_years`).
  Documentado en la sección "Tests actualizados" abajo.

### Neutras

- Performance irrelevante: agrega O(n) passes sobre intervalos
  con sweep-line merge, << 1ms incluso con 100 experiencias.

## Tests actualizados / nuevos

### Ajustado

- `test_side_project_excluded_from_years` → renombrar a
  `test_side_project_contributes_at_quarter_weight`. Expected: 2
  años de side_project → 0.5 years (no 0).

### Nuevos (adversarios)

- `test_education_still_excluded` — curso de 3 años en
  `kind='education'` sigue dando `0`. Regresión-guard.
- `test_work_overlap_with_side_project_no_double_count` — work
  2020-2022 + side_project 2021-2023 (mismo skill) → work=2y
  (full) + side_net=1y (2022-2023, no solapado) × 0.25 = 2.25y.
- `test_side_project_fully_contained_in_work_adds_nothing` —
  work 2020-2023 + side_project 2021-2022 → 3y (el side_project
  está 100% solapado con work, no aporta).
- `test_multiple_disjoint_side_projects` — 2 side_projects
  disjuntos de 2y y 1y → 0.5y + 0.25y = 0.75y.
- `test_side_project_only_candidate_passes_gate_with_low_score`
  — requirement `min_years=5`, candidato con side_project 2y →
  `candidate_years=0.5`, `years_ratio=0.1`, `must_have_gate='passed'`
  (no más 0), `contribution` baja. Integration con score-aggregator.

## Notas de implementación

- La constante `SIDE_PROJECT_WEIGHT = 0.25` vive en
  `years-calculator.ts`. Si se promueve a configurable, mover a
  `src/lib/matching/constants.ts` o a un setting por tenant.
- Helper nuevo `subtractIntervals(base, subtrahend)` para el set
  difference. Su complejidad es O((n+m) log(n+m)) vía sweep-line.
  Aislarlo en `date-intervals.ts` (ya existe y contiene
  `toInterval`, `MS_PER_YEAR`).
- Actualizar el header JSDoc de `years-calculator.ts` para
  referenciar ADR-020 y listar los nuevos invariantes.
- Actualizar ADR-015 §1 con un "Superseded by ADR-020 en parte" al
  inicio del bloque de invariantes de años, preservando el texto
  original como contexto histórico.
- El breakdown en `match_results.breakdown_json` puede ganar un
  campo `work_years` / `side_project_years` futuro para que la UI
  muestre "3y work + 0.5y from side projects" — **no en esta ADR**,
  dejar como mejora incremental.

## Criterios de reevaluación

- Si >20% de los runs tienen top-10 dominado por candidatos con
  `side_project_years > work_years`, el peso 0.25 es demasiado
  alto. Bajar a 0.15 o volver a work-only.
- Si recruiters reportan que "dev junior con bootcamp reciente" no
  aparece cuando debería, subir a 0.35.
- Si el prefilter sigue dejando pasar false positives de education-
  only, considerar extender el algoritmo a education al 0.1 o
  ajustar el prefilter.
