# ADR-014 — Descomposición LLM de job descriptions

- **Estado**: Propuesto
- **Fecha**: 2026-04-20
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: `use-cases.md` UC-11, ADR-012 (extracción
  de CVs + abstracción de provider LLM), ADR-013 (catálogo de
  skills), ADR-015 (matching/ranking — pendiente), ADR-003 (RLS)

---

## Contexto

UC-11 arranca con el recruiter pegando un job description en texto
libre (p.ej. _"Buscamos backend sr con 3+ años de Node.js en
producción, experiencia real con PostgreSQL, deseable AWS. Inglés
intermedio."_). Para que el ranker de ADR-015 pueda filtrar por
`experience_skills` + `years`, necesitamos convertir ese texto
libre en una estructura con requisitos atómicos resolubles contra
el catálogo (ADR-013) y las experiencias estructuradas (ADR-012).

Observaciones sobre la naturaleza del input:

- El texto viene pegado tal cual llega el llamado — con frases
  como _"3+ años"_, _"deseable"_, _"excluyente"_, _"plus"_,
  _"nice to have"_, _"experiencia sólida"_, que son semánticamente
  claras para un humano pero no para una regex.
- Puede mezclar español e inglés.
- A veces incluye requisitos no-técnicos ("inglés intermedio",
  "disponibilidad full-time", "residente en CABA") que son
  relevantes para otros filtros o simplemente metadata.
- El recruiter puede pegar el llamado una vez y volver a la app
  varias veces a refinar la búsqueda — debería pagar el costo del
  LLM una sola vez por texto idéntico.

Restricciones heredadas:

- Provider LLM decidido en ADR-012: OpenAI `gpt-4o-mini` con
  abstracción `ExtractionProvider`. Este ADR **reusa** la
  abstracción pero instancia un provider distinto
  (`DecompositionProvider`) porque el schema de output es
  distinto. El SDK y la key son los mismos.
- Catálogo de skills (ADR-013) es la fuente de verdad para
  normalización. Un requisito con skill no resuelta es **error
  accionable**, no silent-zero.
- Riesgo PII: menor que en ADR-012 porque el job description rara
  vez contiene PII de candidato; típicamente es texto del cliente.
  Se documenta igualmente en §Riesgos.

---

## Decisión

### 1. Pipeline de alto nivel

```
raw_text (usuario)
   │
   ├── preprocess: trim, collapse whitespace, strip HTML si hubiera
   │
   ├── compute hash: SHA256(raw_text || model || prompt_version)
   │
   ├── lookup en job_queries por hash → hit → reuse decomposed_json
   │                                    → miss → llamar LLM
   │
   ├── LLM: structured output con zod schema → DecompositionResult
   │
   ├── resolver.ts (ADR-013) sobre cada requirement.skill_raw →
   │        skill_id o null
   │
   ├── persist en job_queries (raw_text, hash, decomposed_json,
   │                           resolved_json, created_by, created_at)
   │
   └── return { query_id, requirements, unresolved_skills[] }
```

El ranker de ADR-015 consume el `query_id` (o el `resolved_json`
directo) y decide qué hacer con `unresolved_skills` — ADR-013
define la política: bloquear la búsqueda con mensaje accionable si
alguna skill `must_have` no resolvió.

### 2. Shape del output (contrato estable)

```ts
type DecompositionResult = {
  requirements: Array<{
    skill_raw: string; // "Node.js" tal como apareció
    min_years: number | null; // null = no especificado
    max_years: number | null; // raro pero posible ("hasta 5 años")
    must_have: boolean; // true si excluyente, false si deseable
    evidence_snippet: string; // substring del raw_text que lo motivó
    category: 'technical' | 'language' | 'soft' | 'other';
  }>;
  seniority: 'junior' | 'semi_senior' | 'senior' | 'lead' | 'unspecified';
  languages: Array<{
    name: string; // "Inglés", "English", "Portugués"
    level: 'basic' | 'intermediate' | 'advanced' | 'native' | 'unspecified';
    must_have: boolean;
  }>;
  notes: string | null; // texto no-atomizable: "disponibilidad
  // full-time", "presencial CABA", etc.
};
```

Validado con **zod schema** en el caller (`src/lib/rag/
job-decomposer.ts`). Si el LLM devuelve algo que no matchea el
schema tras 1 reintento, se propaga como `DecompositionError` con
code `schema_violation` y el raw response en `context`.

**Separación explícita**: `requirements` es solo para skills
técnicas y dominio-específicas. Los idiomas van a `languages`
(son filtrables pero de otra tabla). Disponibilidad / ubicación /
otros quedan en `notes` — **no** se atomizan en Fase 1.

### 3. Provider + prompt

`DecompositionProvider` en `src/lib/rag/decomposition/providers/`:

```ts
interface DecompositionProvider {
  readonly model: string;
  readonly promptVersion: string;
  decompose(rawText: string): Promise<DecompositionResult>;
}
```

Default: `openai-decomposer.ts` con `gpt-4o-mini` +
`response_format: { type: 'json_schema', strict: true, schema: ... }`.
`stub-decomposer.ts` para tests (determinístico, sin red).

Prompt v1 (`src/lib/rag/decomposition/prompts/decompose-v1.ts`,
exportado junto a `DECOMPOSITION_PROMPT_V1 = '2026-04-v1'`):

- Role: _"sos un extractor de requisitos de búsquedas de
  reclutamiento tech; devolvé JSON estricto"_.
- Schema inline + passed as `response_format`.
- Reglas explícitas:
  - _"`min_years` SOLO si el texto lo dice explícitamente
    (`3+ años`, `al menos 5 años`); si dice `experiencia sólida`
    o `senior` sin años, dejá null"_.
  - _"`must_have` = true si el texto usa `excluyente`,
    `imprescindible`, `required`, `must have`, o lo pone en una
    sección clara de requisitos duros. Si dice `deseable`,
    `plus`, `nice to have`, `bonus`: false. Si ambiguo: false"_.
  - _"`evidence_snippet` debe ser un substring LITERAL del
    raw_text — no parafrasear"_ (permite mostrar en UI qué parte
    del llamado motivó cada requisito).
  - _"`category`: 'technical' para tecnologías (React, AWS),
    'language' para idiomas humanos, 'soft' para skills blandas
    (liderazgo, comunicación), 'other' para todo lo demás"_.
  - _"si no estás seguro si algo es un requisito, NO lo inventes"_
    — hallucinaciones > 0 son el problema central; preferimos
    false negatives a requisitos falsos.
