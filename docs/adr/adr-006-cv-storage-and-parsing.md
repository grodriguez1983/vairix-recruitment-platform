# ADR-006 — CV storage, parsing y acceso

- **Estado**: Aceptado
- **Fecha**: 2026-04-17
- **Decisores**: Equipo interno
- **Relacionado con**: `spec.md` §6, `data-model.md`, ADR-001, ADR-003

---

## Contexto

El spec define que los CVs se almacenan en Supabase Storage y que el
parsing en Fase 1 es "texto plano", sin entrar en detalles. Preguntas
abiertas:

- Bucket público vs privado, URLs firmadas.
- Las URLs de Teamtailor son presignadas y con expiración corta
  (documentado en `teamtailor-api-notes.md` §5.7): no se pueden
  guardar como referencia perpetua.
- Qué librerías usar para parsear PDF y DOCX.
- Qué pasa con PDFs escaneados (requieren OCR).
- Idiomas en los CVs (ES + EN mix confirmado).

---

## Decisión

### 1. Storage: bucket privado en Supabase

Un único bucket: `candidate-cvs`.

- **Privado** (no público).
- Acceso exclusivamente vía URLs firmadas generadas on-demand.
- Organización de paths:
  ```
  candidate-cvs/
    <candidate_uuid>/
      <file_uuid>.<ext>
  ```
- Tipos de archivo permitidos: `pdf`, `docx`, `doc`, `txt`, `rtf`.
- Tamaño máximo por archivo: **10 MB** (rechazar en ingesta si es
  mayor, log warning).

### 2. Ciclo de vida del archivo

Al sincronizar un `file` desde Teamtailor:

1. Obtener URL presignada desde la API de Teamtailor.
2. Descargar el binario dentro de la ventana de validez de la URL.
3. Subir a Supabase Storage en el path correspondiente.
4. Registrar metadata en `files`: `storage_path`, `file_type`,
   `file_size_bytes`, `content_hash` (SHA-256 del binario).
5. La URL de Teamtailor **no se persiste**; solo el path interno.

Al re-sincronizar el mismo `file`:

- Comparar `content_hash` del binario recién descargado con el
  persistido.
- Si es igual → no re-subir ni reprocesar.
- Si difiere → sobrescribir storage, invalidar `parsed_text`
  (setear `parsed_text = null`, `parsed_at = null`), disparar
  re-parsing.

### 3. Acceso desde la app

- URLs firmadas con **expiración 1 hora**, generadas en API routes
  de Next.js autenticadas.
- El frontend nunca construye URLs de Storage; siempre pide a la
  API una URL firmada fresca cuando necesita mostrar/descargar el CV.
- Cache del signed URL del lado del cliente por < 50 min para evitar
  expiración en medio de una sesión.

### 4. Parsing

Librerías por tipo:

| Tipo | Librería | Notas |
|---|---|---|
| PDF | `pdf-parse` (Node) | Rápido, funciona para PDFs nativos. |
| DOCX | `mammoth` | Extrae texto plano ignorando formato. |
| DOC (legacy) | intentar conversión, fallback a error | Marginal. |
| TXT / RTF | `fs.readFile` + `striptags` si RTF | Trivial. |

Pipeline de parsing (en función independiente, disparada post-upload):

1. Descargar archivo desde Storage.
2. Elegir parser según `file_type`.
3. Extraer texto.
4. Normalizar (whitespace, line breaks, encoding).
5. Persistir en `files.parsed_text`, setear `parsed_at = now()`.
6. Si falla:
   - Setear `parse_error` con código identificable
     (`unsupported_format`, `parse_failure`, `empty_text`,
     `likely_scanned`).
   - No reintentar automáticamente; admin puede re-disparar manual.

### 5. OCR

**Fuera de scope en Fase 1.**

Si un PDF parsea en menos de 200 caracteres de texto útil, se asume
escaneado y se marca `parse_error = 'likely_scanned'`. El archivo
queda accesible pero no alimenta búsqueda full-text ni embeddings.

Admin tiene un botón "re-parse" y una columna en el panel de sync
que muestra CVs con parse_error para revisar volumen.

Fase 2 evalúa:
- Tesseract local para ES + EN.
- Google Document AI / AWS Textract para mayor calidad.
- Ser selectivos: OCR solo si el candidate es relevante
  (ej: está en una shortlist).

### 6. Idioma y full-text search

CVs en mix ES/EN → configuración Postgres:

- Índice GIN sobre `parsed_text` con `to_tsvector('simple', ...)`
  (sin stemming agresivo) para funcionar igual con ambos idiomas.
- Búsqueda textual exacta y prefix match; no stemming.
- La profundidad semántica la da el embedding, no el full-text.

Si en el futuro necesitamos stemming por idioma:

- Agregar columna `detected_language` (con `franc` o similar).
- Mantener dos índices: `tsvector` dinámico por idioma.

### 7. Seguridad

- Storage con RLS activa; policies que solo permiten operaciones
  via service role o via JWT con rol válido.
- Logs de acceso a CVs en tabla `cv_access_log` (Fase 2 opcional).
- Si se elimina un candidate (hard delete futuro): purgar archivos
  del bucket. En soft delete: conservar.

---

## Alternativas consideradas

### A) Bucket público con URLs directas
- **Pros**: simple, cacheable por CDN.
- **Contras**: datos personales expuestos a cualquiera con la URL.
  Inaceptable aun sin compliance formal.
- **Descartada**.

### B) Guardar las URLs de Teamtailor sin re-descargar
- **Pros**: ahorra storage.
- **Contras**: URLs expiran; cuando expiran, el archivo se pierde
  para nosotros. Inviable.
- **Descartada**.

### C) S3 / R2 externo
- **Pros**: barato, conocido.
- **Contras**: otro servicio, otro set de credenciales, no se
  integra con RLS de Supabase. Sin ventaja clara.
- **Descartada**.

### D) OCR desde día uno
- **Pros**: cobertura 100%.
- **Contras**: latencia en parsing, costo (Textract ~$1.50/1000
  páginas), complejidad.
- **Postergada** hasta confirmar volumen real de CVs escaneados.

### E) LLM para "parsing estructurado" desde día uno
- Se plantea en spec §6 como "fase avanzada". No se introduce en
  Fase 1 por costo y complejidad. Fase 2+.

---

## Consecuencias

### Positivas
- Cero dependencia de URLs externas presignadas después del sync.
- Modelo de acceso claro y auditable.
- Parsing simple y probado; `pdf-parse` y `mammoth` son estándar.
- Re-parsing idempotente gracias al `content_hash` del binario.

### Negativas
- Duplicamos el storage (Teamtailor + Supabase). Aceptable: los CVs
  son propiedad del candidate, no de Teamtailor; ser dueños del
  binario es un feature.
- CVs escaneados quedan ciegos a la búsqueda hasta Fase 2. Esperamos
  que sea minoría; monitorear con métrica en panel admin.
- Sin stemming, búsquedas textuales básicas son menos flexibles.
  Mitigado por embeddings que capturan semántica.

---

## Criterios de reevaluación

- Si > 20% de CVs caen en `likely_scanned`: priorizar OCR.
- Si el storage supera los 5 GB: revisar política de retención de
  versiones históricas de CV.
- Si aparece requerimiento de compliance/GDPR real: agregar
  encriptación at-rest adicional y log de accesos.
