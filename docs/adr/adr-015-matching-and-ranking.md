# ADR-015 — Matching & ranking de candidatos contra un job query

- **Estado**: Propuesto
- **Fecha**: 2026-04-20
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: `use-cases.md` UC-11, ADR-012 (extracción
  de CVs), ADR-013 (catálogo de skills), ADR-014 (descomposición
  de job description), ADR-003 (RLS), `spec.md` §2.6

---

## Contexto

UC-11 termina con una lista ordenada de candidatos para un job
description pegado por el recruiter. ADR-012 nos da experiencias
estructuradas por candidato con skills resueltas al catálogo.
ADR-013 nos da un catálogo canónico. ADR-014 nos da un query
estructurado con `requirements[]` y `seniority`. Falta la decisión
**cómo se combinan estos datos para producir un ranking**.

Decisiones en juego:

1. **Años por skill con experiencias solapadas**. Un candidato con
   dos trabajos simultáneos (2020-2022 en A + 2021-2023 en B, ambos
   usan Node.js) no tiene 4 años de Node.js: tiene 3 (la unión de los
   intervalos). El usuario dejó esto _"a tu criterio"_ en P3.

2. **Weight por variant del CV**. Un candidato puede tener dos CVs
   indexados (LinkedIn export + CV oficial). El oficial pesa más
   (P1, confirmado en ADR-012). Hay que decidir qué significa "pesa
   más" operacionalmente: ¿ignorar el linkedin si hay oficial?
   ¿combinar con peso? ¿tomar max?

3. **Must-have vs nice-to-have**. ADR-014 marca requirements como
   `must_have: boolean`. Si falta un must-have, el candidato no debe
   aparecer (o debe aparecer marcado). Decisión binaria o graduada.

4. **Explicabilidad**. El recruiter necesita entender _por qué_ un
   candidato ranked alto o bajo para confiar en el resultado (y para
   detectar bugs en el matcher temprano). Sin explicación, el sistema
   es una caja negra y el usuario vuelve a filtrar a mano.

5. **Persistencia del match run**. ¿Calculamos on-demand cada vez?
   ¿Cacheamos resultados? El catálogo (ADR-013) y las extracciones
   (ADR-012) evolucionan, entonces un cache puede quedar stale.

6. **Filtros adicionales** más allá del scoring puro: languages,
   seniority, disponibilidad. Cómo se componen con el score.

Esta es la última ADR del eje F4. Cierra el loop: `job_description`
entra por ADR-014 → sale `DecompositionResult` → este ADR toma eso y
produce `MatchResult[]`.

---

## Decisión

### 1. Cálculo de años por skill (P3)

**Sweep-line / merge de intervalos**. Para cada candidato y cada
`skill_id` mencionada, ejecutamos:

```ts
function yearsForSkill(skillId: string, experiences: CandidateExperience[]): number {
  // 1. Filtrar solo experiencias kind='work' que mencionan skillId
  //    (via experience_skills). NO incluir side_project ni education.
  const intervals = experiences
    .filter((exp) => exp.kind === 'work' && exp.skills.some((s) => s.skill_id === skillId))
    .map((exp) => ({
      start: parseDate(exp.start_date),
      end: exp.end_date ? parseDate(exp.end_date) : NOW,
    }))
    .filter((i) => i.start !== null && i.end !== null);

  if (intervals.length === 0) return 0;

  // 2. Merge overlapping intervals
  intervals.sort((a, b) => a.start - b.start);
  const merged: Interval[] = [intervals[0]];
  for (const curr of intervals.slice(1)) {
    const last = merged[merged.length - 1];
    if (curr.start <= last.end) {
      last.end = Math.max(last.end, curr.end);
    } else {
      merged.push(curr);
    }
  }

  // 3. Sum merged durations, convert to years
  const totalMs = merged.reduce((sum, i) => sum + (i.end - i.start), 0);
  return totalMs / MS_PER_YEAR;
}
```

Invariantes:

- **Solo `kind='work'` cuenta para years**. `side_project` y `education`
  pueden aparecer en la UI como contexto, pero no suman.
