# ADR-030 — Bajar `HALF_LIFE_YEARS` de 4 a 2 (recalibración del decay)

- **Estado**: Aceptado
- **Fecha**: 2026-05-18
- **Decisores**: Owner VAIRIX + Claude Code
- **Supersedes parcial**: ADR-026 §Decisión (constante
  `HALF_LIFE_YEARS = 4`). El resto de ADR-026 (formula, scope del
  decay, `asOf` determinístico, exclusión del gate, side_project en
  `lastUsed`, etc.) se mantiene íntegro.
- **Relacionado con**: ADR-022 (seniority baselines), ADR-023 (role
  essentials & axis gate), `src/lib/matching/recency-decay.ts:34`,
  `src/lib/matching/score-aggregator.ts`.

---

## Contexto

ADR-026 introdujo el factor multiplicativo de recencia con
`HALF_LIFE_YEARS = 4`, explícitamente marcado como "heurística sin
calibración con ground truth" (ADR-026 §Negativas). El plan era
ajustar la constante cuando hubiera evidencia de campo.

### Incidente gatillante (2026-05-18)

JD del owner contra el corpus dev: _"quiero candidatos senior full
stack con larabel/php con react y redux, tienen que ser senior en
todo"_. Requirements decompuestos: `Laravel`, `PHP`, `React`, `Redux`
(must-have × 4).

Top-1 del ranking: **Emiliano Mateu**, score 61.3, **passed**, con el
siguiente breakdown observado en `/matching/runs/:id`:

| Skill   | YEARS | LAST USED | RATIO | STATUS  | Notas                  |
| ------- | ----- | --------- | ----- | ------- | ---------------------- |
| Laravel | 0.8   | 7y ago    | 0.25  | partial | raw≈2.7y (0.8 / 0.297) |
| PHP     | 3.0   | 7y ago    | 1.00  | match   | raw≈10y (3.0 / 0.297)  |
| React   | 10.5  | <1mo ago  | 1.00  | match   | activo, sin decay      |
| Redux   | 0.0   | —         | 0.00  | missing | unresolved (no falla)  |

Cita del owner: _"dice que no toca php ni laravel hace 7 años pero le
da un ratio de 1 en lo que es php"_.

### Aritmética del caso

Con `HALF_LIFE_YEARS = 4` y `last_used = 7y ago`:

```
decay_factor = 0.5 ^ (7 / 4) ≈ 0.297
effective    = raw × 0.297
```

- PHP raw ≈ 10 años (sumadas las experiencias 2014–2018 visibles + "+3"
  no expuestas en la tabla principal) → `effective ≈ 3.0` →
  `ratio = min(3.0 / 3, 1) = 1.00` contra el baseline senior=3 de
  ADR-022.
- Laravel raw ≈ 2.7 años → `effective ≈ 0.8` → `ratio ≈ 0.27`.

La fórmula está actuando correctamente; el bug es de **calibración**:
con suficiente raw, un decay de medio-vida 4 deja el effective
todavía por encima del piso senior aún después de 7 años de stale. La
señal "no toca esta tecnología hace casi una década" se está perdiendo
en el ratio.

## Decisión

**Bajar `HALF_LIFE_YEARS` de `4` a `2`** en
`src/lib/matching/recency-decay.ts:34`.

```diff
- export const HALF_LIFE_YEARS = 4;
+ export const HALF_LIFE_YEARS = 2;
```

Ningún otro cambio: la fórmula, el contrato de `asOf` determinístico,
la exclusión del gate (axis y must-have siguen usando raw), la
inclusión de `side_project` en `lastUsed`, y la exposición de
componentes (`raw_years`, `last_used`, `decay_factor`) en el
`breakdown_json` se preservan.

### Tabla de referencia comparativa

`decayFactor` por años desde `lastUsed`:

