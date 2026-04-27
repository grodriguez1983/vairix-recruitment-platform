# ADR-029 — Re-extract CV cuando `parsed_text` cambia

- **Estado**: Aceptado
- **Fecha**: 2026-04-27
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: ADR-012 (CV structured extraction), ADR-018
  (candidate resumes download), ADR-027 (incremental cursor)

---

## Contexto

El pipeline de CV es:

```
TT candidate → candidate-resumes hook → files (binary + content_hash)
            → parse:cvs → files.parsed_text
            → extract:cvs → candidate_extractions (+ derivations)
            → embed:all → embeddings
```

Cada paso tiene su propia idempotencia:

- **files**: re-upsert solo cuando el hash binario del PDF cambia
  (ADR-018). Cuando cambia, **explícitamente nullea**
  `files.parsed_text`, `parsed_at`, `parse_error` para forzar
  re-parser (`src/lib/sync/candidate-resumes.ts:207-209`).
- **parse:cvs**: filtra por `parsed_text IS NULL`. Hash binario
  diferente → nuevo texto.
- **extract:cvs**: dedupe key declarada en el schema
  (`candidate_extractions.content_hash UNIQUE`) es
  `SHA256(parsed_text || NUL || model || NUL || prompt_version)`. Si
  `parsed_text` cambió, el hash necesariamente cambia.

### El bug

`listPendingExtractions`
(`src/lib/cv/extraction/list-pending.ts:51-55`) deduplica por la
**proyección reducida** `(file_id, model, prompt_version)`, ignorando
`content_hash`:

```typescript
const { data: existing } = await db
  .from('candidate_extractions')
  .select('file_id')
  .eq('model', model)
  .eq('prompt_version', promptVersion);
```

Resultado: cuando TT actualiza un CV de un candidato ya extraído,

1. ✅ `files` upsert ve hash binario nuevo → row actualizada,
   `parsed_text=NULL`.
2. ✅ `parse:cvs` re-parsea y popula `parsed_text` con el texto
   nuevo.
3. ❌ `extract:cvs` invoca `listPending` → la row vieja de
   `candidate_extractions` (con hash viejo, mismo file_id) hace que
   el file sea filtrado.
4. ❌ `experiences` y `experience_skills` quedan apuntando a la
   extracción vieja (ranker scorea contra el CV obsoleto).

`extractionExistsByHash(hash)` (worker line 123) actúa como guard
post-listPending y SÍ usaría el hash, pero nunca se ejecuta porque
el file ya fue filtrado upstream.

### Por qué no fue obvio antes

El loop de validación habitual del owner es **traer candidatos
nuevos**, no re-procesar viejos. CVs nuevos pasan limpio: row
inexistente → no excluida → extract corre. El bug solo se manifiesta
en el flujo "TT updates CV" — operativamente raro hasta que la base
de candidatos crece y el churn de updates en TT empieza a importar.

## Decisión

**Sin schema change**. El `content_hash` ya codifica
`parsed_text` por construcción (`src/lib/cv/extraction/hash.ts`); la
información existe, solo hay que usarla.

### 1. Detection fix en `listPendingExtractions`

Cambiar la query de existing rows para traer `content_hash` en lugar
de (o además de) `file_id`. Para cada candidate file, computar:

```
expectedHash = extractionContentHash(file.parsed_text, model, promptVersion)
```

Incluir el file en pending **iff** `expectedHash NOT IN existingHashes`.
Esto hace que el helper se comporte exactamente como el schema dicta:
"un file es pending si NO hay una extracción con su hash actual".

Costo: O(N_files × hash_compute). Hash es SHA-256 sobre el `parsed_text`
del file que ya está en memoria → trivial.

### 2. Cleanup de siblings post-insert

Después de insertar la nueva extracción, eliminar cualquier row
hermana (`(file_id, model, prompt_version)` igual, hash distinto):

```sql
DELETE FROM candidate_extractions
WHERE file_id = $1
  AND model = $2
  AND prompt_version = $3
  AND content_hash <> $4;  -- el hash recién insertado
```

Las FKs cascadean automáticamente:

- `candidate_experiences.extraction_id ON DELETE CASCADE` → experiences
  viejas borradas → `experience_skills.experience_id ON DELETE CASCADE`
  → skills viejas borradas.
- `candidate_languages.extraction_id ON DELETE CASCADE` → languages
  viejas borradas.

El ranker carga experiences con `loadExperiences(candidate_id)` sin
deduplicar por extraction_id; si dejáramos las dos extracciones
conviviendo, los años por skill se duplicarían vía sweep-line
(ventanas se mergean) o se contarían dos veces si los intervalos
divergen lo suficiente. Mejor borrar.

### 3. Guard final intacto

`extractionExistsByHash(hash)` (worker line 123) sigue siendo el
guard atómico contra race conditions: dos workers corriendo en
paralelo que ambos vean el file como pending — el primero inserta,
el segundo se encuentra `extractionExistsByHash=true` y skipea sin
llamar al LLM. La nueva detección no reemplaza este check.

