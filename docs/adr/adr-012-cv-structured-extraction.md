# ADR-012 — Extracción estructurada de CVs (experiencias + skills)

- **Estado**: Propuesto
- **Fecha**: 2026-04-20
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: `spec.md` §2.6 + §10 Fase 4, `use-cases.md`
  UC-11, ADR-005 (embeddings), ADR-006 (CV storage & parsing),
  ADR-003 (auth/RLS), `docs/adr/_pending-decisions-f4.md`

---

## Contexto

UC-11 ("matching por descomposición de llamado") necesita responder
preguntas del tipo _"candidatos con ≥3 años de Node.js en trabajo
real"_. Con el pipeline actual no se puede:

- `files.parsed_text` es texto plano del CV (F1-008, ADR-006).
- El único índice semántico es un embedding por source*type por
  candidato (F3-001, ADR-005): sirve para *"alguien prolijo que
  escribe bien"_, no para _"3 años de React"\_.
- No existen entidades de dominio `candidate_experiences` ni
  `experience_skills`. Un filtro por años por tecnología sobre
  `parsed_text` sería imposible con SQL y caro con LLM-per-query.

Feedback del equipo de talento (2026-04-20): los candidates que
importan para F4 tienen **hasta dos PDFs**: un extracto de LinkedIn
(estructura estable) y un CV oficial (free-form), con el CV oficial
pesando más que el LinkedIn en el juicio del recruiter. Ver
`_pending-decisions-f4.md` §P1 para la cita textual.

Restricciones asumidas al decidir:

- Budget moderado (~1000 candidates × ~2 CVs × ~5.5k tokens ≈ USD
  1–2 con el modelo más barato de OpenAI). Ver §P5.
- Confidencialidad **de facto** (sin compliance formal — CLAUDE.md
  §Project Identity), pero PII real: mandar CVs completos a un
  provider externo es un cambio de postura respecto al pipeline
  actual (donde solo mandamos embeddings, no texto plano).
- Stack cerrado por ADRs previos: Supabase (ADR-001), service-role
  key restringida a workers (ADR-003), worker pattern establecido
  por ADR-005/006 (I/O inyectado, idempotencia por hash).

---

## Decisión

### 1. Dos paths de extracción con clasificador determinístico

`src/lib/cv/variant-classifier.ts` (función pura, sin I/O) decide
para cada `files.id` con `parsed_text` no-null:

- `cv_variant ∈ { 'linkedin_export', 'cv_primary' }`

Heurísticas (conservadoras — si no hay match claro, cae a
`cv_primary` y se resuelve con LLM):

- Presencia de URL `linkedin.com/in/<slug>`.
- Metadata del PDF con `Producer` que contenga "LinkedIn".
- Layout de secciones en orden conocido: "Contact", "Top Skills",
  "Experience", "Education", "Certifications".

El clasificador devuelve además un `confidence` numérico; si
< umbral, `cv_primary` (fallback seguro — mejor pasar un LinkedIn
por LLM que parsear mal un CV real con el parser determinístico).

### 2. Backends por variant, shape de salida común

**`linkedin_export` → parser determinístico** en
`src/lib/cv/extraction/linkedin-parser.ts`. Sin LLM.

**`cv_primary` (default)** → extractor LLM en
`src/lib/cv/extraction/llm-extractor.ts`.

Ambos devuelven el mismo shape:

```ts
type ExtractionResult = {
  experiences: Array<{
    kind: 'work' | 'side_project' | 'education';
    company: string | null;
    title: string | null;
    start_date: string | null; // 'YYYY-MM' | 'YYYY-MM-DD'
    end_date: string | null; // null = present
    description: string | null;
    skills: string[]; // raw strings, sin normalizar (ADR-013)
  }>;
  languages: Array<{ name: string; level: string | null }>;
  source_variant: 'linkedin_export' | 'cv_primary';
};
```

La normalización de skills a un catálogo es responsabilidad de
ADR-013; acá salen como strings crudos.

### 3. Provider LLM: OpenAI con abstracción