| Años stale | HALF_LIFE=4 (ADR-026) | HALF_LIFE=2 (ADR-030) |
| ---------- | --------------------- | --------------------- |
| 0 (hoy)    | 1.000                 | 1.000                 |
| 1          | 0.841                 | 0.707                 |
| 2          | 0.707                 | 0.500                 |
| 3          | 0.595                 | 0.354                 |
| 4          | 0.500                 | 0.250                 |
| 5          | 0.420                 | 0.177                 |
| 7          | 0.297                 | 0.088                 |
| 10         | 0.177                 | 0.031                 |
| 15         | 0.073                 | 0.005                 |

Efecto sobre el caso Emiliano (asumiendo mismos raw):

| Skill   | raw  | last_used | effective (h=4) | ratio (h=4) | effective (h=2) | ratio (h=2) |
| ------- | ---- | --------- | --------------- | ----------- | --------------- | ----------- |
| PHP     | 10.0 | 7y        | 2.97            | **1.00**    | 0.88            | **0.29**    |
| Laravel | 2.7  | 7y        | 0.80            | 0.27        | 0.24            | 0.08        |
| React   | 10.5 | <1mo      | 10.46           | 1.00        | 10.42           | 1.00        |

PHP cae de match perfecto a `partial`. El ranking total de Emiliano
cae proporcional (PHP era una de las 4 contribuciones must-have al
score 61.3).

### Casos de borde recalibrados (sanity checks)

- **Senior activo con 8 años de React, ongoing**: raw=8, last_used
  = hoy → factor=1 en ambos → effective=8, ratio=1. Sin cambio.
- **Senior con 8 años de React, 1 año sabático**: raw=8, last_used=1y
  ago → h=4 factor=0.841, effective=6.73, ratio=1.0; h=2
  factor=0.707, effective=5.66, ratio=1.0. Sin cambio efectivo (sigue
  arriba del baseline 3).
- **Mid-level con 2 años de Vue, 2 años sin tocarla**: raw=2,
  last_used=2y ago → h=4 effective=1.41, ratio=0.47; h=2
  effective=1.0, ratio=0.33. Caída moderada — coherente con "está
  oxidado".
- **Junior con 1 año de React, 3 años sin tocarla**: raw=1,
  last_used=3y ago → h=4 effective=0.60, ratio=0.20; h=2
  effective=0.35, ratio=0.12. Drop más fuerte — para un junior con
  exposición corta y vieja, la penalización es justa.
- **Ex-COBOL 5 años entre 2005-2010**: raw=5, last_used=15y ago →
  h=4 effective=0.36, ratio=0.12; h=2 effective=0.025, ratio=0.008.
  Ya estaba bajo con h=4; con h=2 prácticamente cero. Ok.

## Consecuencias

### Positivas

- Resuelve el caso de dominio reportado: candidatos con stack legacy
  mayoritario (acumulación alta de raw_years pero sin uso reciente)
  ya no obtienen `ratio=1` contra JDs senior.
- Mantiene la separación gate-binario / scoring-continuo de ADR-023:
  el axis gate y el must-have gate siguen pasando con cualquier
  exposición raw > 0, solo cambia cuánto pesa.
- Sin schema change, sin migración, sin invalidar `match_runs`
  históricos (son snapshots inmutables; re-correr produce el orden
  nuevo bajo la nueva calibración).
- Sigue siendo una constante aislada: si la calibración resulta muy
  agresiva con más casos, retroceder a `h=3` es one-line.

### Negativas / riesgos

- **Penaliza más a candidatos con sabáticos cortos**: 2-3 años fuera
  del mercado tienen un impacto más visible. Para un perfil senior con
  raw alto sigue siendo absorbible (el effective queda sobre el baseline);
  para juniors/mids es más doloroso. Aceptable: el reclutador puede
  releer el `last_used` en el breakdown.
- **Skills lentas (SQL, Bash, Linux) sufren la misma media-vida que
  frontend frameworks**: ADR-026 ya anticipó este gap. La heurística
  uniforme sigue sin distinguir por familia. Si se vuelve un problema,
  ADR futuro puede introducir `skills.decay_half_life_years` (el
  módulo ya soporta `halfLifeYears?` en options).
