# ADR-016 — Señales complementarias al ranker estructurado (FTS + vector + evidence panel)

- **Estado**: Aceptado
- **Fecha**: 2026-04-20
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: ADR-015 (ranker determinístico), ADR-012
  (extracción estructurada), ADR-005 (embeddings pipeline),
  `use-cases.md` UC-11, `spec.md` §2.6, `files` migration
  `20260417205216` (tsvector GIN ya presente), `semantic_search_fn` /
  `hybrid_search_fn` (F2/F3)

---

## Contexto

ADR-015 define un ranker estructurado, determinístico, con must-have
gate binario y `breakdown_json` auditable por `experience_id`. Esa
propiedad es por diseño: UC-11 requiere que dos corridas idénticas
produzcan el mismo ranking y que cada celda del score sea citable.

Pregunta planteada durante F4-001 sub-bloque 2:

> ¿No podemos tener lo mejor de los tres mundos — extractor
> estructurado, RAG de chunks y full-text search — para que la
> búsqueda sea más flexible y exacta?

El repo ya tiene los tres sustratos:

- **FTS**: `idx_files_parsed_text` (GIN tsvector sobre
  `files.parsed_text`) y `pg_trgm` en `candidates.name`,
  `skills.canonical_name`.
- **Vector/RAG**: tabla `embeddings` + `semantic_search_fn` +
  `hybrid_search_fn` (F2/F3 mergeado).
- **Estructurado**: `candidate_experiences` + `experience_skills` (F4).

La decisión pendiente es **dónde entra cada señal sin corromper las
propiedades del ranker**. Dos tentaciones a evitar:

1. Mezclar similitud vectorial en `total_score`. Rompe determinismo
   (§4 Verifiable del `CLAUDE.md`) y hace el `breakdown_json`
   parcialmente opaco (¿cómo se cita un cosine similarity?).