`ExtractionProvider` en `src/lib/cv/extraction/providers/`, mirror
del patrón `EmbeddingProvider` de ADR-005. Interfaz mínima:

```ts
interface ExtractionProvider {
  readonly model: string;
  readonly promptVersion: string;
  extract(parsedText: string): Promise<ExtractionResult>;
}
```

Implementación por defecto: `openai-extractor.ts` usando
`gpt-4o-mini` con `response_format: { type: 'json_schema', ... }`
para forzar el shape. Existe `stub-extractor.ts` determinístico
para tests (mirror de `StubEmbeddingProvider`).

### 4. Identidad y hashing de idempotencia

Cada fila extraída vive en `candidate_extractions`:

- `file_id uuid not null references files(id)`
- `cv_variant text not null`
- `model text not null`
- `prompt_version text not null`
- `content_hash text not null` — `SHA256(parsed_text || '\x00' ||
model || '\x00' || prompt_version)`
- `extracted_at timestamptz`
- `raw_output jsonb` — el `ExtractionResult` crudo del provider
  (debugeable)
- Unique: `(file_id, content_hash)`

Los datos normalizados (`experiences`, `experience_skills`) se
derivan de `raw_output` al escribir — ver §7.

### 5. Política de re-extracción

`prompt_version` es una constante exportada por el provider, ej.
`EXTRACTION_PROMPT_V1 = '2026-04-v1'`. Cambiar:

- `model` (ej. subir a `gpt-4o` o rotar a otro provider) invalida
  todos los hashes automáticamente.
- `prompt_version` se bumpea **solo en un PR consciente**, con ADR
  nuevo si la semántica del output cambia (ej. agregar campos,
  cambiar criterios de `kind='work'` vs `'side_project'`).
- Typo fixes o reformulaciones sin cambio semántico **no** bumpean
  `prompt_version`.

Efecto: un re-extract masivo cuesta dinero → la decisión queda en
el PR review, no en un push accidental.

### 6. Worker y runtime

`src/lib/cv/extraction-worker.ts` (mirror de
`src/lib/cv/parse-worker.ts` de F1-008):

- Pulla filas `files` con `parsed_text IS NOT NULL AND
parse_error IS NULL` que no tienen `candidate_extractions` para
  la tupla (`model`, `prompt_version`) actual.
- Clasifica variant → ejecuta backend → upsert idempotente por
  `content_hash`.
- Row-level errors van a `sync_errors` con entity=`'extraction'`
  (reusa la tabla existente de ADR-004).
- **Service-role key obligatoria** (ADR-003) — es un job interno
  post-parse, nunca disparado por usuario.
- CLI: `pnpm extract:cvs [--batch=N] [--force]`.

Se agrega al `pnpm extract:all` (nuevo) que correrá `extract →
embed` en orden, o se registra en `embed-all` como paso previo.

### 7. Escritura a `candidate_experiences` + `experience_skills`

El worker, además de persistir `raw_output`, hace un **upsert
derivado** a:

- `candidate_experiences` (candidate_id, cv_variant, kind,
  company, title, start_date, end_date, description, source_file_id)
- `experience_skills` (experience_id, skill_raw, skill_id nullable,
  evidence_snippet) — `skill_id` se resuelve contra el catálogo
  de ADR-013 al write (con FK nullable para no bloquear la
  extracción si un skill no está catalogado; se cubre en ADR-013).

El **weight por variant** (decisión P1) NO vive en una columna
nueva: se deriva en la query del ranker (ADR-015) via
`CASE cv_variant WHEN 'cv_primary' THEN 1.0 WHEN 'linkedin_export'
THEN 0.6 END`. Los números quedan en ADR-015; ADR-012 solo expone
`cv_variant`.

### 8. Riesgos aceptados sobre PII

`gpt-4o-mini` vía API estándar de OpenAI retiene los payloads
hasta **30 días** para abuse monitoring. Se envían CVs con PII
(nombre, email, teléfono, LinkedIn, historial laboral).

