# 📖 Domain Glossary — Recruitment Data Platform

> Glosario del dominio. Siempre que Claude use un término de esta lista,
> debe usarlo con esta definición. Si un término nuevo aparece
> repetidamente en conversaciones, agregarlo acá.

---

## Entidades principales

### Candidate

Persona que está o estuvo en algún momento en nuestro pipeline de
reclutamiento. Un candidate existe **una sola vez** aunque se haya
postulado a múltiples posiciones. Identificado internamente por `uuid`
y externamente por `teamtailor_id`.

### Job (posición / vacante)

Búsqueda abierta o cerrada de la empresa. Ejemplo: "Senior Backend
Engineer — Node.js". Un job tiene un título, departamento, ubicación y
status.

### Application (postulación)

Vínculo entre un **candidate** y un **job**. Un mismo candidate puede
tener múltiples applications (a distintos jobs, o al mismo job en
momentos distintos). Es la entidad central del pipeline.

### Stage (etapa)

Momento del pipeline en el que se encuentra una application. Ejemplos
típicos: `applied`, `screening`, `technical_interview`, `offer`,
`hired`, `rejected`. Los stages los define Teamtailor por job y se
sincronizan en la tabla `stages`. Cada `application` referencia un
`stage_id` + mantiene un `stage_name` como snapshot legible.

### Status

Estado de alto nivel de una application. Valores canónicos:

- `active` — en proceso
- `rejected` — descartado
- `hired` — contratado
- `withdrawn` — el candidato se bajó por su cuenta

> ⚠️ `stage` y `status` son cosas distintas. Stage es granular y del
> pipeline; status es de alto nivel.

### Evaluation (evaluación)

Registro de una decisión o feedback sobre un candidato en el contexto
de una application. Puede tener score numérico, decisión (accept /
reject), motivo de rechazo, y notas libres. Una application puede
tener múltiples evaluations (una por entrevista, por ejemplo).

### Rejection reason (motivo de rechazo)

Texto libre sincronizado desde Teamtailor describiendo por qué se
rechazó una application. Campo `evaluations.rejection_reason`.

### Rejection category (categoría de rechazo)

Versión **normalizada** del rejection reason, mapeada a un catálogo
acotado en `rejection_categories` (ver ADR-007). Ejemplos:
`technical_skills`, `communication`, `salary_expectations`. Es la
dimensión que alimenta los insights del spec §2.5.

### Evaluator (evaluador)

Persona interna de VAIRIX que realizó la evaluation. Sincronizado
desde Teamtailor en la tabla `users` (no confundir con `app_users`,
que son los usuarios de nuestra app). Típicamente un reclutador,
tech lead o hiring manager.

### File / CV

Archivo asociado a un candidate, generalmente su currículum. Se
almacena en Supabase Storage. El texto extraído se guarda en
`parsed_text` para búsqueda full-text y generación de embeddings.

### Note

Comentario libre asociado a un candidate o application. Proviene de
Teamtailor. No confundir con `notes` dentro de una evaluation.

### Source (origen)

Canal por el cual el candidato llegó al pipeline. Ejemplos: `linkedin`,
`referral`, `careers_page`, `sourcing_outbound`.

---

## Conceptos del producto

### Talent Pool

Conjunto de candidates que consideramos relevantes para futuras
búsquedas, independientemente de si tienen una application activa.
Un candidate puede estar en el talent pool aunque esté marcado como
`rejected` en todas sus applications históricas.

### Shortlist

Lista curada y nominal de candidates armada manualmente por un
reclutador para una búsqueda o propósito específico. Es más
efímera que el talent pool.

### Tag

Etiqueta asociada a un candidate. Puede ser:

- **Manual**: agregada por un reclutador (`high_potential`, `re_engage_2026`)
- **Automática**: derivada del contenido del CV o evaluations
  (`node.js`, `senior`, `fullstack`)

### Re-descubrimiento

Proceso de encontrar candidates históricos relevantes para una
búsqueda actual. Caso de uso principal del sistema.

### Recontacto

Acción de volver a contactar a un candidato dormant (rechazado o
inactivo hace tiempo) porque apareció una oportunidad que encaja.

### Dormant candidate

Candidate sin application activa por más de X meses (default: 12).
Objetivo prioritario de re-descubrimiento.

---

## Conceptos técnicos

### ETL (en este proyecto)

Proceso que extrae datos de Teamtailor, los transforma al modelo
interno y los carga en Postgres. En POC es un script batch; a futuro
puede ser un workflow continuo.

### Sync incremental

Estrategia de sincronización que solo trae registros modificados
desde el último run, usando `updated_at` como cursor. **Obligatoria
en producción**. El full sync solo se usa en backfill inicial.

### Upsert

Insertar si no existe, actualizar si existe. Siempre por `teamtailor_id`.
El ETL **nunca** debe hacer insert ciego.

### Embedding

Vector numérico que representa semánticamente un texto. En este
proyecto se generan embeddings para: CV (parsed_text), evaluations
(notes), y perfil agregado del candidate.

### Vector search

Búsqueda por similitud coseno (o producto interno) sobre la tabla
`embeddings`. Implementada con pgvector.

### Búsqueda híbrida

Combinación de filtros SQL estructurados (ej: "rechazados en 2024")
con búsqueda vectorial ("con perfil senior backend"). Es el modo
de búsqueda principal esperado del producto.

### RAG (Retrieval-Augmented Generation)

Patrón donde se recupera contexto relevante (de embeddings o SQL) y
se pasa a un LLM para que responda una pregunta en lenguaje natural.
Usado para preguntas sobre historial de un candidato.

### Raw data

Campo `jsonb` en cada tabla espejo de Teamtailor que guarda el payload
original. Sirve para debugging y para evolucionar el schema sin perder
información.

### app_users vs users

Dos tablas distintas:

- **`app_users`**: usuarios de nuestra aplicación (recruiters y admins
  de la plataforma). Vinculados a `auth.users` de Supabase.
- **`users`**: empleados de VAIRIX sincronizados desde Teamtailor que
  aparecen como evaluadores en evaluations o autores de notes.

Pueden o no superponerse. El email es la única forma de relacionarlos
(no hay FK directa).

### Dormant threshold

Umbral de meses sin application activa tras el cual un candidate se
considera `dormant`. Default: **12 meses**. Configurable vía env var
`DORMANT_THRESHOLD_MONTHS`.

### Content hash

SHA-256 calculado sobre el contenido a procesar + nombre de modelo.
Usado para:

- Detectar cambios en `files.content_hash` (binario del CV).
- Detectar cambios en `embeddings.content_hash` (texto fuente) y
  forzar regeneración.

### Service role key

Credencial de Supabase que bypassa RLS. **Solo** para jobs internos
(ETL, worker de embeddings). Nunca expuesta al cliente ni usada en
queries disparadas por un usuario.

---

## Anti-términos (evitar)

- **"Lead"** → usar `candidate`. Lead confunde con CRM de ventas.
- **"Profile"** → ambiguo. Usar `candidate` o `cv` según contexto.
- **"Interview"** → no es una entidad en este modelo. Lo que se
  persiste es la `evaluation` resultante.
- **"Ticket" / "Issue"** → no aplica; esto no es un sistema de tracking.