### 4. Naming del nuevo dep

`deleteStaleSiblings(file_id, model, prompt_version, current_hash)`.
Optional en el contrato del worker (caller test puede no proveerlo;
en CLI siempre va wired). Si está provisto, el worker lo invoca
después de un insertExtraction exitoso. Errores en el cleanup se
loguean a `sync_errors` con `entity='cv_extraction'` y NO rollbackean
la nueva extracción — la nueva data es válida; las viejas siblings
quedan como "cleanup pendiente" para el próximo run.

## Consecuencias

**Positivas**

- CVs actualizados en TT se re-extraen automáticamente sin gate
  manual.
- Sin schema change → sin migración → sin riesgo de corrupción
  durante el rollout.
- El comportamiento queda **alineado con el schema** (la UNIQUE en
  `content_hash` ya implicaba esta semántica; el helper era el que
  violaba la asunción).

**Negativas**

- `listPending` ahora carga el set completo de `content_hash` por
  `(model, prompt_version)`. A 400 candidates con 1 extracción cada
  uno son 400 strings de 64 chars = ~25 KB en memoria. Escala
  cómodamente hasta decenas de miles. Más allá, paginar.
- El cleanup hace un DELETE adicional por extracción exitosa. En
  steady state (CVs nuevos, no updates) el DELETE no encuentra rows
  → costo desestimable. En backfill masivo de updates → un DELETE
  por candidate, manageable.
- Si el cleanup falla (red, lock, etc.), la nueva extracción queda
  insertada y la vieja persiste. El próximo run intentará el cleanup
  de nuevo (idempotente). Mientras tanto el matcher tiene
  experiences duplicadas — degradación temporal, no corrupción.

**Descartadas**

- **Agregar columna `file_content_hash`** a
  `candidate_extractions` con `(file_id, model, prompt_version,
file_content_hash) UNIQUE`. Más explícito pero requiere migración
  con backfill + transición a NOT NULL. El fix actual es
  matemáticamente equivalente sin schema change. Si en el futuro el
  hash deja de derivarse determinísticamente del `parsed_text` (e.g.
  agregar inputs de catálogo como sal), abrir nuevo ADR.
- **Reemplazar la row vieja con UPDATE en lugar de DELETE+INSERT**.
  Bloqueado por `enforce_raw_output_immutability()` trigger
  (ADR-012 §4): `raw_output` es inmutable por contrato de
  auditoría. La única forma de actualizar la extracción es DELETE +
  INSERT.
- **Dejar las siblings vivir y deduplicar al leer**
  (`SELECT DISTINCT ON (file_id) ... ORDER BY created_at DESC`). Más
  complejo en cada read site; la cascade DELETE es local y no requiere
  refactorear el matcher. Y la doble row violaría el invariant moral
  "una extracción vigente por (file, model, prompt)".

## Plan de verificación

### Unit (TDD)

- `listPendingExtractions`:
  - `test_re_extracts_when_parsed_text_changed_post_extraction`:
    existing row con hash A; file con parsed_text que produce hash B
    → file aparece en pending.
  - `test_skips_when_text_unchanged_and_hash_matches`: existing row
    con hash A; file con parsed_text que produce hash A → file NO
    aparece en pending.
  - `test_includes_file_with_no_prior_extraction`: regresión.
  - `test_scopes_existing_query_by_model_and_prompt_version`: el set
    de hashes es por (model, prompt_version) — bumps de modelo no
    contaminan el dedup de otra version.

- `runCvExtractions`:
  - `test_invokes_delete_stale_siblings_after_successful_insert`:
    deps proveen `deleteStaleSiblings`; worker lo llama con (file_id,
    model, prompt_version, new_hash) tras insertExtraction OK.
  - `test_skips_delete_when_extraction_skipped_by_hash`: el guard
    `extractionExistsByHash=true` salta el insert; cleanup tampoco
    se invoca.
  - `test_skips_delete_when_extraction_failed`: provider tira →
    `errored` se incrementa; cleanup NO se invoca.
  - `test_cleanup_error_is_logged_and_does_not_rollback`: cleanup
    tira → `logRowError` recibe el mensaje con
    `entity='cv_extraction'`; el counter `extracted` permanece
    incrementado.

### Integración (post-fix)

Re-correr `extract:cvs` contra dev DB después de simular un cambio
de parsed_text manual:

```sql
UPDATE files
SET parsed_text = parsed_text || E'\n\n[manual change to test]'
WHERE id = '<file_id>';
```

Verificar que `extract:cvs --batch=10` lo procesa y que la row vieja
de `candidate_extractions` desaparece.

### Validación operativa

`SELECT count(*) FROM candidate_extractions` antes y después de un
ciclo de re-extract simulado debe dar **el mismo número** (delete +
insert net zero), no +1 por candidate procesado.
