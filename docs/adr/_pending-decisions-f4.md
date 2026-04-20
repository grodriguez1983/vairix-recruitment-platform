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

**Respuesta (cita del usuario, 2026-04-20):** _"siempre van a ser
pdf, pueden ser dos en algunos casos, el extracto de linkedin y el
cv oficinal teniendo este ultimo mas ponderancia"_.

**Decisión**: solo PDFs en `files.kind='cv'`. Pueden convivir 2 por
candidato. Cada fila `candidate_experiences` (y derivados) lleva
`source_variant ∈ {linkedin_export, cv_primary}` + `weight` numérico
(cv_primary > linkedin_export). `vairix_cv_sheet` y Google Sheet
externo quedan fuera del pipeline de matching — siguen visibles en
UC-04 pero no alimentan UC-11.

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

**Respuesta (cita del usuario, 2026-04-20):** _"si"_.

**Decisión**: dos paths con front-end clasificador determinístico en
`lib/cv/variant-classifier.ts`. Heurísticas propuestas (refinables
con fixtures reales): presencia de URL `linkedin.com/in/...`,
sección "Contact" con layout fijo de LinkedIn, fingerprint del
generator del PDF (metadata). Outputs:

- **LinkedIn export** → parser determinístico sobre estructura,
  sin LLM. Shape de salida idéntico al LLM path.
- **CV free-form** (default / fallback) → extractor LLM.

Ambos producen `experiences[]` + `experience_skills[]` con el mismo
shape. El clasificador es **conservador**: si no está seguro, cae a
LLM (free-form). El peso (P1) se deriva de `source_variant` pero es
ortogonal al path de extracción.

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

**Respuesta (cita del usuario, 2026-04-20):** _"lo dejo a tu
criterio"_.

**Decisión propuesta (a validar en ADR-015)**:

- **Overlapping por skill** sobre experiencias laborales. Para cada
  skill del candidato, se colapsan los intervalos (start, end) en
  sus uniones disjuntas; el total = suma de las uniones en meses.
  Dos trabajos 2020-2023 y 2022-2024 con React → unión 2020-2024 =
  4 años, no 5.
- **Side projects separados**: `candidate_experiences.kind IN
('work', 'side_project', 'education')`. Solo `work` cuenta para
  el filtro `min_years` de UC-11. Side projects + educación se
  muestran en la UI y alimentan el embedding del CV (F3-001), pero
  no el matcher estructurado.
- **Gaps laborales** se ignoran — no descuentan. Lo que importa es
  "cuántos años calendario tuvo exposure a la skill en trabajo
  real", no continuidad.
- **Una experiencia con N skills** en la descripción les da el
  período completo a las N. Sin LLM interpretando no hay forma
  razonable de atribuir fracciones; el ADR-015 documenta esto como
  **limitación conocida (overstate controlado)**: un candidato con
  React + Node + PostgreSQL en un mismo trabajo de 3 años aparece
  con 3 años en cada una. El recruiter es el humano en el loop.

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

**Respuesta (cita del usuario, 2026-04-20):** _"el que mejor haga
el trabajo"_ + selección explícita de la opción **(a)** tras
aclaración.

**Decisión**: opción (a) — hash = SHA256(`parsed_text || model ||
prompt_version`). `prompt_version` es un string versionado en el
código (`EXTRACTION_PROMPT_VERSION = '2026-04-v1'`). Bumpear
`prompt_version` es un **cambio de código consciente** en un PR
separado, con ADR nuevo **solo si cambia la semántica de
extracción** (ej. agregar/sacar campos del output). Typo fixes en
el prompt sin impacto semántico **no** bumpean la versión. Ventaja:
control total sobre cuándo se paga re-extract. Desventaja aceptada:
confiamos en el juicio del autor del PR para decidir si un cambio
es semántico (mitigado por review).

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