- Experiencia sin `start_date` válido se ignora para ese cálculo (no
  aborta el ranking, se loggea en `match_runs.diagnostics`).
- Experiencia con `end_date = null` se asume `end = NOW`.
- Skills resueltas via `experience_skills.skill_id`. Rows con
  `skill_id IS NULL` (no resueltas al catálogo) no cuentan.

### 2. Weight por variant del CV (P1)

Cuando un candidato tiene **dos** `candidate_extractions` (una
`cv_primary` y una `linkedin_export`), usamos:

> **Unión con `cv_primary` autoritativa**. Tomamos el conjunto union
> de experiencias de ambas variantes. Para duplicados (mismo
> `company` + título normalizado + overlap de fechas > 50%), `cv_primary`
> gana las fechas/título/descripción. Skills se unionan.

Esto resuelve el caso común: el CV oficial tiene más detalle en 3
trabajos, LinkedIn tiene 8 trabajos listados pero sin fechas
precisas. El resultado final: 8 trabajos, los 3 con datos del CV
oficial, los otros 5 con datos del LinkedIn.

Alternativa descartada: ignorar `linkedin_export` si existe
`cv_primary`. Pierde señal útil.

Alternativa descartada: weight continuo (p.ej. 1.0 vs 0.6) sobre el
score final. Complica explicabilidad sin beneficio claro a esta
escala (5-15 usuarios).