**Riesgo aceptado explícitamente** por el usuario (2026-04-20,
cita en `_pending-decisions-f4.md` §P5). Registrado como deuda en
`status.md §Deuda de seguridad` con gate: antes de correr F4
contra el tenant productivo, confirmar si la cuenta permite
zero-retention; si no, mantener el riesgo documentado.

Mitigaciones in-code (Fase 1):

- No enviar `files.storage_path` ni UUIDs internos al provider.
- El prompt le pide al modelo _no_ copiar el nombre del candidato
  al output (lo tomamos del row de `candidates`), reduciendo
  PII-in-logs si se persiste `raw_output`.
- `raw_output` almacenado en Postgres (no en logs) con RLS
  admin-only.

### 9. Observabilidad

Logs JSON estructurados a stderr por extracción, mirror de
`embeddings/worker-runtime.ts`:

```
{ op: 'extract.page', fileId, variant, tokensIn, tokensOut,
  durationMs, backend: 'llm'|'linkedin' }
{ op: 'extract.done', processed, skipped, regenerated, reused,
  totalTokensIn, totalTokensOut, estCostUsd }
```

El `estCostUsd` permite evaluar si corresponde subir a `gpt-4o`
sin adivinar.

---

## Alternativas consideradas

### A) Un solo path LLM para todos los CVs

- **Pros**: un solo codepath, un solo prompt, un solo test harness.
- **Contras**: tira LLM sobre LinkedIn exports que ya vienen
  estructurados. Gasta ~2× los tokens necesarios sin mejorar la
  calidad. Pierde auditabilidad sobre el parser determinístico
  (que es reproducible al 100%).
- **Descartada** por costo y por perder la oportunidad de un
  parser reproducible sobre el ~40% estimado de CVs que son
  LinkedIn export.

### B) Parser determinístico + NER para todos (sin LLM)

- **Pros**: cero costo de inferencia, cero PII a providers
  externos, determinístico.
- **Contras**: CVs free-form en español + inglés + formatos mixtos
  tienen recall bajo (~60% en prototipos internos). Cada regla
  nueva es mantenimiento perpetuo. No extrae "implicit skills"
  (ej. "trabajé en el backend de un e-commerce de alto tráfico" →
  probablemente implica PostgreSQL, Redis, algún framework web).
- **Descartada** por recall insuficiente sobre el tipo de data
  real del tenant.

### C) Anthropic Claude en lugar de OpenAI

- **Pros**: retention off por default, más alineado con la
  postura de confidencialidad de facto. Calidad comparable a
  `gpt-4o-mini` en extracción estructurada.
- **Contras**: nueva dependencia (no usamos Anthropic en ningún
  otro lado). Dos proveedores a rotar, monitorear, pagar.
- **Postergada** como plan B. Trigger de re-evaluación: si
  compliance/legal de VAIRIX levanta el tema de retention en
  Fase 2+, o si Anthropic saca un modelo significativamente más
  barato o mejor.

### D) Extracción en el ETL (mismo worker que el sync)

