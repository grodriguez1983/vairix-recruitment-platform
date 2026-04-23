# ADR-022 — Baseline `min_years` derivado de la seniority del JD

- **Estado**: Aceptado
- **Fecha**: 2026-04-23
- **Decisores**: Owner VAIRIX + Claude Code
- **Supersedes parcial**: ADR-015 §3 "Scoring por requirement" (la
  rama `min_years: null` ahora no es _siempre_ binaria — depende de
  `jobQuery.seniority`)
- **Relacionado con**: ADR-014 (decomposition), ADR-015 (matching &
  ranking), ADR-020 (side-project weighted years), ADR-021 (OR
  groups), `src/lib/matching/score-aggregator.ts`,
  `src/lib/matching/seniority-defaults.ts`

---

## Contexto

El scorer de matching (ADR-015 §3) computa por cada requirement un
`years_ratio` y pondera por `must_have ? 2 : 1`. Cuando el
decomposer emite `min_years: null` — el caso típico para JDs que no
dicen "3+ años de X" literal — el scorer entra a la rama de
**presencia binaria**:

```ts
ratio = years > 0 ? 1 : 0;
```

Esta rama fue correcta mientras el único caso de `null` era "el JD
de verdad no me dio señal de seniority". Pero con la normalización
del prompt v5 (ADR-021) el LLM se volvió correctamente conservador y
casi nunca inventa un `min_years` numérico si no lo lee textual en
el JD — la mayoría de los requirements salen con `min_years: null`
incluso cuando la JD tiene seniority "senior" explícita en otro campo.

### Incidente gatillante (2026-04-23)

JD `2d4d6faa-4793-4b04-b581-e9819726f1b9` — "Senior Frontend":

```
Seniority: senior
Requirements (post-decompose v5):
  - React      (must_have: false, min_years: null)
  - TypeScript (must_have: false, min_years: null)
  - Next.js    (must_have: false, min_years: null)
  - ...
```

Ranking producido:

| Rank | Candidato         | React exp | Score |
| ---- | ----------------- | --------- | ----- |
| 1    | **Lucas Pereira** | 4 meses   | 48.75 |
| 5    | **Hernán Garzón** | 7.48 años | 37.50 |

Causa raíz: con `min_years: null` y la rama binaria, Lucas (4 meses
React) y Hernán (7.48 años) aportan **la misma** contribución al
score por React (ratio=1). Lucas sube por encima porque matchea
más skills superficialmente (token exposure) y por el `+5` de
seniority match (su total work years lo pone en bucket senior por
acumulación). La señal "senior" del JD no propaga a ningún
per-skill baseline.

Feedback explícito del owner: _"Lucas Pereira no es un buen
candidato, apenas tiene meses en cada tecnología y necesito que sea
senior. ¿Esto está mal que no puse bien el llamado o falta un
criterio de seniority?"_

## Decisión

**Cuando la JD declara una seniority concreta y el requirement no
trae `min_years` explícito, el scorer usa un baseline canónico
derivado de la seniority.**

```ts
// src/lib/matching/seniority-defaults.ts
const DEFAULTS: Record<Exclude<Seniority, 'unspecified'>, number> = {
  junior: 1,
  semi_senior: 2,
  senior: 3,
  lead: 5,
};

export function defaultMinYearsFor(seniority: Seniority): number | null {
  if (seniority === 'unspecified') return null;
  return DEFAULTS[seniority];
}
```

Aplicación en `score-aggregator.ts`:

```ts
const seniorityBaseline = defaultMinYearsFor(jobQuery.seniority);
const effectiveMinYears = req.min_years ?? seniorityBaseline;

if (req.skill_id === null) {
  ratio = 0;
} else if (effectiveMinYears === null || effectiveMinYears === 0) {
  // Binary fallback: JD truly silent on seniority, or explicit min_years=0.
  ratio = years > 0 ? 1 : 0;
} else {
  ratio = Math.min(years / effectiveMinYears, 1);
}
```

### Reglas

- El `min_years` explícito del requirement **siempre gana** sobre el
  baseline. El baseline solo aplica cuando `min_years === null`.
- `seniority === 'unspecified'` → baseline es `null` → rama binaria
  sigue activa. Sin seniority signal no hay piso justificado; no
  inventamos uno.