- **Invalida heurística existente del reclutador para leer los
  ratios**: los rankings absolutos cambian. Los relativos (orden
  entre candidatos) deberían moverse poco salvo donde la antigüedad
  era el factor decisivo — que es exactamente donde queríamos cambiar.
- **No hay ground truth todavía** para validar que h=2 es el "correcto"
  vs h=2.5 o h=3. La elección refleja la intuición del owner sobre el
  caso PHP/Laravel y la tabla de referencia: 7y stale ≈ 9% del raw es
  más cercano a "ya no es la persona que era" que el 30% de h=4.

### Descartadas

- **Half-life=3** (intermedio): a 7y daría factor=0.198 →
  effective≈2.0 → ratio=0.66. Sigue siendo "match parcial alto" para
  alguien que no tocó la skill hace 7 años. Insuficiente para el caso
  reportado.
- **Cutoff duro sobre `years_since_last_use`** (ej. capear ratio a
  0.5 si > 5y): introduce un cliff arbitrario en la curva (mismo
  problema que ya descartó ADR-026 §Descartadas para el linear decay
  con cutoff). El parámetro adicional necesitaría justificación
  propia y produce discontinuidades.
- **Override por skill_family desde ahora**: agregar
  `skills.decay_half_life_years` para distinguir COBOL vs React
  introduce schema + management overhead sin evidencia de demanda. La
  uniforme con h=2 cubre el caso reportado; los overrides quedan
  para cuando aparezca un caso donde h=2 sea claramente excesivo.
- **Re-introducir wallclock `asOf`**: descartado en ADR-026; sigue
  vetado por determinismo.

## Implementación

- `src/lib/matching/recency-decay.ts:34` — cambio one-liner del valor
  de `HALF_LIFE_YEARS`.
- `src/lib/matching/recency-decay.test.ts` — los tests que pin-ean
  factores numéricos exactos (`0.5` a 4y, `0.707` a 2y, etc.) deben
  re-anclarse a los valores nuevos. Mantener la lógica adversarial
  (caso 15-yr, ongoing, edge cases) — solo cambian las constantes
  esperadas.
- `src/lib/matching/score-aggregator.test.ts` — revisar el describe
  `ADR-026 recency decay`: el test del escenario hero ("ex-Java vs
  Java actual") probablemente sigue verde porque la inversión de
  ranking se preserva con cualquier half-life razonable; los tests
  que assert-ean ratios numéricos puntuales pueden necesitar update.
- `docs/use-cases.md` UC-11 — sin cambios (los acceptance criteria
  son cualitativos, no asumen valor específico de half-life).
- `docs/spec.md` — sin cambios (no menciona el valor concreto).

No requiere migración de schema, ni cambios al prompt de descomposición,
ni cambios a la API HTTP, ni cambios al `breakdown_json`. Los
`match_runs` previos persisten como snapshots de su calibración —
re-correr un job_query existente produce el orden nuevo bajo h=2.

### Validación esperada

Re-correr el JD del incidente (`larabel/php + react + redux senior`)
contra el mismo corpus dev y verificar:

1. Emiliano Mateu cae del rank #1: PHP `ratio: 1.00 → 0.29`, Laravel
   `ratio: 0.27 → 0.08`. Si tenía 61.3 con esos dos en max,
   recalibrado debería rondar 30-40.
2. Candidatos con PHP/Laravel **activos** (`last_used < 2y`) suben
   relativo a los stale legacy.
3. React con `last_used <1mo` sigue intacto: ratio=1.00.

Sin acceptance numérico estricto — la calibración de constantes es
exactamente el tipo de decisión que el ADR-026 §Negativas marcó como
"empírica". Próxima iteración (sin ADR salvo cambio estructural):
seguir observando casos reales y, si emerge un sesgo nuevo, ajustar.
