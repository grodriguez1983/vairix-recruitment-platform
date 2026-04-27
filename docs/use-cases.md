# 🎬 Use Cases & Behavioral Contracts

> Paso 5 del initialization cascade (paper §6.2). Cada use case es
> simultáneamente:
>
> - una descripción de comportamiento para humanos,
> - la especificación de un test E2E,
> - un contrato de interfaces entre capas.
>
> **Si una implementación permite una transición no listada acá, la
> implementación es incorrecta por spec, no el diagrama.**

Derivado de: `spec.md` §2 y §9.

---

## UC-01 — Re-descubrimiento de candidatos

**Actor**: Reclutador.
**Goal**: Encontrar candidates históricos que encajen con una búsqueda
nueva, incluyendo los que fueron rechazados hace años.
**Precondiciones**: Usuario autenticado con rol `recruiter` o `admin`.

### Flujo principal

1. El reclutador abre la barra de búsqueda.
2. Escribe: _"backend senior Node.js rechazado hace más de 1 año por
   nivel técnico"_.
3. Opcionalmente activa filtros (rango de fecha, rechazo, skills).
4. Recibe lista ordenada de candidates con score de similitud.
5. Click en uno → abre perfil consolidado (UC-04).
6. Puede agregarlo a una shortlist (UC-03).

### Sequence

```mermaid
sequenceDiagram
  actor R as Reclutador
  participant UI
  participant API as /api/search
  participant Auth
  participant Embed as embeddings/provider
  participant PG as Postgres

  R->>UI: "backend senior Node.js rechazado"
  UI->>API: POST { q, filters: { rejected_after: "2025-04-17" } }
  API->>Auth: requireAuth()
  Auth-->>API: user { id, role }
  API->>Embed: embed(q)
  Embed-->>API: vector[1536]

  API->>PG: structured filter query<br/>(status='rejected', rejected_at < '2025-04-17')
  PG-->>API: candidate_ids[]

  API->>PG: vector similarity over filtered set<br/>ORDER BY embedding <=> $1 LIMIT 50
  PG-->>API: results with similarity

  API->>PG: hydrate candidate cards (names, last_app, tags)
  PG-->>API: enriched rows
  API-->>UI: JSON [{ candidate, similarity, reason_snippet }]
  UI-->>R: grid de cards
```

### Acceptance criteria (tests E2E derivados)

- `test_search_filters_before_vector` — la query aplica filtros SQL
  antes del cosine similarity.
- `test_search_respects_rls` — un `recruiter` NO ve candidates con
  `deleted_at IS NOT NULL`.
- `test_search_empty_query_returns_empty` — query vacía no trigger
  embedding call ni devuelve todo.
- `test_search_rate_limits_embed` — 20 queries/s por user son
  rechazadas después de N.

---

## UC-02 — Búsqueda semántica pura

**Actor**: Reclutador.
**Goal**: Buscar por descripción cualitativa sin filtros rígidos.
**Precondiciones**: Igual a UC-01.

### Flujo

1. Reclutador escribe: _"alguien prolijo, bueno en system design,
   floja comunicación en inglés"_.
2. Sistema busca sobre embeddings de evaluations + CVs sin
   filtros estructurales.
3. Ranking puro por similitud coseno.

### Acceptance criteria

- `test_semantic_only_no_structured_filters`
- `test_semantic_aggregates_by_candidate` — si un candidate tiene 3
  embeddings que matchean, aparece UNA vez con la mejor similitud.

---

## UC-03 — Gestión de shortlists

**Actor**: Reclutador.
**Goal**: Armar, modificar y compartir listas curadas de candidates
para una búsqueda concreta.

### Estado de una shortlist

```mermaid
stateDiagram-v2
  [*] --> draft: create
  draft --> active: save_first_member
  active --> active: add/remove member
  active --> archived: archive
  archived --> active: restore
  archived --> [*]: (soft delete, admin only)
```

