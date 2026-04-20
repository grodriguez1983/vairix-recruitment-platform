# Pending product decisions — F4 (Matching por descomposición de llamado)

> Este archivo **bloquea** la redacción de los ADRs 012–015.
> No es un ADR; es un formulario. Una vez respondidas todas las
> preguntas, el contenido se traslada a los ADRs correspondientes y
> este archivo se **borra** (no queda en git como ruido — lo
> relevante queda en los ADRs y en memoria Chronicle con cita del
> usuario).
>
> Formato por pregunta: contexto → opciones → impacto en ADR →
> **tu respuesta** (editá la línea `**Respuesta:**`).
>
> Refs: UC-11 (`085c079`), spec.md §2.6 + §10 Fase 4 (`064c16f`).

---

## P1 — Alcance de "CV" para extracción estructurada

**Contexto**: hoy hay tres orígenes de "documento del candidato" en
el sistema:

- `files.kind='cv'` — PDFs/DOCX subidos a `candidate-cvs`
  (sincronizados de Teamtailor vía F1-007, parseados en F1-008 →
  `files.parsed_text`). Son los más numerosos.
- `files.kind='vairix_cv_sheet'` — planilla interna VAIRIX en
  xlsx/csv, subida manualmente por admin (F1-006b). Tiene estructura
  propia (columnas definidas).
- Custom field de Teamtailor `question_tt_id='24016'` — URL externa
  a un Google Sheet con la planilla VAIRIX (no vive en Storage). ~10%
  de los candidatos. Acceso a Google Drive diferido
  (`mem_fdf06239` en chronicle).

**Opciones**:

- (a) Solo `files.kind='cv'`. Simple. Ignora ~10% de la data VAIRIX
  de alta calidad.
- (b) `files.kind='cv'` + `files.kind='vairix_cv_sheet'`. Dos
  pipelines de extracción (PDF/DOCX free-form vs xlsx estructurado).
- (c) (a) + (b) + fetch de los Google Sheets. Bloqueado por la
  decisión de posponer auth a Google — requiere ADR propio.

**Impacto en ADR-012**: define si el extractor necesita un solo
path (LLM sobre free text) o dos (LLM + parser estructurado de
planilla). Si (b) o (c), la planilla estructurada probablemente se
ingesta sin LLM (columnas fijas → columnas tipadas) y solo el free
text pasa por LLM.

**Respuesta:** _(pendiente)_

---

## P2 — Distinción LinkedIn export vs CV "real"

**Contexto**: los PDFs de LinkedIn Profile tienen un shape
razonablemente estable (secciones "Experience", "Education",
"Skills", formato de fechas "Month Year - Month Year", etc.). Un
parser determinístico sobre ese shape podría extraer estructura sin
LLM, ahorrando tokens y siendo más auditable.

**Preguntas**:

- (a) ¿Vale la pena detectarlos y parsearlos por separado, o los
  pasamos todos por el mismo path LLM?
- (b) Si sí, ¿hay algún marcador del origen hoy (`raw_data` de TT,
  nombre del archivo, etc.) que permita clasificar _antes_ de
  parsear?

**Impacto en ADR-012**: si vamos por separado, el extractor tiene un
front-end clasificador (LinkedIn vs free-form) y dos backends. Si
no, un solo path LLM para todo.

**Respuesta:** _(pendiente)_

---

## P3 — Semántica de "años de experiencia por tecnología"

**Contexto**: si un candidato tiene dos trabajos simultáneos donde
usó React, o gaps entre trabajos, o side projects listados, ¿cómo
se cuentan los años?

**Opciones**:

- (a) **Overlapping**: si dos experiencias con React se superponen
  en el calendario, cuentan como un único período calendario (max
  fecha fin − min fecha inicio). Conservador, refleja tiempo real.
- (b) **Aditivo**: suma las duraciones de cada experiencia
  independiente. Infla el total pero refleja "exposure".
- (c) **Overlapping sobre experiencias laborales + aditivo sobre
  side projects**, diferenciado en el output.

**Sub-preguntas**:

- ¿Gaps laborales (6 meses sin trabajo) interrumpen el conteo de
  skills o se ignoran?