- **Contras**: viola ADR-004 ("el ETL hace upsert estructurado —
  no genera embeddings ni parsea CVs"). La extracción es un
  pipeline separado con cadencia, costo y retry policy propios.
- **Descartada** por arquitectura.

### E) `gpt-4o` (modelo grande) desde día uno

- **Pros**: recall probablemente ~5–10% superior sobre CVs
  ruidosos.
- **Contras**: ~20× más caro (~USD 20–40 en el backfill inicial
  vs USD 1–2).
- **Postergada**. Arrancamos con `gpt-4o-mini` + logs de tokens;
  si el recall medido sobre un panel adversarial es insuficiente,
  bumpeamos model (que invalida el hash y reextrae, como §5).

### F) Hashing `SHA256(parsed_text || model || sha256(prompt))`

- **Pros**: ningún cambio al prompt puede escaparse sin reextract.
- **Contras**: un typo fix en un comentario del prompt dispara
  re-extract de todos los CVs (~USD 1–2 en mini, peor con
  modelos grandes). Fricción para mejoras iterativas del prompt.
- **Descartada** por óptica de costo (ver P4 en
  `_pending-decisions-f4.md`).

---

## Consecuencias

### Positivas

- Habilita UC-11 sin introducir LLM-per-query (caro y lento).
- Reusa la abstracción de provider de ADR-005, patrón probado.
- `raw_output` en Postgres hace la extracción **debugeable**:
  podés re-derivar `candidate_experiences` sin re-llamar al LLM.
- El parser determinístico de LinkedIn es una prueba de que el
  pipeline puede crecer a otros formatos estructurados sin cambiar
  el shape.
- Cambiar de modelo o de provider es un refactor acotado
  (`ExtractionProvider` implementación).

### Negativas

- Agrega dependencia a un provider externo para PII (riesgo
  aceptado, §8).
- Dos codepaths de extracción → dos suites de tests y dos
  evoluciones posibles. Mitigado por un contract test compartido
  sobre `ExtractionResult`.
- Overstate de años por skill documentado como limitación conocida
  en ADR-015 (una experiencia con N skills da el período completo
  a las N).
- `raw_output` jsonb duplica información (también vive derivada
  en `candidate_experiences`). Trade-off aceptado: sin raw,
  debugging requiere re-llamar al LLM.

---

## Criterios de reevaluación

- Si el recall del extractor sobre un panel adversarial de ~50 CVs
  reales anonimizados es < 80% en F1 → reevaluar modelo (subir a
  `gpt-4o` o cambiar de provider).
- Si la fracción de CVs clasificados como `linkedin_export` resulta
  < 10% → el parser determinístico no paga el esfuerzo; volver a
  un solo path LLM.
- Si compliance / legal de VAIRIX requiere zero-retention → migrar
  a Anthropic o a un endpoint self-hosted. El `ExtractionProvider`
  lo permite sin tocar el worker.
- Si aparece una tercera variant (ej. CV generado por herramienta
  de VAIRIX con layout propio) → agregar backend sin romper shape
  común.
- Si el costo mensual supera USD 20 → revisar si vale la pena
  subir a modelo grande o bajar frecuencia de re-extract.

---

## Notas de implementación

### Prompt (v1, draft)

El prompt vive en `src/lib/cv/extraction/prompts/extract-v1.ts`
como string exportado junto con `EXTRACTION_PROMPT_V1`. Shape:

1. Role: "sos un extractor de CVs; devolvé JSON estricto".
2. Schema del `ExtractionResult` inline (también pasado como
   `response_format` para doble guarda).
3. Reglas explícitas:
   - _"kind='work' SOLO si hay empresa explícita y duración
     laboral; side projects, freelance, cursos, hackathons → NO
     kind='work'"_. Esto es crítico para la semántica de años
     por skill (ADR-015).
   - _"dates: si no hay mes, asumí enero; si no hay año, devolvé
     null"_.
   - _"skills: copiá los strings tal como aparecen en el CV, no
     normalices (ej: 'React.js', 'ReactJS', 'react' pueden
     coexistir); la normalización es downstream"_.
   - _"NO copies el nombre, email o teléfono del candidato al
     output"_ (mitigación PII §8).
4. Ejemplos few-shot: 1 LinkedIn export, 1 CV free-form (ambos
   anonimizados).

### Tests obligatorios (RED antes de implementar)

- `test_classifier_detects_linkedin_by_url`
- `test_classifier_falls_back_to_cv_primary_on_low_confidence`
- `test_linkedin_parser_extracts_experiences_from_standard_layout`
- `test_llm_extractor_respects_json_schema`
- `test_llm_extractor_retries_on_invalid_json`
- `test_worker_idempotent_on_same_hash`
- `test_worker_regenerates_on_model_change`
- `test_worker_regenerates_on_prompt_version_bump`
- `test_worker_service_role_required`
- `test_worker_row_error_goes_to_sync_errors`
- `test_raw_output_is_rls_admin_only`

### Dependencias

- OpenAI SDK ya instalado.
- No hay deps nuevas para el parser determinístico (string ops).
- `zod` ya en el proyecto para validar el `ExtractionResult` del
  LLM.
