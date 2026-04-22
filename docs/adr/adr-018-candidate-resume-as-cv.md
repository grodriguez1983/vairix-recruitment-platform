# ADR-018 — `candidates.attributes.resume` como segunda fuente de CVs

- **Estado**: Aceptado
- **Fecha**: 2026-04-21
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: ADR-004 (ETL orchestration), ADR-006 (CV
  storage and parsing), `docs/teamtailor-api-notes.md` §5.1/§5.7,
  migración `20260422170000_files_source_column.sql`,
  `src/lib/sync/candidate-resumes.ts`

---

## Contexto

El ETL de candidates (ADR-004) popula `files` **solo** desde
`/v1/uploads`. Esa colección contiene los binarios que un recruiter
o el propio candidato subieron explícitamente a Teamtailor.

Durante un smoke test con 200 candidatos descubrimos que solo **18**
terminaban con una fila en `files` — el 91% no tenía CV. Sin
embargo, abriendo un candidato sourced en TT (ej. María Martini,
`322042`) el perfil muestra un PDF adjunto generado por TT. El
binario no aparece en `/v1/uploads` porque nadie lo subió: TT lo
generó a partir del extract de LinkedIn al momento del source.

Teamtailor expone ese binario por una segunda superficie:

- `GET /v1/candidates` → en `attributes.resume` viene una URL
  firmada de S3 (válida ~60 segundos) que apunta al PDF renderizado
  por TT. Fuente confirmada en el thread TT support 2026-04-18.

Implicancia: nuestro pipeline ignora ~90% de los CVs reales. Todo
el RAG sobre CV (ADR-006 parsing, ADR-012 structured extraction)
queda ciego para los candidatos sourced, que son la mayoría.

## Decisión

1. Se agrega una columna `source text not null default 'uploads'`
   a `files` con `check (source in ('uploads', 'candidate_resume'))`
   (migración `20260422170000_files_source_column.sql`). Los
   binarios existentes quedan clasificados como `uploads` por
   default; los que provengan de `candidates.attributes.resume` se
   insertan con `source='candidate_resume'`.

2. Se crea un nuevo módulo `src/lib/sync/candidate-resumes.ts` que:
   - Toma (candidate_tt_id, resume_url) en batch.
   - Consulta `files` existentes por `teamtailor_id` namespaceado
     (`resume:<candidate_tt_id>`) para hacer dedup por
     `content_hash` (reutilizando `downloadAndStore` de ADR-006).
   - Descarga el binario, lo sube al bucket `candidate-cvs`, y
     upserta la fila con `source='candidate_resume'`.
   - **No aborta** el batch de candidates cuando falla una URL —
     registra en `sync_errors` con `entity='candidate_resumes'`,
     `error_code='DownloadFailed'` y sigue.

3. El `teamtailor_id` de las filas "resume" se namespace-a con el
   prefijo literal `resume:` (ej. `resume:322042`). Justificación:
   `files.teamtailor_id` es UNIQUE y el dominio de PKs de
   `/v1/uploads` son enteros positivos; el prefijo textual hace
   imposible la colisión sin cambiar el constraint.

4. `candidatesSyncer` pasa de objeto estático a factory
   (`makeCandidatesSyncer({ downloadResumesForRows })`). Cuando el
   hook está wired, se invoca inmediatamente después del upsert de
   candidates (ya con `candidateIdByTtId` resuelto). Sin hook, el
   syncer mantiene el comportamiento legacy (útil para los tests de
   integración en `tests/integration/sync/candidates.test.ts`).

5. La descarga **debe** correr en la misma pasada de
   `sync:incremental candidates`. La URL expira ~60s después que TT
   arma la respuesta JSON:API; no se puede reconstruir desde
   `candidates.raw_data` más tarde.

## Consecuencias

### Positivas

- Cobertura de CVs sube de ~9% (upload-only) a la práctica del 100%
  para candidatos que TT haya indexado con LinkedIn.
- El parser de CV (ADR-006), el extractor estructurado (ADR-012) y
  el RAG (ADR-015 §7) ganan material sobre el que trabajar para
  candidatos sourced, que hoy quedan invisibles al ranker.
- La columna `source` deja filtrar downstream (ej. priorizar
  uploads sobre resume-generated cuando haya ambos; o en UI mostrar
  la provenance del PDF).

### Negativas / trade-offs

- Duplicación: si un candidato tiene upload **y** resume, ambas
  filas coexisten (distintos `teamtailor_id` por namespacing). El
  parser los procesará a los dos. En la mayoría de los casos son
  binarios diferentes (el upload es el original del candidato; el
  resume es el extract de LinkedIn), así que conservar ambos es
  correcto para RAG. El UI tendrá que resolver empates cuando
  muestre "el" CV — queda para el consumidor decidir con `source`.
- La ventana de 60s significa que un retry de
  `sync:incremental candidates` después de un fallo de red pierde
  la URL original. Un run completamente fallido re-pide la página y
  obtiene una URL fresca; un fallo parcial dentro de un batch deja
  el resume sin bajar hasta el próximo incremental.
- Para backfill inicial, hay que resetear
  `sync_state.last_synced_at` del entity `candidates` y correr de
  nuevo.

### Alternativas consideradas

- **Agregar la URL a `candidates.resume_url`** — descartada: la URL
  expira a los 60s; persistir la URL sería misleading.
- **Worker separado `candidate-resumes` que consulte cada
  candidato individualmente** — descartada: requiere N requests más
  a `/v1/candidates/:id` (cada una genera una URL firmada fresca),
  rate-limit amistoso pero estructuralmente peor; y mantiene el gap
  durante el backfill inicial.
- **Ampliar `uploads` para absorber resume** — descartada: el
  endpoint es distinto, la semántica es distinta (binarios
  subidos vs. renderizados por TT), y mezclarlos rompe la
  trazabilidad de provenance.

## Notas de implementación

- Tests unitarios: `src/lib/sync/candidate-resumes.test.ts` cubre
  namespacing, URL ausente, content-hash dedup, unresolved
  candidate id, fetch error → `sync_errors`, y agregación por
  batch mixto.
- `candidates.ts` quedó en 237 LOC tras extraer `castValue` +
  `upsertCustomFieldValues` a `candidate-custom-fields.ts`
  (CLAUDE.md §📏 tope 300 LOC/archivo).
- Para re-sincronizar los 200 candidatos ya existentes:
  ```sql
  update sync_state set last_synced_at = null, last_cursor = null
   where entity = 'candidates';
  ```
  y correr `SYNC_MAX_RECORDS=200 pnpm sync:incremental candidates`.
