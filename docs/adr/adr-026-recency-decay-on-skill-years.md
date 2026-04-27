# ADR-026 — Recency decay (half-life exponencial) en cálculo de años por skill

- **Estado**: Aceptado
- **Fecha**: 2026-04-27
- **Decisores**: Owner VAIRIX + Claude Code
- **Supersedes parcial**: ADR-015 §1 ("years totales sin recencia") y
  ADR-020 (la salida de `yearsForSkill` ya no se consume directa por
  el scorer; se aplica un factor multiplicativo de recencia)
- **Relacionado con**: ADR-015 (matching & ranking), ADR-020
  (side-project weighted years), ADR-022 (seniority-derived
  baseline), ADR-023 (role essentials),
  `src/lib/matching/years-calculator.ts`,
  `src/lib/matching/score-aggregator.ts`,
  `src/lib/matching/recency-decay.ts` (módulo nuevo)

---

## Contexto

`yearsForSkill()` devuelve hoy una **suma temporal sin recencia**: 5
años de Java entre 2005–2010 valen lo mismo que 5 años entre 2020–2025.
El scorer (`score-aggregator.ts`) consume ese número directamente y lo
divide contra `effectiveMinYears` para producir `years_ratio`.

### Incidente gatillante (2026-04-27)

Caso del owner: dev con 20 años de carrera, 5 años en Java entre
2005–2010, 0 años en Java desde entonces (15 años de gap). Para una
JD que pide "Senior Java" (baseline 3 años por ADR-022):

- `years = 5`
- `years_ratio = min(5/3, 1) = 1`
- contribuye full a Java como si fuera senior actual

La intuición del dominio dice lo contrario: hace 15 años que no toca
Java, no es ni junior hoy. El scorer está colapsando dos señales:
_"cuánto tiempo trabajó con X"_ vs _"qué tan vigente está su X"_.

Citado por el owner: _"al principio de mi carrera trabajé en Java
durante 5 años pero hace 15 que no trabajo con java. En su momento
puede que sea senior pero ahora no soy ni junior. La fecha de la
última vez que trabajó en esa tecnología tendría que ser algo a
relatar más cuando más tiempo pasó."_

## Decisión

**Introducir un factor multiplicativo de recencia (decay) sobre el
output de `yearsForSkill`, derivado de la fecha de último uso de la
skill y un half-life exponencial uniforme.**

```ts
// src/lib/matching/recency-decay.ts
export const HALF_LIFE_YEARS = 4;

export function decayFactor(yearsSinceLastUse: number, halfLife = HALF_LIFE_YEARS): number {
  if (yearsSinceLastUse <= 0) return 1; // ongoing or future-dated → no decay
  return Math.pow(0.5, yearsSinceLastUse / halfLife);
}

export function effectiveYearsForSkill(
  skillId: string,
  experiences: readonly MergedExperience[],
  options: { asOf: Date; halfLifeYears?: number },
): EffectiveYearsResult; // { rawYears, effectiveYears, lastUsed, yearsSinceLastUse, decayFactor }
```

Aplicación en `score-aggregator.ts`:

```ts
const eff = effectiveYearsForSkill(req.skill_id, candidate.merged_experiences, { asOf: now });
const years = eff.effectiveYears; // ← antes era yearsForSkill(...)
// ... ratio = min(years / effectiveMinYears, 1) ...
```

### Fórmula

```
yearsSinceLastUse = max(0, (asOf − lastUsed) / MS_PER_YEAR)
decayFactor       = 0.5 ^ (yearsSinceLastUse / HALF_LIFE_YEARS)
effectiveYears    = rawYears × decayFactor
```

Tabla de referencia con `HALF_LIFE_YEARS = 4`:

| Última vez usado    | decayFactor | 5 raw years → effective |
| ------------------- | ----------- | ----------------------- |
| Hoy (en curso)      | 1.000       | 5.00                    |
| Hace 2 años         | 0.707       | 3.54                    |
| Hace 4 años         | 0.500       | 2.50                    |
| Hace 8 años         | 0.250       | 1.25                    |
| Hace 15 años (caso) | 0.073       | 0.36                    |

Bajo el baseline senior (3 años, ADR-022) ese candidato pasa de
`ratio=1` a `ratio=min(0.36/3, 1) = 0.12`. La intuición se respeta.

### Definición de `lastUsed`