El `source_variant` se propaga a cada experiencia fusionada para que
la UI pueda mostrar origen ("extraído del CV oficial" / "extraído de
LinkedIn").

### 3. Scoring por candidato

```ts
type CandidateScore = {
  candidate_id: string;
  total_score: number; // 0..100
  must_have_gate: 'passed' | 'failed';
  breakdown: Array<{
    requirement: {
      skill_raw: string;
      skill_id: string | null;
      min_years: number | null;
      must_have: boolean;
    };
    candidate_years: number;
    years_ratio: number; // 0..1
    contribution: number; // 0..100
    status: 'match' | 'partial' | 'missing';
    evidence: Array<{
      experience_id: string;
      company: string;
      date_range: string;
    }>;
  }>;
  language_match: { required: number; matched: number };
  seniority_match: 'match' | 'below' | 'above' | 'unknown';
};
```

**Algoritmo**:

1. **Must-have gate**. Para cada `requirement.must_have = true`:
   - Si `candidate_years = 0` y `min_years != null && min_years > 0`:
     `must_have_gate = 'failed'`, `total_score = 0`, candidato se
     incluye en la respuesta pero con flag; la UI lo muestra en una
     sección aparte ("no cumplen requisitos obligatorios").
2. **Per-requirement contribution**:
   - Si `min_years = null`: `years_ratio = (candidate_years > 0) ? 1.0 : 0.0`
     (booleano de presencia).
   - Si `min_years != null`: `years_ratio = min(candidate_years / min_years, 1.0)`.
   - `contribution = years_ratio * weight` donde `weight = 2.0` si
     `must_have` y `1.0` si no.
3. **Aggregate**:
   - `raw = sum(contributions)`
   - `max_possible = sum(weights)` — normaliza.
   - `total_score = (raw / max_possible) * 100`.
4. **Language bonus**: +5 si todas las languages required matchean,
   -10 si falta alguna must-have language.
5. **Seniority**: si `decomposition.seniority` != `unspecified` y no
   coincide con la seniority derivada del candidato (años totales de
   trabajo), el score se ajusta ±5. Si es `unknown`, no se ajusta.

Score final cliente en `[0, 100]` post-clamp.

### 4. Explicabilidad

El `breakdown` se persiste en `match_results.breakdown_json` y se
renderiza en la UI como:

```
Candidato: Juan Pérez — Score 78/100 (passes must-have)

✓ React (requerido 3+ años, must-have) — 5.2 años — +2.0
  Evidence: Acme Corp (2020-01 → 2023-04), Globex (2019-06 → 2020-01)
✓ TypeScript (requerido 2+ años, must-have) — 4.1 años — +2.0
  Evidence: Acme Corp (2020-01 → 2023-04)
⚠ AWS (nice-to-have) — 0.8 años — +0.40 (parcial)
  Evidence: Globex (2019-06 → 2020-01)
✗ Kubernetes (nice-to-have) — missing — +0

Languages: 1/1 matched (Inglés B2+)
Seniority: senior (solicitado senior) — match
```

Cada línea debe ser refutable leyendo el CV original (trazabilidad
a `candidate_experiences`).

### 5. Persistencia: `match_runs` y `match_results`

Dos tablas:

```sql
create table match_runs (
  id uuid primary key default gen_random_uuid(),
  job_query_id uuid not null references job_queries(id) on delete cascade,
  tenant_id uuid,
  triggered_by uuid references auth.users(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  candidates_evaluated integer,
  diagnostics jsonb,  -- warnings, skipped candidates, etc
  catalog_snapshot_at timestamptz not null,  -- para reproducibilidad
  created_at timestamptz not null default now()
);

create table match_results (
  match_run_id uuid not null references match_runs(id) on delete cascade,
  candidate_id uuid not null references candidates(id) on delete cascade,
  total_score numeric(5, 2) not null,
  must_have_gate text not null check (must_have_gate in ('passed', 'failed')),
  rank integer not null,
  breakdown_json jsonb not null,
  primary key (match_run_id, candidate_id)
);

create index idx_match_results_run_rank on match_results(match_run_id, rank);
```

Decisión clave: **cada ejecución es un run inmutable**. No
actualizamos resultados in-place. Si el catálogo cambia, el run
anterior sigue siendo interpretable como "snapshot del mundo a la
hora X". El recruiter puede re-ejecutar para obtener un run nuevo.

`catalog_snapshot_at` es informativo: la reproducibilidad estricta
requeriría versionar todo el catálogo, lo cual postponemos (out of
scope F4).

### 6. Filtros composables

El scoring produce ranking; los filtros aplican encima:

- `filter.min_score` — descarta candidatos con `total_score < N`.
- `filter.must_have_gate` — `'passed_only'` (default) / `'include_failed'`.
- `filter.language.required` — lista de `(name, min_level)`.
- `filter.seniority` — override del derivado del job query.
- `filter.location` — **no en F4**, ADR futuro.

Los filtros **no** alteran `total_score`; solo filtran el result set.
Esto mantiene el score comparable entre runs con diferentes filtros.

### 7. Abstracción del ranker

```ts
export interface Ranker {
  rank(input: {
    jobQuery: DecompositionResult;
    candidates: CandidateAggregate[]; // ya resueltos con experience_skills
    catalogSnapshotAt: Date;
  }): Promise<RankResult>;
}

export type CandidateAggregate = {
  candidate_id: string;
  merged_experiences: CandidateExperience[]; // post-variant-merge del §2
  languages: Array<{ name: string; level: string | null }>;
  total_work_years: number;
};

export type RankResult = {
  results: CandidateScore[];
  diagnostics: Array<{
    candidate_id: string;
    warning: string;
  }>;
};
```

Implementación default: `DeterministicRanker` — **puro, sin LLM**.
El scoring es explicable línea por línea. No usamos embeddings ni
similitud semántica en esta ADR (ver alternativa D).

### 8. RLS

- `match_runs`: SELECT recruiter+admin de su tenant. INSERT por
  server action auth'd. UPDATE solo backend (para cerrar run).
  DELETE solo admin.
- `match_results`: SELECT misma policy que `match_runs` (join-based
  policy o duplicación de `tenant_id`; decisión: duplicar
  `tenant_id` en `match_results` para evitar join en la policy).

### 9. Performance

Budget F4: 100 candidatos por run, < 3s p50.

Estrategia:

- Query única a Postgres: todos los `candidate_experiences` +
  `experience_skills` para los candidatos evaluados (filtro previo
  por tenant + must-have skill presence).
- Filtro previo **grueso** antes del ranker: candidatos que tengan
  al menos 1 match de must-have skill_id (bitmap join). Esto reduce
  dramáticamente el universo.
- Ranking puro en memoria (TypeScript, no SQL).
- Sin paralelización en F4.

Si superamos los 1000 candidatos o degradamos > 5s p95, reevaluar
(ver "Criterios de reevaluación").

---

## Alternativas consideradas

### A) Ranking vía embeddings + cosine similarity

- **Pros**: captura señal semántica, no requiere catálogo perfecto.
- **Contras**: caja negra, caro de explicar, requiere embeddings por
  candidato y por job query, no distingue años. Incompatible con
  el requerimiento de "contar años en experiencia real".
- **Descartada porque**: UC-11 requiere explicabilidad + conteo
  numérico de años. Embeddings podrían usarse como **filtro previo**
  en el futuro si la escala crece (ADR futuro), pero no como ranker.

### B) Ranking vía LLM ("dale estos CVs y este JD, dame ranking")

- **Pros**: trivial de implementar.
- **Contras**: caro, no determinístico, no auditable, manda PII
  masiva al provider, alucina years.
- **Descartada porque**: viola explicabilidad + costo + PII.

### C) Years = suma directa sin merge

- **Pros**: trivial.
- **Contras**: infla candidatos con trabajos solapados (common: part
  time + full time, freelance paralelo). Premia al que solapa más,
  no al que tiene más experiencia real.
- **Descartada porque**: contradice la intención de UC-11 ("años
  reales de experiencia"). User mencionó explícitamente "validando
  tecnologías y años experiencia".

### D) Weight continuo por variant (cv_primary _ 1.0, linkedin _ 0.6)

- **Pros**: más fino que la fusión union.
- **Contras**: complica explicabilidad ("¿por qué esta experiencia
  aporta 0.6 años en vez de 1.0?" el recruiter no va a entender),
  inconsistente con la realidad (una experiencia sucedió una sola
  vez, no "0.6 veces").
- **Descartada porque**: la fusión union-with-cv-primary-authoritative
  logra el mismo goal ("confiar más en el CV oficial") con mejor
  explicabilidad.

### E) On-demand sin persistencia (match_runs no existe)

- **Pros**: menos schema.
- **Contras**: no se puede compartir un ranking (link), no se puede
  auditar qué vieron los recruiters en una fecha, no se puede
  comparar runs sobre el mismo JD.
- **Descartada porque**: el recruiter necesita poder volver al
  ranking de ayer sin re-pagar LLM + recomputar.

### F) Must-have como filtro duro (excluye del resultado)

- **Pros**: lista final más "limpia".
- **Contras**: si el resolver de skills falló y un must-have no se
  detectó en el candidato, se esconde un buen match por un bug del
  catálogo. Silent false negatives.
- **Descartada porque**: preferimos mostrar con flag "failed
  must-have" en sección aparte; el recruiter puede ver el breakdown
  y detectar el catálogo stale.

---

## Consecuencias

### Positivas

- **Explicabilidad total**: cada score es descomponible y refutable
  contra las experiencias del candidato.
- **Determinístico**: dos runs sobre el mismo catálogo + mismas
  extracciones dan el mismo ranking. Facilita testing.
- **Sin LLM en el ranking**: costo cero adicional por run; solo el
  LLM de ADR-014 (cacheado).
- **Runs inmutables**: auditables, compartibles, comparables.
- **Abstracción `Ranker`**: si en el futuro queremos un `HybridRanker`
  que combine determinístico + embeddings, el seam está.

### Negativas

- **Dependemos fuertemente de la calidad del catálogo**. Una skill
  mal resuelta → years=0 → candidato penalizado injustamente. El
  `/admin/skills/uncataloged` de ADR-013 es crítico.
- **No captura sinónimos semánticos no aliasados**. Si el JD pide
  "React" y el CV dice "React.js", y el alias no está, fallamos.
  Mitigado por la UI de reconciliación.
- **No mide calidad/seniority dentro de una skill**. 5 años de
  senior = 5 años de junior en este modelo. Aceptable para F4;
  ADR futuro puede incorporar títulos o señales textuales.
- **El merge union-with-cv-primary-authoritative requiere heurística
  de duplicados** (company + title normalization + date overlap).
  Heurística imperfecta → puede duplicar o fusionar mal. Cubrir con
  tests adversariales.
- **`match_runs` crece sin techo**. Candidatos freeze en el tiempo.
  Política de retención: ADR futuro (o manual por ahora).

---

## Criterios de reevaluación

- Si el p95 de un run supera 5s con 1000 candidatos → reevaluar
  (¿scoring en SQL? ¿pre-agregación?).
- Si el recruiter reporta > 20% de runs donde el top-10
  "obviously wrong" según su juicio → reevaluar (¿embeddings como
  filtro previo? ¿features adicionales?).
- Si la tasa de `must_have_gate = 'failed'` por catálogo incompleto
  supera 30% → invertir en el resolver de ADR-013 antes que en el
  ranker.
- Si aparece requerimiento de ranking cross-tenant (improbable),
  toda la RLS cambia.

---

## Tests requeridos (TDD)

### Ranker determinístico

1. `test_single_skill_single_experience_exact_match` — 1 requirement
   React 3+, candidato con 3 años React → score 100, breakdown claro.
2. `test_overlapping_experiences_merged_not_summed` — candidato con
   React en dos trabajos solapados 2020-2022 y 2021-2023 → years = 3,
   no 4.
3. `test_gap_in_experiences_counted_correctly` — React 2018-2020 y
   2023-2024 → years = 3 (suma de ambos).
4. `test_side_project_excluded_from_years` — React solo en
   `kind='side_project'` → years = 0.
5. `test_education_excluded_from_years` — curso de React en
   `kind='education'` → years = 0.
6. `test_unresolved_skill_does_not_contribute` — experience_skills
   con `skill_id IS NULL` → no suma aunque el nombre raw coincida.
7. `test_must_have_failed_candidate_in_separate_section` —
   must-have React, candidato sin React → `must_have_gate='failed'`,
   total_score = 0, presente con flag.
8. `test_min_years_null_boolean_presence` — requirement sin min_years
   → años_ratio = 1.0 si presente, 0 si ausente.
9. `test_language_bonus_applied` — languages all matched → +5.
10. `test_language_missing_must_have_penalty` — -10.
11. `test_seniority_match_adjustment` — +5/-5 según match.

### Variant merging

12. `test_cv_primary_only_candidate` — sin linkedin_export, usa solo
    cv_primary.
13. `test_linkedin_only_candidate` — sin cv_primary, usa linkedin.
14. `test_duplicate_experience_cv_primary_wins_dates` — mismo job
    en ambas, fechas del cv_primary sobrescriben linkedin.
15. `test_non_duplicate_experiences_unioned` — 3 en cv_primary, 5
    en linkedin (distintas) → resultado 8.
16. `test_duplicate_heuristic_threshold` — overlap < 50% fechas →
    se consideran experiencias distintas (no merge).

### Performance

17. `test_100_candidates_under_3s_p50` — integration test con
    fixtures.
18. `test_pre_filter_excludes_candidates_without_musthave` — el
    filtro grueso reduce el universo antes del scoring.

### Persistencia + RLS

19. `test_match_run_is_immutable` — intentar UPDATE de
    breakdown_json post-inserción debe fallar (policy).
20. `test_match_run_rls_denies_cross_tenant` — user de tenant A no
    ve runs de tenant B.
21. `test_match_run_idempotent_same_inputs` — mismo job_query +
    mismo catálogo → mismos scores (determinismo).

---

## Notas de implementación

- Módulo: `src/lib/matching/` con `ranker.ts`,
  `variant-merger.ts`, `years-calculator.ts`, `score-aggregator.ts`.
- Un archivo ≤ 300 líneas, una función ≤ 50 líneas (regla del
  repo). El `DeterministicRanker` orquesta; la matemática vive en
  módulos puros testables.
- El sweep-line del §1 es la parte más sutil: tests adversariales
  con fechas mal formateadas, intervalos al día, intervalos con
  `end < start` (data bug), etc.
- La heurística de duplicados del §2 (company + title norm + date
  overlap) vive en `variant-merger.ts`. Cuando el merge decide
  fusionar, debe registrar la decisión en `diagnostics` para
  debugging.
- La API route `/api/matching/run` recibe `job_query_id` + filtros,
  dispara el run, retorna `match_run_id` + top-N inline. El
  breakdown completo es fetched via `/api/matching/runs/:id/results`
  paginado.
