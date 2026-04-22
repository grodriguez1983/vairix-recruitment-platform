# 🔌 Teamtailor API — Notas de integración

> ⚠️ **Este documento es un punto de partida.** Varios datos deben
> verificarse contra la documentación oficial vigente y contra el
> tenant real antes de implementar. Las secciones marcadas con
> **[VERIFICAR]** son especialmente sensibles al cambio.

Documentación oficial: https://docs.teamtailor.com/

---

## 1. Autenticación

- API REST basada en el estándar **JSON:API**.
- Autenticación por **API token** (se genera desde el admin de
  Teamtailor → Integraciones → Claves API).
- Headers requeridos en cada request:
  ```
  Authorization: Token token=YOUR_API_KEY
  X-Api-Version: 20240904
  Accept: application/vnd.api+json
  ```
- El header `X-Api-Version` **es obligatorio**. Sin él, la API
  responde `406 Invalid/Missing API Version` y te dice la version
  vigente en el body del error.
- **Versión vigente verificada 2026-04-17**: `20240904`.

### ⚠️ Base URL según región del tenant

Teamtailor tiene endpoints regionales. **La URL correcta aparece
en la página "Claves API" del admin** ("URL base para la api").

| Región        | Base URL                           |
| ------------- | ---------------------------------- |
| Global / EU   | `https://api.teamtailor.com/v1`    |
| North America | `https://api.na.teamtailor.com/v1` |

**Este tenant (VAIRIX) es NA** → `https://api.na.teamtailor.com/v1`.

Gotcha: si usás la base URL equivocada, toda request devuelve `401`
aunque el token sea correcto, porque el tenant no existe en el
endpoint global. El 401 NO indica "región equivocada" — es
indistinguible de un token inválido.

### Scopes de la clave

La UI de Teamtailor ofrece:

- **Alcance**: Públicas / Internas / Administrador
- **Permisos**: Leer / Escribir (checkboxes)

Para el ETL del proyecto necesitamos **Administrador + Leer**
(lectura de candidates, applications, jobs, stages, users, notes,
files, incluso datos privados y no publicados). **No** necesitamos
`Escribir` — el ETL es read-only (ADR-002). Principio de least
privilege: emitir claves sin `Escribir`.

---

## 2. Rate limits

- **[VERIFICAR]** El límite público documentado ronda las
  **~50 requests cada 10 segundos** por token.
- Respuesta al exceder el límite: HTTP `429 Too Many Requests`.
- Headers útiles de respuesta:
  - `X-Rate-Limit-Limit`
  - `X-Rate-Limit-Remaining`
  - `X-Rate-Limit-Reset`

### Estrategia recomendada

- Cliente con **token bucket** limitado a ~4 req/s con burst de 10.
- **Backoff exponencial** ante 429 (ej: 1s, 2s, 4s, 8s).
- **Jitter** aleatorio para evitar thundering herd en retries.
- Respetar `Retry-After` si viene en la respuesta.

---

## 3. Formato de respuestas (JSON:API)

Todas las respuestas siguen el estándar JSON:API:

```json
{
  "data": [
    {
      "id": "123",
      "type": "candidates",
      "attributes": { ... },
      "relationships": { ... }
    }
  ],
  "included": [ ... ],
  "links": {
    "first": "...",
    "next": "...",
    "last": "..."
  },
  "meta": {
    "page-count": 10,
    "record-count": 250
  }
}
```

### Implicaciones

- Los IDs son **strings**, no integers.
- Para obtener relaciones en el mismo request: `?include=job,user`.
- El payload real vive en `attributes`, no en la raíz del objeto.
- Nuestro ETL debe normalizar esto antes de persistir.

---

## 4. Paginación

Teamtailor soporta dos modos de paginación. **[VERIFICAR]** cuál aplica
para cada endpoint antes de implementar.

### Offset (más común)

```
GET /v1/candidates?page[number]=1&page[size]=30
```

- `page[size]` máximo suele ser **30**.
- Para sync incremental, ordenar por `updated-at` desc.

### Cursor (si está disponible)

Preferir cursor para sync grandes porque no sufre drift.

---

## 5. Endpoints relevantes para este proyecto

### 5.1 `GET /v1/candidates`

Lista de candidatos. Filtros útiles:

- `filter[updated-at][from]=2026-01-01` — sync incremental
- `filter[email]=...`
- `include=job-applications,activities`

Campos en `attributes` (no exhaustivo, **[VERIFICAR]**):

- `first-name`, `last-name`
- `email`, `phone`
- `linkedin-url`, `facebook-url`
- `pitch` (texto libre del candidato)
- `resume` (URL firmada de S3, **expira ~60s** — TT genera el PDF
  por candidato; para sourced candidates es la **única** fuente de
  CV. Nuestro ETL la descarga en la misma pasada y persiste el
  binario en `files` con `source='candidate_resume'`. Ver ADR-018.)
- `tags` (array de strings)
- `created-at`, `updated-at`
- `sourced` (boolean)
- `connected` (boolean)

### 5.2 `GET /v1/job-applications`

Relación candidate ↔ job.

Campos en `attributes`:

- `cover-letter`
- `created-at`, `updated-at`
- `rejected-at`, `sourced`

Relaciones clave (en `relationships`):

- `candidate`
- `job`
- `stage`

### 5.3 `GET /v1/jobs`

Campos en `attributes`:

- `title`, `pitch`, `body`
- `status` (`open`, `draft`, `archived`, `unlisted`)
- `created-at`, `updated-at`
- `tags`
- `department`, `location` (vienen como relaciones)

### 5.4 `GET /v1/stages`