**Respuesta (cita del usuario, 2026-04-20):** _"lo que salga"_ +
_"usar open AI el modelo mas economico"_.

**Decisión**:

- **Provider**: **OpenAI** (reusa `OPENAI_API_KEY` ya en el
  proyecto para embeddings). La abstracción `ExtractionProvider`
  (mirror de `EmbeddingProvider`, ADR-005) queda confinada a
  `src/lib/cv/extraction/providers/` para no acoplar vendor.
- **Modelo**: **`gpt-4o-mini`** como default (el más económico de
  la familia 4o al 2026-04-20, ~USD 0.15/1M input + USD 0.60/1M
  output). Estimación del backfill inicial: ~1000 CVs × ~5500
  tokens = ~5.5M tokens ≈ **USD 1–2 total**. Si recall es bajo
  sobre fixtures reales, evaluamos fallback a `gpt-4o` en un slice
  dedicado, no se asume desde el día 1.
- **Budget**: sin hard-cap en la key (usuario dijo "lo que salga").
  Observabilidad desde día 1: logs estructurados con token counts
  por extracción (JSON a stderr, mirror del patrón
  `embeddings/worker-runtime.ts`) para poder decidir si vale la pena
  subir a 4o.
- **Data retention** 🚨: se acepta la política estándar de OpenAI
  (retention 30d, con opt-out vía account setting si es
  Enterprise; default en proyectos nuevos = retention on para
  abuse monitoring). Consecuencias:
  - Se documenta como **riesgo aceptado** en ADR-012 §Riesgos:
    "CVs con PII de candidatos (nombre, email, teléfono, LinkedIn,
    historia laboral) son enviados a OpenAI y pueden quedar hasta
    30d en su storage de abuse monitoring."
  - Se agrega entrada a `status.md §Deuda de seguridad` con gate
    de desbloqueo: "Antes de F4 contra tenant productivo,
    confirmar si la cuenta de OpenAI permite zero-retention y, si
    sí, habilitarlo. Si no, documentar como riesgo aceptado por
    producto."
  - La alternativa (Anthropic con retention off by default) queda
    como opción abierta en ADR-012 §Alternativas descartadas, con
    trigger de re-evaluación: "si compliance/legal de VAIRIX
    levanta el tema en Fase 2+".

---

---

## ✅ Decisiones consolidadas (2026-04-20)

| #   | Eje          | Decisión                                                                                                                                                                                            |
| --- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Alcance      | Solo PDFs `files.kind='cv'`. Hasta 2 por candidato: `linkedin_export` (weight menor) + `cv_primary` (weight mayor). Planilla VAIRIX + Google Sheet quedan fuera del matching.                       |
| P2  | Variants     | Clasificador determinístico (`lib/cv/variant-classifier.ts`). Dos paths: LinkedIn → parser determinístico; free-form → LLM. Shape de output idéntico.                                               |
| P3  | Años/skill   | Overlapping sobre `kind='work'`. Side projects + educación separados. Gaps no descuentan. N skills por experiencia → período completo a las N (overstate aceptado, documentado en ADR-015).         |
| P4  | Hash extract | `SHA256(parsed_text \|\| model \|\| prompt_version)`. `prompt_version` string en código, bump manual consciente. ADR nuevo si cambia semántica del output.                                          |
| P5  | Provider/LLM | OpenAI `gpt-4o-mini`. Sin hard-cap. Logs de tokens desde día 1. Data retention estándar aceptado como riesgo (entrada en `status.md §Deuda de seguridad`). Anthropic queda como plan B documentado. |

Estas decisiones alimentan:

- **ADR-012** CV structured extraction → P1, P2, P4, P5
- **ADR-013** Skills taxonomy → (independiente — se decide al redactar)
- **ADR-014** Job-description decomposition → reusa ADR-012
  §provider LLM
- **ADR-015** Matching & ranking → P3 (función `yearsForSkill`) +
  P1 (`weight` por variant en el scoring)

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
