# ADR-035 — Override de ResolvedDecomposition por match run

- **Estado**: Propuesto
- **Fecha**: 2026-05-22
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: ADR-014 (job-description-decomposition), ADR-015
  (matching-and-ranking), ADR-021 (alternative-group-id), ADR-034
  (FE-driven chunked matching)

---

## Contexto

El flujo actual de `/matching/new` muestra el resultado de la
decomposición (`ResolvedDecomposition`) como read-only. Tras correr
con JDs reales, los recruiters necesitan ajustar el set extraído por
el LLM antes de ejecutar el match:

- subir o bajar `min_years` por requirement,
- destildar `must_have` para suavizar el pre-filter,
- eliminar un requirement (típicamente uno que el LLM marcó como
  must-have pero que el recruiter sabe que no debe excluir).

Estos ajustes son **por run**: el mismo JD puede correrse mañana con
otros criterios. No son metadata permanente del `job_query`.

Dos opciones obvias colisionan con invariantes existentes:

1. **PATCH a `job_queries.resolved_json`** — el trigger SQL de ADR-014
   permite mutar `resolved_json` (es la columna del re-resolve contra
   el catálogo). Pero `job_queries` se comparte por `content_hash`:
   si recruiter A edita su resolved_json, el siguiente que pegue el
   mismo JD recibe los edits de A. Cache-poison de facto. Aunque RLS
   hoy oculta filas cross-user, el UNIQUE de `content_hash` impide
   que B inserte su propia copia: el problema se manifiesta de otra
   forma (B no puede decomposicionar). Romper el modelo de cache
   para una feature de UX es una decisión grande sin necesidad.

2. **Crear una `job_query` nueva por edición** — rompe el contrato de
   cache (hash → 1 decomposición), introduce filas sin LLM call con
   `prompt_version`/`model` posiblemente sintéticos, y multiplica las
   filas sin valor de auditoría.

## Decisión

El override viaja **dentro del request a `/api/matching/run/start`** y
se persiste como snapshot inmutable en `match_runs`:

- `match_runs` gana una columna `effective_resolved_json jsonb`. Es
  el `ResolvedDecomposition` que efectivamente corrió el match —
  igual a `job_queries.resolved_json` cuando no hay override, igual
  al override cuando sí lo hay. Se sella al crear el run y entra en
  la lista de identity columns frozen del trigger
  `enforce_match_runs_state_machine`.
- `job_queries.decomposed_json` y `resolved_json` siguen siendo el
  output puro del LLM + resolve catálogo. **No los toca el override**.
- `startMatchRun` acepta `resolvedOverride?: ResolvedDecomposition` y
  valida que el override sea un **subset** del resolved original.

### Regla de subset (validación defensiva)

El override es admisible si y solo si:

1. Para cada requirement del override existe un requirement en el
   resolved original con el **mismo** `skill_id`+`alternative_group_id` +`category`+`skill_raw`+`evidence_snippet`. La identidad del
   requirement la fija el LLM; el recruiter solo edita parámetros.
2. Los únicos campos editables por requirement son `must_have`,
   `min_years`, `max_years`.
3. El override puede **omitir** requirements del original (eliminar),
   pero no agregar nuevos.
4. `seniority`, `languages`, `notes`, `role_essentials` se aceptan
   solo si coinciden con el original. (Pase actual: no se editan
   desde la UI. Se valida igual para cerrar el contrato — si en una
   iteración futura se vuelven editables, será un cambio de ADR
   explícito.)

Cualquier violación → `/start` responde `400 invalid_override`.

Esta regla preserva el invariante de auditoría de ADR-014: lo que
corrió el recruiter es siempre **derivable** del output del LLM +
una secuencia de ediciones documentadas (cuáles requirements
omitidos, cuáles parámetros movidos).

### Por qué snapshot y no solo log

`match_runs` ya es inmutable post-close (ADR-015 §5). Persistir
`effective_resolved_json` en la fila convierte al run en
autocontenido: para reproducir o auditar un run, no hace falta
correlacionar `match_runs.started_at` con cambios al `job_queries`
o logs externos. El blob es chico (decenas de KB) y no degrada
performance de las queries existentes (todas filtran por
`match_run_id`).

## Consecuencias

### Positivas

- Cache de `job_queries` intacto. Cero cache-poison cross-user.
- Audit trail completo en `match_runs`: cada run "sabe" con qué set
  efectivo corrió.
- El override es opcional y per-call. Cambio mínimo de superficie:
  un campo nuevo en el zod de `/start`, un input en el panel del FE.
- Regla de subset previene que el endpoint se vuelva una vía
  alterna para inyectar requirements arbitrarios (ej. saltarse la
  validación del LLM).

### Costos

- Una columna jsonb más en `match_runs`. Los runs históricos
  (pre-migración) quedan con `effective_resolved_json = null`; se
  trata como "legacy, sin override conocido — usar
  `job_queries.resolved_json` del run". Los consumers downstream
  (UI de `/matching/runs/:id`) deben aceptar el null como fallback.
- La validación de subset requiere comparar requirements del
  override contra el resolved original. Es CPU local, O(n) sobre
  pocas decenas de requirements; no se justifica un fast-path.

### Cambios al schema

Migración aditiva:

- `alter table match_runs add column effective_resolved_json jsonb`.
- Extender el state-machine trigger para freezar la columna siempre
  (identity, no solo post-close): el snapshot se sella al crear el
  run.

### Cambios al contrato API

`POST /api/matching/run/start`:

- Body extendido (opcional): `{ job_query_id, resolved_override?:
ResolvedDecomposition }`.
- Nuevo error: `400 invalid_override` con `issues[]` describiendo
  qué requirement violó la regla de subset.
- Backward-compat: requests sin `resolved_override` se comportan
  idénticamente a hoy.

## Alternativas consideradas

### A. PATCH a `job_queries.resolved_json`

Rechazada — cache cross-user (ver Contexto §1).

### B. Crear `job_query` derivado por edición

Rechazada — rompe contrato de cache + ensucia metadata LLM.

### C. Persistir el delta (lista de ediciones) en vez del resolved completo

Rechazada — leer la decomposición efectiva requeriría replicar la
lógica de aplicación del delta en cada consumer (UI de runs, reports,
debug). El blob completo es más simple y la diferencia de tamaño es
marginal.

### D. Sin validación de subset (override arbitrario)

Rechazada — convierte `/start` en una API de creación de
ResolvedDecomposition desligada del LLM. Pierde la garantía de
ADR-014 de que cada match es derivable de un decomposed_json
auditado.

## Notas de implementación

- La UI editable es deliberadamente parcial en este pase:
  `requirements` editables (min_years, must_have, eliminar), el
  resto read-only. `seniority`/`languages`/`role_essentials` quedan
  fuera de scope; si entran después, se actualiza la regla de
  subset y se notea en este ADR.
- Validación del override vive en el service (`startMatchRun`), no
  en el zod del route: la regla compara contra el `loaded.resolved`
  que solo el service tiene. El zod solo valida la shape.
- El campo `effective_resolved_json` lo usan también
  `/process-chunk` y `/finalize` indirectamente: ambos leen el
  resolved del `match_runs` (vía la columna nueva) en lugar de
  `job_queries.resolved_json`. Esto cierra el loop — el ranker y la
  evaluación de gates corren contra el set efectivo.