- Los valores (1/2/3/5) se eligen como el **lower bound** de cada
  bucket de seniority ya existente en el scorer
  (<2 junior, 2–5 semi*senior, 5–10 senior, 10+ lead), interpretado
  como "para ser competente \_en* este bucket, esperamos al menos N
  años de la skill pivote". El ratio satura en 1 arriba del
  baseline, así que no penaliza overqualification.
- Los baselines no son por-skill. Si en el futuro una skill necesita
  un piso distinto (ej. "AWS: 2 años aunque seas senior"), el
  decomposer debe emitir `min_years: 2` explícito en ese
  requirement.

### Efecto en el incidente

Con baseline = 3 (senior):

- Lucas (React 4m): ratio = min(0.33/3, 1) = 0.11
- Hernán (React 7.48y): ratio = min(7.48/3, 1) = 1

Los tests nuevos en `score-aggregator.test.ts`
(`test_seniority_derived_baseline_lucas_vs_hernan_scenario`) cubren
esta diferencia explícitamente.

## Consecuencias

### Positivas

- El scorer **respeta la seniority declarada en el JD** sin depender
  de que el decomposer inyecte números que el LLM no leyó en el
  texto.
- Separa dos señales que estaban colapsadas: _"este candidato sabe X"_
  (binario) vs _"este candidato es senior en X"_ (continuo). La
  segunda era invisible en la mayoría de los JDs reales.
- Backward compatible: requirements con `min_years` explícito
  siguen comportándose igual (test
  `test_explicit_min_years_wins_over_seniority_default`). JDs con
  seniority=`unspecified` mantienen la rama binaria
  (`test_seniority_unspecified_keeps_binary_null_behavior`).
- Elimina el incentivo perverso de "token exposure": ya no basta
  con tocar una tecnología un mes para cobrar ratio=1.

### Negativas / riesgos

- **Candidatos con menos años en cada skill pero con muchas skills
  caen en el ranking.** Esto es el comportamiento buscado para roles
  senior, pero puede molestar en búsquedas mixtas. Mitigación: si
  una JD legítimamente quiere "polyvalent junior con un año en
  cada cosa", el campo `seniority: 'junior'` ya baja el baseline a
  1, que sigue siendo menos punitivo.
- **Los baselines 1/2/3/5 son una heurística, no calibrada con
  ground truth.** Futuros ADRs podrán ajustarlos en base a
  matching_runs con outcomes etiquetados (aplicación confirmada /
  rechazada). El valor está en aislar la decisión en un módulo
  (`seniority-defaults.ts`) — cambiar la constante es una línea.
- **Invalida rankings previos** de `job_queries` con seniority
  concreta: re-ejecutar un match produce un orden diferente. No es
  breaking para la DB (solo se re-escribe `match_runs`).

### Descartadas

- **Forzar al decomposer a inventar `min_years` desde la seniority**:
  viola la separación ADR-014 entre "lo que dice el JD" y "cómo lo
  interpreta el scorer". Si el LLM empieza a fabricar números sin
  apoyo textual, la auditoría del breakdown pierde valor.
- **Subir el peso `must_have` para compensar**: no ataca la causa
  (ratio binario) y rompe las comparaciones cross-JD.
- **Penalizar más fuerte en el delta de seniority match**: el delta
  opera sobre el **score total** (±5), no sobre cada skill. Inflarlo
  a ±20 no arregla el ordenamiento cuando los scores base salen
  pegados por la rama binaria.

## Implementación

- `src/lib/matching/seniority-defaults.ts` — módulo nuevo con la
  función pura `defaultMinYearsFor`.
- `src/lib/matching/score-aggregator.ts` — computa
  `seniorityBaseline` una vez al inicio y lo aplica vía
  `req.min_years ?? seniorityBaseline`.
- `src/lib/matching/score-aggregator.test.ts` — 6 tests nuevos en
  el describe `ADR-022 seniority-derived min_years baseline`:
  cobertura de cada bucket, saturación, regresión del explicit
  `min_years`, regresión de `unspecified`, y escenario hero
  Lucas-vs-Hernán.

No requiere migración de schema DB ni cambios en el prompt de
decomposición.