`MAX(end_date ?? asOf)` sobre las experiencias `kind='work'` o
`kind='side_project'` que mencionan la skill (con `skill_id` resuelto).
Razones:

- **Incluir side_project**: si el candidato sigue tocando la skill como
  hobby, está vigente aunque profesionalmente no lo trabaje. El
  weighting de ADR-020 (×0.25) ya penaliza la _cantidad_; el decay
  mide _cuán reciente_, son ortogonales.
- **`end_date = null` → `asOf`**: experiencia en curso = última vez
  usado = hoy → factor 1, sin decay.
- **education excluida** (consistente con ADR-015 / ADR-020).

### `asOf` determinístico

`asOf` se propaga desde `RankerInput.catalogSnapshotAt` (lo mismo que
`ranker.ts:31` ya usa como `now` para todos los cálculos de tiempo del
matcher). Garantías:

- Es un timestamp **persistido** en `job_queries.catalog_snapshot_at`.
- Re-ejecutar la misma `match_run` produce el mismo decay → el
  ranking es reproducible y auditable.
- `match_run.started_at` y `catalog_snapshot_at` están del orden de
  minutos/horas en operación normal; la pérdida de precisión es
  despreciable frente a un half-life de 4 años.

Decisión vinculante: **`effectiveYearsForSkill` recibe `asOf`
required en su API, sin default `new Date()`**. Esto fuerza a callers
a pasar un snapshot determinístico — no se puede consumir el módulo
de manera no-auditable.

### Reglas

- `decayFactor` solo se aplica al **`years_ratio`** del scorer.
- **`roleGateFailed` (ADR-023) sigue usando `yearsForSkill > 0`
  raw**: el axis gate es presencia binaria sobre la role essential,
  no recencia. Un candidato que tocó la tecnología hace 15 años pasa
  el gate (tiene cobertura del axis) pero su contribución al score
  por esa skill cae casi a cero por el decay. Las dos señales son
  ortogonales — bloquear por recencia en el gate cerraría la puerta
  a candidatos que el ratio ya está penalizando con justicia.
- **`mustHaveGateFailed` (ADR-015) usa `years_ratio > 0`**, que se
  computa sobre `effectiveYears`. Como `decayFactor > 0` siempre
  para `rawYears > 0` finitos, este gate es **inafectado en
  comportamiento**: si el candidato tocó la skill alguna vez, sigue
  pasando el must-have gate. Solo cambia cuánto contribuye al score.
- **`totalWorkYears` y `candidateSeniorityBucket` (score-aggregator
  §senioritySignal) NO aplican decay**: representan _carrera total_,
  no skill-specific. Un dev de 20 años de carrera total sigue siendo
  bucket `lead` para el delta de seniority match aunque su mix de
  skills haya cambiado.
- El `breakdown_json` persistido en `match_results` expone los
  componentes del decay para auditoría (ver "Implementación").
- `HALF_LIFE_YEARS = 4` es **uniforme**. No hay override por
  skill_family en este ADR. Si en el futuro una skill pivota más
  rápido (ej. frontend frameworks vs SQL), un ADR posterior puede
  agregar `skills.decay_half_life_years nullable` — el módulo ya
  acepta `halfLifeYears?` en options.

## Consecuencias

### Positivas

- El scorer respeta la **vigencia** de la skill, no solo su
  acumulación histórica. Resuelve el caso "ex-Java de hace 15 años
  no es senior Java".
- Determinismo y auditoría preservados: `asOf` persistido,
  `breakdown_json` muestra `raw_years`, `last_used`, `decay_factor`,
  `effective_years`. El reclutador puede ver _por qué_ un candidato
  con 5 años de X cayó al ranking.
- Backward compatible para presence: must-have gate y role-essential
  gate siguen permitiendo candidatos con cualquier exposición real
  a la skill — solo el peso cae con la antigüedad.
- Ortogonal a ADR-020 (weighting por kind): se compone sin doble
  contar.
- Sin schema change: implementación contenida en
  `src/lib/matching/recency-decay.ts` + `score-aggregator.ts` +
  el shape del `breakdown_json` (campo `jsonb` libre).

### Negativas / riesgos

- **Invalida rankings previos** de `match_runs` con candidatos cuya
  experiencia mayoritaria sea antigua. Es el comportamiento buscado;
  no hay rollback retroactivo automático (re-correr el match
  produce el orden nuevo). Existing `match_results` permanecen como
  snapshot histórico de su `started_at`.