### Acceptance criteria

- `test_shortlist_creation_requires_name`
- `test_add_candidate_twice_is_idempotent`
- `test_archived_shortlist_readonly_for_recruiter`
- `test_only_creator_or_admin_can_delete`

---

## UC-04 — Ver perfil consolidado del candidate

**Actor**: Reclutador.
**Goal**: Ver todo lo que sabemos del candidate en una sola vista.

### Sequence

```mermaid
sequenceDiagram
  actor R as Reclutador
  participant UI
  participant API as /api/candidates/:id
  participant Storage
  participant PG

  R->>UI: click candidate
  UI->>API: GET /api/candidates/:id
  API->>PG: SELECT candidate + applications + evaluations + notes + tags
  Note right of PG: RLS aplicado
  PG-->>API: rows
  API->>PG: SELECT files WHERE candidate_id AND deleted_at IS NULL
  PG-->>API: files metadata
  API-->>UI: JSON consolidado

  R->>UI: click "ver CV"
  UI->>API: POST /api/files/:id/signed-url
  API->>Storage: createSignedUrl(path, 3600)
  Storage-->>API: signed URL
  API-->>UI: { url, expiresAt }
  UI-->>R: open PDF in new tab
```

### Acceptance criteria

- `test_profile_returns_aggregated_data`
- `test_profile_respects_rls_soft_deleted`
- `test_signed_url_expires_in_one_hour`
- `test_signed_url_requires_auth`
- `test_recruiter_cannot_access_deleted_cv`

---

## UC-05 — Sync incremental desde Teamtailor

**Actor**: Sistema (cron).
**Goal**: Traer cambios de Teamtailor a nuestra DB sin duplicar, sin
romper ante rate limits, idempotente.

### State machine del run

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> running: cron trigger + lock acquired
  idle --> aborted: lock held by other run
  running --> success: all entities done
  running --> error: fatal error
  running --> stale: > 1h without finish
  stale --> running: next cron reclaims lock
  success --> idle: next cron cycle
  error --> idle: next cron cycle (last_synced_at NOT advanced)
```

### Acceptance criteria

- `test_sync_upsert_is_idempotent` — correr dos veces no duplica.
- `test_sync_respects_rate_limit` — mock server de 429 → cliente
  hace backoff, no crashea.
- `test_sync_fatal_error_preserves_last_synced_at` — si falla fatal,
  `last_synced_at` NO avanza.
- `test_sync_stale_lock_is_reclaimed` — run zombie con
  `last_run_started < now() - 1h` se puede tomar.
- `test_sync_row_error_does_not_stop_batch` — un registro que falla
  se loggea en `sync_errors`, el resto continúa.

---

## UC-06 — Generación de embeddings post-sync

**Actor**: Sistema.
**Goal**: Mantener `embeddings` sincronizado con las fuentes (CV,
evaluations, notes, profile).

### Flujo de decisión por fuente

```mermaid
flowchart LR
  A[Source candidate<br/>content] --> B[Calcular content_hash]
  B --> C{existe embedding<br/>para source_id?}
  C -- no --> E[generar + upsert]
  C -- sí --> D{hash igual?}
  D -- sí --> F[skip]
  D -- no --> E
  E --> G[update embeddings.content_hash]
```

### Acceptance criteria

- `test_embedding_regenerated_when_content_changes`
- `test_embedding_skipped_when_hash_matches`
- `test_embedding_hash_includes_model_name` — cambiar modelo fuerza
  regenerar.
- `test_embedding_worker_idempotent` — correr dos veces sin cambios
  no llama a OpenAI.

---

## UC-07 — Upload y parseo de CV

**Actor**: Sistema.
**Goal**: Subir CV a Storage privado, parsear texto, detectar scaneados.

### Estados del archivo

```mermaid
stateDiagram-v2
  [*] --> downloaded: pull from TT signed URL
  downloaded --> stored: uploaded to Supabase Storage
  stored --> parsing: parser worker picks up
  parsing --> parsed: text extracted & persisted
  parsing --> failed_unsupported: format not in allowlist
  parsing --> failed_parse: parser threw
  parsing --> likely_scanned: text < 200 chars from PDF
  parsed --> [*]
  failed_unsupported --> [*]: admin reviews
  failed_parse --> parsing: admin manual re-parse
  likely_scanned --> [*]: Fase 2 OCR