- Ejemplos few-shot: 2 job descriptions anonimizados del dominio
  real.

Prompt version bump: misma política que ADR-012 §5 — cambios
semánticos requieren ADR nuevo; typo fixes no.

### 4. Persistencia: tabla `job_queries`

```sql
job_queries (
  id                uuid primary key default gen_random_uuid(),
  content_hash      text not null,                -- SHA256(raw_text||model||prompt_version)
  raw_text          text not null,
  model             text not null,
  prompt_version    text not null,
  decomposed_json   jsonb not null,               -- DecompositionResult crudo del LLM
  resolved_json     jsonb not null,               -- con skill_id resuelto (ADR-013)
  unresolved_skills text[] not null default '{}', -- skill_raw que no matchean catálogo
  created_by        uuid not null references app_users(id),
  created_at        timestamptz not null default now(),
  tenant_id         uuid null,                    -- ADR-003 hedge
  unique (content_hash)
);
```

Por qué persistir:

- **Cache**: mismo `raw_text` + mismo modelo/prompt_version → no
  re-llamar LLM. El recruiter puede editar filtros o volver al día
  siguiente a re-rankear sin pagar.
- **Auditoría**: quién pegó qué llamado, qué sacó el LLM, qué
  resolvió. Debuggable cuando una query devuelve resultados raros.
- **Re-ranking sin re-decompose**: si el catálogo cambia (se
  agrega un alias), se puede re-resolver `decomposed_json` contra
  el catálogo nuevo sin llamar al LLM — el `resolved_json` se
  actualiza in-place, pero `decomposed_json` es inmutable.

El `content_hash` es `UNIQUE` — los retries de inserción en race
condition caen en `on conflict do nothing` (idempotente).

### 5. Flujo de caching y re-resolución

Al recibir una búsqueda:

```ts
const hash = sha256(rawText + '\x00' + MODEL + '\x00' + PROMPT_VERSION);
const cached = await db.from('job_queries').select('*')
  .eq('content_hash', hash).maybeSingle();

if (cached) {
  // cache hit: re-resolver contra catálogo actual (barato, local)
  const resolved = resolveRequirements(cached.decomposed_json, catalog);
  if (resolved.unresolved_skills.sort().join(',') !==
      cached.unresolved_skills.sort().join(',')) {
    // catálogo cambió; update resolved_json + unresolved_skills
    await db.from('job_queries').update({
      resolved_json: resolved.json,
      unresolved_skills: resolved.unresolved_skills,
    }).eq('id', cached.id);
  }
  return { query_id: cached.id, ...resolved };
}

// miss: LLM call, persist
const decomposed = await provider.decompose(rawText);
const resolved = resolveRequirements(decomposed, catalog);
const row = await db.from('job_queries').insert({ ... }).select().single();
return { query_id: row.id, ...resolved };
```