Catálogo de stages. Necesario para traducir `stage_id` a nombre
humano en el pipeline.

### 5.5 `GET /v1/users`

Evaluadores internos (reclutadores, hiring managers). Necesario
para poblar el campo `evaluator` en `evaluations`.

### 5.6 `GET /v1/notes` / `GET /v1/candidates/:id/notes`

Comentarios asociados a un candidate.

### 5.6b `GET /v1/interviews` (🕵️ descubierto 2026-04-18)

**No figura en la docs pública** pero responde 200 y retorna las
evaluaciones completas del tenant (1908 en VAIRIX). Cada `interview`:

- `attributes`: `note` (free-text → `evaluations.notes`), `status`
  (`published | draft`), `created-at`, `updated-at`.
- `relationships`: `candidate` (REQUIRED), `job`, `user`
  (evaluador), `answers` (array).

Con `?include=answers,answers.question` cada página sideloada trae
los `answer` y las `question` referenciadas. Cada answer carga
`attributes` con los cinco posibles slots tipados según
`question-type`: `text | range | boolean | number | date`
(lower-case en el answer; PascalCase en la question).

**Custom questions del tenant**: Teamtailor admite plantillas de
interview-kit con questions custom. En VAIRIX,
`question_id=24016` es el campo `"Información para CV"` (Text) que
guarda una URL a un Google Sheet con la normalización del CV al
formato VAIRIX. El syncer no bakea IDs de tenant: cada answer cae
en `evaluation_answers` con `question_tt_id` + columna tipada.

Cursor incremental: `filter[updated-at][from]=<iso>`. Paginación y
rate-limit se comportan igual que el resto de endpoints.

### 5.7 `GET /v1/uploads` (verificado 2026-04-18, probe `src/scripts/probe-uploads.ts`)

Endpoint **top-level `/v1/uploads`** existe. Funciona también como
sideload en `/v1/candidates?include=uploads` (relationship `uploads`,
to-many).

Atributos (`attributes`):

- `url` — URL presignada de S3 (`teamtailor-na-maroon.s3.us-west-2.amazonaws.com/uploads/...`).
  **Expira** — descargar dentro de la ventana de sync y re-almacenar
  en Supabase Storage.
- `fileName` — nombre original con extensión (ej. `emir-drube-resume.pdf`,
  `cover_letter_eng.docx`, `image-2-.png`). Derivar `file_type` de la
  extensión — **NO viene** `size` ni `mimeType` en el payload.
- `internal` — boolean. `true` = subido internamente por recruiter;
  `false` = subido por el candidato durante la aplicación. Guardar el
  flag, filtrar por él si hace falta distinguir fuentes.
- `createdAt`, `updatedAt` — ISO-8601.

Relationships (se populan con `?include=<rel>`):

- `candidate` — to-one `{ type: 'candidates', id: '<tt_id>' }`. Solo
  aparece la `data` cuando pedís `include=candidate` o cuando sideloade
  desde `/candidates`. Sin eso, solo viene el objeto `links`.
- `job` — to-one, para uploads atadas a una aplicación.
- `answer` — to-one, para attachments de preguntas de la aplicación.

**Estrategia de sync recomendada** (ADR-004-style, parejo al resto):

Usar `/v1/uploads?include=candidate` con cursor incremental por
`updated_at`. Resuelve el `candidate_id` externo al `uuid` interno
como los otros syncers. No usar el path sideload en `/candidates`
porque el watermark por-entidad (sync_state) queda cleaner con un
endpoint dedicado.

**Heurística para distinguir CVs de otros uploads** (sin `mimeType`):

- Extensión en `fileName`: `.pdf`, `.doc`, `.docx` → CV candidate.
- `.xlsx`, `.xls`, `.csv` → planilla VAIRIX (F1-006b, `kind='vairix_cv_sheet'`).
- `.png`, `.jpg`, `.heic`, etc. → otros (probablemente fotos, no CV).
- Resto → marcar como "unknown" en files y dejar el parser decidir.

### 5.8 Custom fields

Teamtailor permite campos personalizados por tenant. **[VERIFICAR]**
cuáles tiene configurados tu instancia y mapearlos explícitamente.
Vienen en `attributes.custom-fields` o similar.

---

## 6. Webhooks (futuro)

Teamtailor soporta webhooks para eventos de:

- `candidate.created`, `candidate.updated`
- `job-application.created`, `job-application.updated`, `job-application.moved`
- `job.published`, `job.archived`

En POC usamos **polling con sync incremental**.
Webhooks quedan para Fase 2+ (ver roadmap en `spec.md`).

---

## 7. Quirks conocidos

> Esta sección se completa a medida que aparecen. Actualizar cada vez
> que nos topemos con un comportamiento raro.

- Los campos datetime vienen en **ISO 8601 con timezone**, pero verificar
  que siempre vengan en UTC.
- El campo `tags` en candidates es un array de strings, no objetos con id.
  Para estructurarlos, generamos nuestra propia tabla `tags`.
- **[VERIFICAR]** El comportamiento de soft-delete: ¿un candidate
  borrado desaparece de `/candidates` o aparece con flag?

---

## 8. Checklist antes de codear el ETL

- [ ] Confirmar versión de `X-Api-Version` a usar
- [ ] Confirmar rate limit real con tenant de pruebas
- [ ] Confirmar modo de paginación por endpoint
- [ ] Listar custom fields de nuestro tenant
- [ ] Probar descarga de un CV (URL + auth)
- [ ] Probar filter `updated-at[from]` con un valor conocido
- [ ] Confirmar comportamiento ante candidate borrado