```

### Acceptance criteria

- `test_cv_rejects_file_above_10mb`
- `test_cv_skips_reupload_when_hash_matches`
- `test_cv_scanned_pdf_marked_likely_scanned`
- `test_cv_docx_parses_to_text`
- `test_signed_url_of_cv_is_one_hour`

---

## UC-08 — Soft delete y restore (admin)

**Actor**: Admin.
**Goal**: Marcar candidate como borrado sin perder historial; restaurarlo.

### Acceptance criteria

- `test_recruiter_cannot_soft_delete`
- `test_admin_soft_delete_hides_from_recruiter`
- `test_admin_can_restore`
- `test_soft_delete_preserves_cv_in_storage`
- `test_applications_of_soft_deleted_candidate_hidden_to_recruiter`

---

## UC-11 — Matching por descomposición de llamado

**Actor**: Reclutador / persona de talento.
**Goal**: A partir de un job description pegado tal cual (texto libre
de un llamado del cliente), encontrar los candidates cuyos CVs
contengan evidencia real de experiencia laboral con las tecnologías y
seniority requeridas, con años totales y años por skill calculados
desde las experiencias extraídas.
**Precondiciones**:

- Usuario autenticado con rol `recruiter` o `admin`.
- CVs parseados (UC-07) y **extraídos estructuralmente** (ver ADR-012
  propuesto): `candidate_experiences` + `experience_skills` poblados.
- Catálogo `skills` seedeado con aliases (ADR-013 propuesto).

### Flujo principal

1. El reclutador pega el llamado en una textarea (p.ej. _"Buscamos
   backend sr con 3+ años de Node.js en producción, experiencia real
   con PostgreSQL, deseable AWS. Inglés intermedio."_).
2. El sistema descompone el llamado en requisitos atómicos
   (ADR-014 propuesto): `[{skill: "Node.js", min_years: 3,
must_have: true, evidence: "work"}, {skill: "PostgreSQL",
must_have: true}, {skill: "AWS", must_have: false}]` + seniority +
   idiomas.
3. El motor de matching (ADR-015 propuesto) resuelve cada requisito
   contra `experience_skills` (SQL estructurado: "candidatos con
   ≥3 años acumulados de Node.js en posiciones laborales") y
   combina con similitud semántica para los requisitos cualitativos.
4. Devuelve lista ordenada con score explicable: por cada candidato,
   qué requisitos cumplió, años reales por skill, y snippet de la
   experiencia que lo demuestra.
5. Click en candidato → perfil consolidado (UC-04) con las
   experiencias relevantes resaltadas.
6. Puede agregarlo a una shortlist (UC-03).

### Sequence

```mermaid
sequenceDiagram
  actor R as Reclutador
  participant UI as /search/match-by-role
  participant API as matchByRole service
  participant Decomp as llm/decomposer
  participant Skills as lib/skills
  participant PG as Postgres
  participant Embed as embeddings/provider

  R->>UI: paste job description
  UI->>API: POST { jobDescription }
  API->>Decomp: decompose(text)
  Decomp-->>API: requirements[] + seniority + languages
  API->>Skills: resolveAliases(requirements)
  Skills-->>API: skill_ids[]

  par structured
    API->>PG: SELECT candidate_id, SUM(years) FROM experience_skills<br/>WHERE skill_id IN (...) GROUP BY candidate_id HAVING ...
    PG-->>API: candidate_ids with per-skill years
  and semantic
    API->>Embed: embed(jobDescription)
    Embed-->>API: vector
    API->>PG: semantic_search_embeddings(vector, candidate_id_filter)
    PG-->>API: scores
  end

  API->>PG: hydrate candidate cards + matching experiences
  PG-->>API: enriched rows
  API-->>UI: { matches: [{candidate, score, matched_requirements, years_by_skill, evidence}] }
  UI-->>R: grid con scorecard por candidato