- **`HALF_LIFE_YEARS = 4` es heurística** sin calibración con
  ground truth. La elección refleja la intuición del owner ("4 años
  parados es media-vida razonable de una skill técnica") y deja la
  constante aislada en un módulo. Ajustarlo es one-line.
- **No diferenciamos por skill family**: COBOL y React decaen al
  mismo ritmo. La realidad es que SQL casi no caduca y Frontend lo
  hace rápido. Aceptable arrancar uniforme; ADR futuro puede
  introducir overrides cuando haya evidencia.
- **Side projects vigentes pueden enmascarar gap profesional**:
  alguien que hace ~5 años no usa X profesionalmente pero tiene un
  side*project del año pasado mantiene `lastUsed` reciente. El peso
  ×0.25 de ADR-020 reduce el `rawYears` pero no la \_vigencia*. Para
  el caso del owner es correcto (mantiene la skill viva); para
  detectar "ex-pro reconvertido" haría falta otra señal.

### Descartadas

- **Linear decay con cutoff** (full hasta N años, lineal a 0 en M
  más): tiene cliffs arbitrarios y dos parámetros sin justificación
  domain.
- **Step function por buckets** (<2y=full, 2–5y=80%, 5–10y=40%, etc):
  igual de arbitrario y discontinuo — un candidato con
  `lastUsed = 2020-12-31` salta de bucket cuando cruza año nuevo.
- **Tabla `skills.decay_half_life_years` desde el día 1**: agrega
  schema change y override management sin demanda. La constante
  uniforme cubre el caso reportado; subir overrides requiere
  evidencia que aún no tenemos.
- **Aplicar decay al gate (must-have / role-essential)**: bloquearía
  candidatos por antigüedad antes de que el scoring tenga oportunidad
  de penalizarlos. Doble penalización + falsos negativos. La
  separación gate-binario / scoring-continuo es la del ADR-023.
- **Aplicar decay a `totalWorkYears`**: rompe la semántica de
  "seniority de carrera total" (¿es lead un veterano de 20 años cuya
  última skill activa es vieja?). El delta de seniority match es por
  candidato, no por skill — fuera del scope de este cambio.
- **`asOf = new Date()` (wallclock)**: viola el invariante de
  determinismo de ADR-015. Re-correr el match produciría rankings
  distintos en función del momento de re-ejecución. No.

## Implementación

- `src/lib/matching/recency-decay.ts` — módulo nuevo con `HALF_LIFE_YEARS`,
  `decayFactor`, `lastUsedFor`, `effectiveYearsForSkill`. Funciones
  puras, `asOf` required.
- `src/lib/matching/score-aggregator.ts`:
  - importa `effectiveYearsForSkill`, lo usa en lugar de
    `yearsForSkill` para el cálculo del `years_ratio`.
  - `roleGateFailed` mantiene `yearsForSkill(...) > 0` (raw) — comentario
    explicando.
  - `totalWorkYears` / `candidateSeniorityBucket` sin cambio.
  - Popula los nuevos campos del `RequirementBreakdown` con los
    componentes del decay.
- `src/lib/matching/types.ts` — `RequirementBreakdown` gana
  `raw_years: number`, `last_used: string | null` (ISO `YYYY-MM-DD`),
  `decay_factor: number`. `candidate_years` mantiene su nombre y
  ahora carga el valor `effective_years` (es lo que se divide por
  el baseline para el ratio — backward compatible para readers que
  lo usaban como "lo que el ratio computó").
- `src/lib/matching/recency-decay.test.ts` — tests adversariales
  (caso 15-yr-old Java, ongoing experience, asOf vs wallclock,
  latest end_date, side_project en `lastUsed`, half-life exacto,
  data bug clamping, skill ausente).
- `src/lib/matching/score-aggregator.test.ts` — tests nuevos en
  describe `ADR-026 recency decay`: regresión de must-have gate
  (candidato viejo sigue pasando), regresión de role-essential gate
  (idem), exposición de `raw_years`/`last_used`/`decay_factor` en
  el breakdown, escenario hero (ex-Java vs Java actual ranking
  invertido).
- `docs/use-cases.md` UC-11 — agregar acceptance criterion
  `test_matcher_decays_stale_experience` en la lista existente.

No requiere migración de schema, ni cambios al prompt de
descomposición, ni cambios a la API HTTP.
