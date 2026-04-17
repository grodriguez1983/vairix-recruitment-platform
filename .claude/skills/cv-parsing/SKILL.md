---
name: cv-parsing
description: Cómo descargar, almacenar, parsear y acceder a CVs en este proyecto (bucket privado, signed URLs, pdf-parse, mammoth, detección de scanned, content_hash). Usar cuando la tarea toque src/lib/cv o el bucket candidate-cvs.
---

# CV Parsing

## Cuándo aplicar este skill

- Implementar o modificar `src/lib/cv/downloader.ts` o `parser.ts`.
- Agregar un nuevo tipo de archivo soportado.
- Depurar un CV que no parsea bien.
- Trabajar en OCR (Fase 2+).
- Crear el endpoint de signed URLs.

## Principios no negociables

1. **Bucket privado.** `candidate-cvs` NO es público. Acceso solo
   por signed URL generada por API route autenticada.
2. **Path determinístico**: `<candidate_uuid>/<file_uuid>.<ext>`.
   Nunca meter el nombre original del archivo en el path.
3. **Signed URL TTL = 1 h.** Fijo. No "15 minutos porque es más
   seguro" ni "24h porque es más práctico". 1 hora.
4. **Content hash gobierna re-upload.** SHA-256 del binario. Si
   matchea → skip. Siempre.
5. **No persistir URL de Teamtailor.** Expiran; son inútiles
   después del ventana del sync.
6. **Tamaño máximo 10 MB.** Rechazar el resto en ingesta, loggear
   warning.

## Tipos soportados (Fase 1)

| Extensión | Parser | Notas |
|---|---|---|
| `.pdf` | `pdf-parse` | Rápido, falla con escaneados |
| `.docx` | `mammoth` | Extrae texto plano |
| `.doc` | intentar, fallback error | Legacy, marginal |
| `.txt` | `fs.readFile` | Trivial |
| `.rtf` | `striptags` | Usual mixto |

Fuera de esta lista → `parse_error = 'unsupported_format'`. El
archivo queda en storage pero sin `parsed_text`.

## Flujo de ingesta (downloader)

```typescript
export async function downloadCvFromTeamtailor(
  file: TTFileRecord, candidate: CandidateRow
): Promise<FileRow | SkippedFile> {
  // 1. Descargar binario desde URL presignada de TT
  const binary = await downloadWithinTtl(file.url);
  if (binary.size > MAX_FILE_SIZE) {
    log.warn('cv oversized', { ttId: file.id, size: binary.size });
    return { skipped: 'oversized' };
  }

  // 2. Hash
  const hash = sha256(binary.bytes);
  const existing = await repos.files.findByTtId(file.id);

  // 3. Skip si hash igual
  if (existing && existing.content_hash === hash) {
    return existing;
  }

  // 4. Upload (si cambió, sobrescribe)
  const path = `${candidate.id}/${file.id}.${ext(file)}`;
  await storage.upload('candidate-cvs', path, binary.bytes);

  // 5. Upsert metadata; invalidar parsed_text si cambió binario
  return repos.files.upsert({
    teamtailor_id: file.id,
    candidate_id: candidate.id,
    storage_path: path,
    file_type: ext(file),
    file_size_bytes: binary.size,
    content_hash: hash,
    parsed_text: existing?.content_hash === hash ? existing.parsed_text : null,
    parsed_at: existing?.content_hash === hash ? existing.parsed_at : null,
    parse_error: null,
  });
}
```

## Flujo de parsing (parser worker)

Disparado post-upload (trigger en `files` insert/update).

```typescript
export async function parseCv(fileId: string): Promise<void> {
  const file = await repos.files.findById(fileId);
  if (file.parsed_text && file.parsed_at) return; // ya parseado

  const binary = await storage.download('candidate-cvs', file.storage_path);

  try {
    const raw = await dispatchParser(file.file_type, binary);
    const normalized = normalize(raw);

    if (file.file_type === 'pdf' && normalized.length < 200) {
      // Heurística simple de escaneado
      await repos.files.update(fileId, {
        parse_error: 'likely_scanned',
        parsed_at: null,
      });
      return;
    }
    if (normalized.length === 0) {
      await repos.files.update(fileId, {
        parse_error: 'empty_text',
        parsed_at: null,
      });
      return;
    }

    await repos.files.update(fileId, {
      parsed_text: normalized,
      parsed_at: new Date(),
      parse_error: null,
    });
  } catch (err) {
    await repos.files.update(fileId, {
      parse_error: 'parse_failure',
      parsed_at: null,
    });
    log.error('cv parse failed', { fileId, err });
  }
}
```

**Regla**: un `parse_error` no reintenta automáticamente. Un admin
re-dispara manual desde el panel. Así evitamos loops de retry.

## Normalización del texto

```typescript
function normalize(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
```

No más magia. El resto del cleaning lo hace el modelo de embeddings.

## Signed URLs

Endpoint: `POST /api/files/:id/signed-url`. Requiere auth.

```typescript
export async function POST(req, { params }) {
  await requireAuth(req);
  const file = await repos.files.findById(params.id);
  if (!file) return Response.json({ error: 'not_found' }, { status: 404 });
  if (file.deleted_at) return Response.json({ error: 'deleted' }, { status: 410 });

  const { signedUrl, expiresAt } = await storage.createSignedUrl(
    'candidate-cvs',
    file.storage_path,
    3600, // 1h
  );
  return Response.json({ url: signedUrl, expiresAt });
}
```

Cliente cachea el signed URL por ~50 min (margen antes de expiración).

## OCR (Fase 2+)

**No en Fase 1.** CVs escaneados quedan marcados `likely_scanned`;
quedan accesibles al humano pero no alimentan búsqueda.

Plan Fase 2:
- Evaluar Tesseract local (gratis, ES+EN) vs Textract/Document AI.
- Selectivo: OCR solo si el candidate está en shortlist o se busca
  explícitamente.
- Re-parsing idempotente: `parse_error = 'likely_scanned'` dispara
  OCR, resultado persiste en `parsed_text`.

Cuando se active: nuevo ADR.

## Full-text search sobre `parsed_text`

Índice GIN con `to_tsvector('simple', ...)` (ver
`data-model.md` §10). **Config `simple`** para no aplicar stemming
agresivo que rompe mix ES/EN.

Query típica:

```sql
select id, candidate_id
from files
where to_tsvector('simple', parsed_text) @@ plainto_tsquery('simple', $1)
  and parse_error is null
  and deleted_at is null;
```

## Qué NO hacer

- ❌ Bucket público para CVs.
- ❌ Signed URLs con TTL de días.
- ❌ Parsing en el ETL (ADR-006).
- ❌ Retry automático de parse_error.
- ❌ Guardar el nombre original del archivo en el path de storage.
- ❌ OCR en Fase 1.
- ❌ LLM para "parseo estructurado" en Fase 1 (costo + complejidad).

## Checklist

- [ ] Download chequea tamaño máximo.
- [ ] Content hash decide re-upload.
- [ ] `parsed_text` invalidado si binario cambió.
- [ ] Signed URL SIEMPRE 1h.
- [ ] `likely_scanned` detectado en PDFs cortos.
- [ ] Tests para cada tipo soportado.
- [ ] RLS restringe acceso al bucket.

## Referencias

- ADR-006 — decisiones de storage y parsing.
- `data-model.md` §10 — schema de `files`.
- `docs/use-cases.md` UC-07 — acceptance criteria.
- `docs/operation-classification.md` — borrado de CVs es Tier 3.
