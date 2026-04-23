# ADR-025 — Default view de `/matching/runs/:id` filtra por `must_have_gate = 'passed'`

- **Estado**: Aceptado
- **Fecha**: 2026-04-23
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: ADR-015 (matching & ranking), ADR-016
  (complementary signals / rescue bucket), ADR-021 (OR-groups), ADR-023
  (role_essentials gate), `src/app/(app)/matching/runs/[id]/page.tsx`,
  `src/app/api/matching/runs/[id]/results/route.ts`.

---

## Contexto

Hasta hoy `match_results` guardaba un row por cada candidato que el
**pre-filter** admitía (o sea, candidatos con al menos un resolved
skill_id coincidente con un must-have). Dentro de ese set el scorer
clasificaba `must_have_gate ∈ {passed, failed}`:

- `passed`: cubre TODOS los grupos must-have con años > 0.
- `failed`: al menos un grupo must-have con años = 0 (pero tiene otros
  grupos cubiertos — por eso llegó al ranker).

La página `/matching/runs/:id` mostraba ambos en una única tabla
ordenada por `rank`, diferenciando por badge `passed`/`failed`. La
racional original era diagnóstica: el breakdown de un `failed`
expone qué axis le faltó al candidato, lo que es útil para detectar
bugs de catálogo / extracción (exactamente el ciclo que nos llevó a
ADR-024 con el caso Bortoli #120/failed).

Pero en uso real eso choca con la mental model del recruiter: el
listado se lee como "shortlist del JD", y mezclar 50 passed + 100
failed obliga a filtrar visualmente cada vez. Además, los failed con
resolución parcial pero años = 0 rara vez son accionables (son ruido
para quien recluta, no para quien debuggea).

## Opciones evaluadas

### A. Mostrar todos los rows y sumar un toggle "hide failed" en UI

**Pros**: preserva el valor diagnóstico, la decisión queda en el
usuario cada vez.
**Contras**: complejidad en UI (estado en URL o localStorage),
inconsistencia entre usuarios. El comportamiento por defecto sigue
siendo "mostrar todo", que es el que el owner reportó como ruidoso.

### B. Filtrar por default `must_have_gate = 'passed'`, aceptar que los failed sólo son accesibles por consulta SQL directa (o rescue bucket si aplica)

**Pros**: la UI queda limpia, alineada con la semántica de "shortlist".
El rescue bucket (ADR-016) ya cubre el caso ortogonal "skill sólo en
parsed_text, no en structured experience_skills". Los gate-failed
con resolución parcial NO tienen un bucket dedicado pero tampoco son
el foco — si hacen falta, siempre queda la DB.
**Contras**: perdemos el breakdown de failed en UI. Un futuro bug de
catálogo similar al de Bortoli NO aparecería como "rank #120 failed
con React-Native en su breakdown"; habría que detectarlo por fuera
(monitoring del % unresolved, o diff de top-N entre runs).

### C. Filtro por default + toggle opt-in (`?include_failed=1`)

Balance entre A y B.

**Pros**: cubre ambos casos.
**Contras**: mayor superficie (URL param en page + query param en API),
pospone la decisión real sobre cuál es el comportamiento canónico.

## Decisión

**Opción B.** El default view del listado (`/matching/runs/:id` + el
API JSON `GET /api/matching/runs/:id/results`) filtra
`must_have_gate = 'passed'`. Los rows `failed` siguen persistidos
en `match_results` (no se borran) para auditoría en DB; desde UI no
son accesibles.

Si en el futuro emerge un caso claro donde el breakdown de failed sea
recurrentemente útil, se revisita y se agrega el toggle de opción C.

Cambios asociados (commits `7f10743`, `99388b3`):

1. `src/app/(app)/matching/runs/[id]/page.tsx` — el query SQL suma
   `.eq('must_have_gate', 'passed')`. El MetaCell del header pasa de
   `results shown` → `passed`.
2. `src/app/api/matching/runs/[id]/results/route.ts` — mismo filtro
   aplicado al endpoint para que API y UI vean la misma shortlist.
3. `src/app/(app)/matching/runs/[id]/job-query-panel.tsx` (nuevo) —
   panel arriba del listado con el `raw_text` original del JD
   (collapsible, guardado por `raw_text_retained`) y los
   requirements decompuestos como tags (agrupados por
   `alternative_group_id` para OR-groups de ADR-021). También muestra
   `role_essentials` y `unresolved_skills` en secciones separadas.

## Consecuencias

**Positivas:**

- El listado por default se lee como shortlist accionable. El
  contador del header refleja la count de la lista (ya no hay
  discrepancia entre "X resultados" y "sólo Y pasan").
- El panel del JD arriba del listado hace que cada run sea
  auto-contenido: el usuario no necesita ir al `job_query` padre
  para ver qué pidió el decomposer, qué resolvió y qué quedó
  unresolved.

**Negativas / riesgos:**

- **Pérdida de trazabilidad diagnóstica desde UI** para el caso de
  gate-failed con resolución parcial. El ciclo "observo ranking raro
  en UI → abro el breakdown del failed → detecto bug de catálogo"
  deja de ser viable. Mitigación: el % de gate-failed queda
  disponible en DB (`select count(*) filter (where must_have_gate =
'failed') from match_results where match_run_id = ?`) y se puede
  agregar a `/matching/runs/:id` como contador si la necesidad
  vuelve.
- **Count discrepancy entre `match_runs.candidates_evaluated` y
  la tabla visible** es esperable. El header lo refleja con el label
  `passed` y el contador `N/M` (N visibles de M persistidos).
- El test de schema del API (`route.test.ts`) no cubre el filtro —
  se agrega un regression test en `route.filter.test.ts` que
  documenta el invariante.

## Referencias

- ADR-015 §Consecuencias — "fully-unresolved groups no fallan el gate
  pero cuentan 0".
- ADR-016 — rescue bucket (bucket separado para "skill sólo en
  parsed_text").
- ADR-023 — role_essentials gate conjuntivo.
- Commits `7f10743` (filtro + panel JD), `99388b3` (tag layout inline).