- Si una experiencia tiene "React, Node.js, PostgreSQL" en la
  descripción, ¿los 3 skills reciben el período completo, o
  intentamos ponderar por "rol principal" (imposible sin LLM
  interpretando)?

**Impacto en ADR-015**: define la función `yearsForSkill(candidate,
skill)`. Esto es el core del filtro `min_years` de UC-11.

**Respuesta:** _(pendiente)_

---

## P4 — Política de re-extracción ante cambio de modelo/prompt

**Contexto**: ADR-005 ya resolvió esto para embeddings: el
`content_hash` incluye el nombre del modelo, así que cambiar de
modelo invalida toda la caché automáticamente. Para extracción
estructurada tenemos una variable más: el **prompt**. Un cambio en
el prompt puede cambiar la extracción sin cambiar el modelo.

**Opciones**:

- (a) Hash = SHA256(`parsed_text || model || prompt_version`). Un
  bump manual de `prompt_version` reextrae todo. Requiere proceso
  humano para bumpear.
- (b) Hash = SHA256(`parsed_text || model || sha256(prompt)`).
  Cualquier edit al prompt reextrae todo, automáticamente. Riesgo:
  un typo fix en un comentario del prompt dispara ~1000 re-extracts
  (~$USD).
- (c) (a) + guardrail: el prompt_version solo se bumpea en un PR
  explícito, con ADR nuevo si cambia semántica.

**Impacto en ADR-012**: determina la columna de hash y el flujo de
deploy del prompt.

**Respuesta:** _(pendiente)_

---

## P5 — Budget y provider LLM

**Contexto**: para estimar, tomemos 1000 candidatos × 1 CV × ~4000
tokens promedio (parsed_text) + ~1500 tokens de prompt/output =
~5500 tokens por extracción. Total ~5.5M tokens en el primer
backfill. Con GPT-4o (USD 2.50/M input + USD 10/M output) ≈ USD 15
para el backfill completo. Con GPT-4o-mini o un modelo más chico,
fracción.

**Preguntas**:

- (a) ¿Provider? OpenAI (ya en uso para embeddings) vs Anthropic
  Claude vs un modelo open-source self-hosted. Confidencialidad vs
  calidad vs costo.
- (b) ¿Modelo "bueno" o "barato" para la extracción? Trade-off
  clásico: Gpt-4o-mini es ~20× más barato que GPT-4o pero con
  recall menor en extracción estructurada.
- (c) ¿Budget mensual hard-cap? Se puede poner `usage limit` en el
  proyecto de OpenAI (ya se hizo para embeddings — ver
  `status.md` §Deuda de seguridad).
- (d) ¿Data retention del provider está off en la key usada? Para
  OpenAI requiere zero-retention agreement (enterprise). Para
  Anthropic está off by default. Para self-hosted, irrelevante.

**Impacto en ADR-012**: define el `EmbeddingProvider`-equivalente
para extracción, la abstracción del caller, y la sección "riesgos"
del ADR sobre PII.

**Respuesta:** _(pendiente)_

---

## Próximos pasos (una vez completadas P1–P5)

1. Persistir las respuestas como memoria Chronicle con cita textual
   (`mcp__chronicle__chronicle action=remember memory_type=architectural`).
2. Redactar **ADR-012** (CV structured extraction) incorporando P1,
   P2, P4, P5 → status `Proposed`.
3. Redactar **ADR-013** (Skills taxonomy) → informa a ADR-014 y ADR-015.
4. Redactar **ADR-014** (Job-description decomposition) → reusa
   abstracción de provider LLM de ADR-012.
5. Redactar **ADR-015** (Matching & ranking) incorporando P3 →
   cierra el loop del UC-11.
6. Pasar los 4 ADRs a `Accepted` con tu aprobación explícita.
7. Actualizar `docs/data-model.md` con las tablas nuevas.
8. Actualizar `docs/roadmap.md` con el épico F4 sliceado.
9. **Borrar este archivo** (`git rm docs/adr/_pending-decisions-f4.md`).

Hasta que P1–P5 no estén respondidas, no arranca código ni
migraciones.