`resolveRequirements` es la función pura que aplica
`resolver.ts` de ADR-013 a cada `skill_raw` del
`DecompositionResult` y devuelve la versión resuelta + lista de
unresolved.

### 6. Error handling

El caller (`decomposeJobDescription(rawText, db, provider, catalog)`)
puede devolver:

- **ok** — `{ query_id, requirements, unresolved_skills: [] }`
- **unresolved_skills** — `{ query_id, ..., unresolved_skills: [...] }`.
  El ranker de ADR-015 decide:
  - Si alguna `must_have` está en unresolved → bloquea con mensaje
    accionable _"'Kubernetes' no está en el catálogo. Agregalo en
    /admin/skills o reformulá el llamado"_.
  - Si solo las `nice to have` están unresolved → continúa el
    matching, muestra warning discreto en la UI.
- **error** — `DecompositionError` con code ∈
  `{empty_input, schema_violation, provider_failure,
rate_limit_exhausted}`.

Input vacío (tras preprocess) → `empty_input` sin llamar al LLM.

### 7. Observabilidad

Logs estructurados a stderr, mirror de ADR-012 §9:

```
{ op: 'decompose.request', hash, cached: bool, model, promptVersion }
{ op: 'decompose.llm', tokensIn, tokensOut, durationMs, estCostUsd }
{ op: 'decompose.resolved', requirementsTotal, unresolvedCount,
  mustHaveUnresolvedCount }
```

Dashboard en `/admin/job-queries` (admin-only) lista las últimas
N queries con created*by, unresolved_skills, y link a ver el JSON
crudo. Detecta patrones: *"¿qué skills se están pidiendo que no
tenemos en el catálogo?"\_. Alimenta el backlog de curación del
catálogo (ADR-013 §5).

### 8. RLS

`job_queries`:

- SELECT: recruiter + admin (ven todas las queries, propias y
  ajenas — es trabajo compartido en un equipo chico).
- INSERT: recruiter + admin.
- UPDATE: solo el backend via service-role para actualizar
  `resolved_json` en re-resolución (§5). Ningún rol de usuario
  edita filas directamente.
- DELETE: admin.

Todas con `enable rls` + `force`. Service-role usado solo en
`decomposeJobDescription` (worker-like), nunca expuesto al cliente.

### 9. Riesgos de PII

Los job descriptions rara vez tienen PII de candidato. Pero
pueden incluir:

- Nombre de un cliente no disclosable ("buscamos para <empresa>
  que está lanzando <producto>").
- Info salarial sensible.
- Datos internos de VAIRIX.

Se aceptan en el retention estándar de OpenAI (ya cubierto en
ADR-012 §8). Mitigación del prompt: _"no repitas literalmente
nombres de empresa o datos salariales en `evidence_snippet` si
aparecen; citá el contexto con `[cliente]` o `[monto]`"_. Es
parcial — el modelo puede desobedecer. Mismo trade-off que ADR-012.

---

## Alternativas consideradas

### A) Parsing determinístico con regex / keyword rules

- **Pros**: gratis, determinístico, sin PII a terceros.
- **Contras**: _"3+ años"_, _"al menos 3 años"_, _"mínimo 3 años
  de exp"_, _"3yrs"_ requieren patterns múltiples por idioma;
  _"experiencia sólida"_ es imparseable sin interpretar. Recall
  estimado < 50% sobre llamados reales.
- **Descartada** por recall insuficiente.

### B) LLM-per-search sin cache (no persistir `job_queries`)

- **Pros**: schema más chico, menos código.
- **Contras**: el recruiter paga el costo del LLM cada vez que
  vuelve al mismo llamado (p.ej. 3–5 refinamientos de filtros
  durante una sesión). ~5× el costo vs caching.
- **Descartada** por costo operativo y latencia.

### C) Pre-descomposición offline (batch de llamados)

- **Pros**: matching instantáneo una vez procesado.
- **Contras**: los llamados llegan ad-hoc, no en batch. Feature
  no aplica al workflow.
- **Descartada** por naturaleza del dominio.

### D) Modelo grande (`gpt-4o`) desde día uno

- **Pros**: recall probablemente ~5% superior en llamados ruidosos.
- **Contras**: ~20× más caro. Con caching agresivo del §5 el
  costo de decomposición es marginal, pero aun así no hay evidencia
  de que mini no alcance.
- **Postergada** con mismo trigger que ADR-012: si se mide recall
  < 80% en un panel adversarial de ~20 llamados reales, bumpear.

### E) Prompt que devuelve directo `candidate_ids` matcheando

- **Pros**: menos pasos, un solo LLM.
- **Contras**: acopla decomposición con retrieval; rompe ADR-005
  (el LLM no debería ver la DB), no escala al N de candidates,
  no auditable. Fundamentalmente contrario a la separación de
  capas de CLAUDE.md.
- **Descartada**.

### F) Schema sin `evidence_snippet`

- **Pros**: output más compacto, menos tokens.
- **Contras**: perdés la explicabilidad del resultado (el
  recruiter no sabe qué parte del llamado motivó el filtro
  "Node.js must_have"). UC-11 acceptance criteria exigen
  explicabilidad.
- **Descartada**.

---

## Consecuencias

### Positivas

- El recruiter ve exactamente qué entendió el sistema antes de
  rankear (vía `requirements[]` renderizado en la UI).
- Idempotencia por hash elimina costo repetido en refinamientos
  de filtros sobre el mismo llamado.
- `decomposed_json` inmutable + `resolved_json` mutable habilita
  re-ranking cuando el catálogo cambia sin pagar el LLM.
- Reusa `ExtractionProvider` pattern de ADR-012 — un solo modelo
  mental para "código que habla con LLMs en el backend".
- `unresolved_skills` en la UI convierte gap de catálogo en
  backlog visible (alimenta ADR-013 §5).

### Negativas

- Dependencia adicional de OpenAI (ya aceptada en ADR-012).
- Schema del output está acoplado al prompt v1; cambios
  semánticos requieren migración de datos si reinterpretamos
  `decomposed_json` viejo (aceptable porque `job_queries` es
  efímero en naturaleza — se puede truncar si hace falta).
- Hallucinations del LLM pueden generar requisitos falsos. El
  `evidence_snippet` como substring literal es el checkpoint
  principal: si el snippet no aparece en `raw_text`, rechazar.
  Documentado como test adversarial.
- Latencia del LLM (~2–5s por call) en miss de cache → UX
  requiere spinner + optimistic render.

---

## Criterios de reevaluación

- Si > 30% de queries tienen `unresolved_skills` **must_have** que
  requieren agregar al catálogo: buffer del catálogo está bajo;
  considerar seed derivado más agresivo en ADR-013.
- Si el LLM devuelve `schema_violation` > 5% del tiempo: reevaluar
  prompt o modelo. Candidato a subir a `gpt-4o` o reescribir
  few-shot.
- Si aparece necesidad de atomizar `notes` (ej. "quiero filtrar
  por modalidad remota"): agregar campo estructurado sin romper
  schema (`modality`, `location_constraint`, etc.).
- Si se requiere multilenguaje más fino (ej. "usuario pega en
  portugués"): actualmente el LLM lo maneja; si la calidad cae,
  detectar idioma en preprocess y usar prompt por idioma.
- Si el volumen de `job_queries` supera 10k/mes: evaluar
  compresión o retención (ej. borrar filas > 90d sin hits
  recientes).

---

## Notas de implementación

### Tests obligatorios (RED antes de implementar)

- `test_decomposer_extracts_min_years_from_plus_notation` — "3+
  años de Node" → `min_years: 3`
- `test_decomposer_extracts_min_years_from_numeric_prose` — "al
  menos 5 años de Python" → `min_years: 5`
- `test_decomposer_ignores_years_when_absent` — "experiencia
  sólida en Docker" → `min_years: null`
- `test_decomposer_must_have_from_excluyente` — "excluyente:
  PostgreSQL" → `must_have: true`
- `test_decomposer_must_have_false_from_deseable` — "deseable:
  AWS" → `must_have: false`
- `test_decomposer_evidence_is_literal_substring` — cada
  `evidence_snippet` es substring exacto del raw_text
- `test_decomposer_rejects_hallucinated_snippet` — test
  adversarial con un mock que devuelve snippet que no está en el
  input → error
- `test_decomposer_cache_hit_skips_llm` — mismo raw_text +
  hash match → no llama al provider
- `test_decomposer_cache_reresolves_when_catalog_changes` —
  agregar alias al catálogo entre dos calls del mismo hash →
  `resolved_json` se actualiza, LLM NO se llama
- `test_decomposer_unresolved_skills_reported` — skill que no
  está en catálogo → aparece en `unresolved_skills`
- `test_decomposer_empty_input_no_llm_call` — input vacío /
  whitespace-only → `empty_input` error sin llamar al provider
- `test_decomposer_rls_denies_cross_user_on_private_flag` —
  (si más adelante agregamos privacidad por query)
- `test_job_queries_content_hash_unique`

### Dependencias

- `zod` (ya en el proyecto) para validar el output del LLM.
- OpenAI SDK (ya en el proyecto).
- Ninguna nueva.