```

### Acceptance criteria (tests E2E derivados)

- `test_decomposer_extracts_years_and_must_haves` — "3+ años de Node"
  debe producir `{skill: "Node.js", min_years: 3, must_have: true}`.
- `test_matcher_excludes_candidates_missing_must_have` — si el
  llamado pide Node.js must-have y el candidato no tiene
  `experience_skills` con Node.js, NO aparece.
- `test_matcher_counts_only_work_experience` — años por skill
  calculados solo sobre `candidate_experiences` (no cursos, side
  projects listados aparte), a menos que el requisito lo permita
  explícitamente.
- `test_matcher_respects_overlapping_experiences` — dos trabajos
  simultáneos con la misma skill cuentan según la política definida
  en ADR-015 (overlapping vs aditivo).
- `test_matcher_returns_explainable_score` — cada match incluye
  `matched_requirements[]` con `{requirement, status, years, evidence_snippet}`.
- `test_matcher_empty_job_description_rejected` — input vacío / sin
  skills extraíbles devuelve error con mensaje accionable.
- `test_matcher_respects_rls` — un recruiter no ve matches de
  candidates soft-deleted.
- `test_matcher_deterministic_given_same_extraction` — mismas
  `candidate_experiences` + misma descomposición ⇒ mismo ranking.
- `test_matcher_decays_stale_experience` (ADR-026) — un candidato con
  N años de skill X cuya última experiencia con X terminó hace mucho
  contribuye con `effective_years = N × 0.5^(years_since_last/4)` al
  ratio, no con N raw. Caso canónico: 5 años de Java terminados
  hace 15 años → `effective ≈ 0.36 años`, ratio bajo `senior` cae de
  1 a ~0.12.

### Notas de diseño (pre-ADR)

- La descomposición del llamado es un paso **separado** de la
  extracción del CV. Ambos pasan por LLM pero con prompts distintos
  y hashes de invalidación independientes (ver ADR-012 y ADR-014).
- El CV estructurado es la fuente de verdad; el embedding del CV
  entero (F3-001) queda como complemento para matches cualitativos
  ("alguien prolijo"), no para skills/years.
- Esta feature **no** reemplaza UC-01 ni UC-02; es un tercer modo de
  búsqueda específicamente para el caso "tengo un llamado, quién
  encaja".

---

## UC-09 — Normalización de rejection reason (ADR-007)

**Actor**: Sistema (post-sync de evaluations).
**Goal**: Mapear texto libre a `rejection_categories`.

### Flujo

```mermaid
flowchart TD
  A[new evaluation<br/>con rejection_reason] --> B[keyword matcher]
  B --> C{match?}
  C -- sí --> D[set rejection_category_id<br/>needs_review=false]
  C -- no --> E[set rejection_category_id='other'<br/>needs_review=true]
  D --> F[set normalization_attempted_at=now]
  E --> F
```

### Acceptance criteria

- `test_keyword_matches_by_priority`
- `test_no_match_sets_other_and_needs_review`
- `test_normalization_idempotent_by_attempt_timestamp`

---

## Convenciones

- Todo use case tiene **al menos** un test E2E que lo cubre punta a
  punta. Si no, el use case no está implementado.
- Todo state machine tiene test que intenta transiciones inválidas
  y **debe** devolver error (test adversarial, paper §4.3
  _Verifiable_).
- Los `test_*` nombrados arriba son el contrato — un reviewer puede
  buscarlos por grep y verificar presencia.