2. Usar FTS como gate alternativo ("si el texto menciona React,
   pasa el must-have"). Eso es exactamente el matching léxico sin
   contexto que `resolve_skill` + años-por-skill están eliminando
   (ADR-013 §2, ADR-015 §1).

---

## Decisión

Tres integraciones acotadas, ninguna tocando el `total_score` del
ranker.

### 1. Recall-fallback post-ranker (sin mutar el score oficial)

Tras ejecutar el ranker, para cada candidato con
`must_have_gate = 'failed'`, ejecutar una query FTS sobre
`files.parsed_text` contra los skills `must_have` no satisfechos
(usando `plainto_tsquery` con los slugs como términos).

Candidatos con match FTS fuerte (`ts_rank > FTS_RESCUE_THRESHOLD`)
se agregan a un **bucket paralelo** `match_results` NO altera: los
rescatados se escriben en una tabla derivada `match_rescues`
(propuesta en §Notas de implementación) con flag
`requires_manual_review = true` y el snippet como evidencia.

Invariante: el `rank` y `total_score` oficiales no cambian. El
recruiter ve dos tablas — la ranqueada y la "revisar manualmente,
hay evidencia fuera del catálogo".

### 2. Evidence panel en la UI (F4-009)

Al expandir un candidato desde la pantalla de resultados:

- Breakdown estructurado arriba (de `match_results.breakdown_json`).
- **Panel de evidencia debajo**: snippets de `hybrid_search_fn`
  ejecutada ad-hoc contra `files.parsed_text` con los
  `requirements[].skill_slug` del job query. Mostrar los 3–5 top
  snippets con highlight del término matcheado.

El panel es **lectura derivada, no persiste**: no va a
`match_results`, no altera el score, se computa al abrir el detalle.
Sirve al recruiter como confirmación visual ("efectivamente el CV
menciona X en el contexto Y").

### 3. Indexar `candidate_experiences.description` con tsvector

Agregar `description_tsv tsvector generated always as
(to_tsvector('simple', coalesce(description, ''))) stored` +
`idx_candidate_experiences_description_tsv` GIN. Una línea en una
migración F4-007 bis.

Uso: el evidence panel (§2) gana granularidad — snippets por
experiencia, no por CV entero. Futuro: permitir al admin ejecutar
queries tipo "¿qué candidatos tienen descripciones que mencionen
`remote` + `fintech`?" como reporte ad-hoc, sin atacar la tabla
`files` (que tiene texto ruidoso: headers, pies de página, PII).

### 4. Lo que NO se hace

- **No** hay embedding por experience. El RAG actual opera sobre
  `embeddings` con granularidad candidato (o chunk de CV, según F2).
  Mantener esa granularidad; no multiplicarla por experience.
- **No** hay score híbrido. `total_score` ∈ [0, 100] determinista del
  ranker; cualquier señal FTS/vector entra como **dimensión
  separada** en la UI (columna "evidencia textual: fuerte/media/
  débil", no numérica).
- **No** se ajusta `must_have_gate` por señal textual. Si el LLM no
  extrajo el skill, el gate falla; el rescue bucket existe
  precisamente para que el recruiter decida manualmente, no para
  automatizar el perdón del gate.

---

## Alternativas consideradas

### A) Score híbrido — mezclar cosine similarity + FTS rank + score estructurado

- **Pros**: un solo número, un solo ranking, simple de mostrar.
- **Contras**:
  - Pierde determinismo (embeddings probabilísticos).
  - `breakdown_json` pierde citabilidad: "¿por qué este candidato
    sacó 78 y no 82?" se vuelve no contestable.
  - Pesos relativos (¿cuánto vale un cosine 0.85 vs un
    `years = 4`?) son arbitrarios y hay que tunearlos sin ground
    truth.
  - Compromete la propiedad Verifiable del CLAUDE.md §4.
- **Descartada porque**: el valor del F4 está en el contrato
  explícito (must-have + years + seniority). Diluirlo en un número
  mezclado lo convierte en "otro ranking oscuro", que es justamente
  lo que UC-11 vino a reemplazar.

### B) Reemplazar el extractor estructurado por RAG + LLM-en-el-loop

El usuario planteó esta variante explícitamente: parsear PDFs
localmente, chunkear, embedding, y hacer preguntas al corpus.

- **Pros**: flexibilidad lingüística alta; no necesita mantenimiento
  del catálogo.
- **Contras**:
  - No hay "años de React en los últimos 5" sin estructura temporal
    por experiencia.
  - Must-have gate no existe (se convierte en "RAG dice que sí").
  - `breakdown_json` cita chunks, no experiencias con fecha. No es
    auditable en el sentido de ADR-015.
  - Dos corridas con el mismo input pueden diferir.
- **Descartada porque**: reemplaza UC-11 por UC-búsqueda-
  semántica, que ya está cubierto por F3 (`hybrid_search_fn`). Son
  features ortogonales, no sustitutos.

### C) FTS/vector solo como filtro pre-ranker (reducir universo de candidatos)

- **Pros**: menos candidatos que scorear → corre más rápido.
- **Contras**:
  - Falsos negativos silenciosos: el filtro elimina candidatos que
    sí cumplirían estructuralmente pero cuyo CV no menciona los
    términos de forma textual.
  - La performance no es un problema hoy (5–15 usuarios, ~5k
    candidatos). Optimización prematura.
- **Postergada porque**: si el volumen crece (10k+ candidatos por
  tenant) puede revisitarse como **pre-filtro opcional con
  `--strict` flag**. No es el problema de Fase 1.

### D) Bucket de rescue sin umbral — mostrar todos los gate-failed

- **Pros**: cero falsos negativos por umbral mal calibrado.
- **Contras**: convierte el bucket en ruido (típicamente 80% de los
  candidatos fallan el gate). El recruiter vuelve a leer CVs de cero.
- **Descartada porque**: el rescue debe mostrar solo casos
  **sospechosamente fuertes** — donde el LLM probablemente se perdió
  algo. Con umbral mal calibrado, el recruiter deja de mirarlo.

---

## Consecuencias

### Positivas

- Aumenta recall de UC-11 sin comprometer precision ni auditabilidad
  del ranking oficial.
- Aprovecha infraestructura ya construida (tsvector en `files`,
  `hybrid_search_fn`) en lugar de agregar stack nuevo.
- Deja explícito que el ranker es estructurado y que señales
  alternativas viven afuera — previene presión futura para "hacerlo
  más inteligente" mezclando embeddings en el score.
- El evidence panel cierra la gap "¿por qué este candidato?" de
  forma visual, complementando el `breakdown_json` numérico.

### Negativas

- Dos tablas de resultados (ranqueados + rescate) es más UI que
  mantener.
- El rescue bucket requiere calibrar `FTS_RESCUE_THRESHOLD`; sin
  ground truth, empieza empírico (umbral por default, ajustable por
  admin en futuro).
- La línea "dónde entra FTS vs vector vs estructura" queda en este
  ADR — si se rompe, el ranker pierde la propiedad que lo hace
  valioso. Mantenerlo requiere disciplina en PR review.
- `description_tsv` stored column duplica espacio sobre
  `description` (aceptable: las descripciones son cortas).

---

## Criterios de reevaluación

- Si el rescue bucket resulta vacío en >90% de queries → ajustar
  umbral o eliminar la feature.
- Si el rescue bucket encuentra consistentemente candidatos que el
  LLM perdió → indica que el extractor necesita iteración (bump de
  `prompt_version`, no cambio de arquitectura).
- Si el evidence panel no se usa en >50% de las inspecciones de
  detalle → moverlo a colapsado por default o eliminarlo.
- Si aparece presión por "matching más flexible" que este ADR no
  cubre (ej. querying conceptual tipo "gente con onda de startup"),
  revisitar — probablemente es F3 (hybrid_search), no F4.
- Si el volumen de candidatos supera 10k/tenant y el ranker se
  vuelve lento: considerar pre-filtro FTS opcional (Alternativa C).

---

## Notas de implementación

No bloqueante para cerrar F4-001. El sub-bloque 3 (`job_queries`) y
los sub-bloques restantes se implementan sin tocar este ADR; las
integraciones se materializan en:

- **F4-007 bis** (nueva slice, ~3h): agregar `description_tsv` en
  `candidate_experiences` vía migración separada + regenerar types.
- **F4-008 bis** (nueva slice, ~4h): tabla `match_rescues`:

  ```sql
  create table match_rescues (
    match_run_id   uuid not null references match_runs(id) on delete cascade,
    candidate_id   uuid not null references candidates(id) on delete cascade,
    tenant_id      uuid,
    missing_skills text[] not null,         -- must_have no satisfechos
    fts_snippets   jsonb not null,          -- { skill_slug → snippet[] }
    fts_max_rank   numeric(6, 4) not null,
    primary key (match_run_id, candidate_id)
  );
  ```

  RLS paralela a `match_results`. Escrito por el mismo worker del
  ranker tras cerrar el run oficial.

- **F4-009 (UI)**: +4h de estimación para el evidence panel en el
  detalle de candidato. Usa `hybrid_search_fn` ya existente; no
  requiere endpoint nuevo.

Constantes sugeridas (ajustables):

```ts
export const FTS_RESCUE_THRESHOLD = 0.1; // ts_rank mínimo para entrar al bucket
export const EVIDENCE_SNIPPET_LIMIT = 5; // snippets por skill en el panel
```

Estos viven en `src/lib/rag/complementary-signals.ts` (nuevo módulo,
F4-008 bis) junto a los helpers `fetchFtsRescues()` y
`fetchEvidenceSnippets()`.

La actualización del roadmap (insertar F4-007 bis y F4-008 bis) se
hace al aceptar este ADR.

### Gap conocido — rescue vs pre-filter (pendiente de resolver)

Identificado al cerrar F4-008 bis (2026-04-21). El pre-filtro actual
(`preFilterByMustHave`, `src/lib/matching/pre-filter.ts`) hace
AND-intersection sobre `must_have && skill_id != null` consultando
`experience_skills`. Un candidato cuyo CV **menciona el skill en
`files.parsed_text` pero cuya extracción LLM lo omitió** queda fuera
del pool del ranker y **nunca llega al rescue bucket** (el rescue hoy
opera sobre `must_have_gate='failed'`, no sobre pre-filter-excluded).

Esto contradice la intención de §1: ADR-016 existe precisamente para
rescatar ese caso ("el LLM probablemente se perdió algo"). Con la
implementación actual, el bucket captura solo candidatos que el
pre-filter ya dejó pasar (tienen algunos must-haves pero no todos) —
ruido mucho menor al previsto.

**Resolución futura** (F4-008 ter, no bloqueante para F4-009 UI):

1. `preFilter` retorna `{ included, excluded_ids }` en lugar de solo
   `included`.
2. `runMatchJob` pasa `excluded_ids` al rescue hook; cada excluded
   candidate se consulta contra `files.parsed_text` con sus
   must-haves completos como `missing_skill_slugs`.
3. El bucket `match_rescues` cubre entonces el caso canónico
   (skill en CV text, no en `experience_skills`).

Mientras tanto, el bucket funciona correctamente para candidatos con
must-have parcial — subconjunto menor del caso real pero con la misma
mecánica de persistencia, RLS, y UI.
