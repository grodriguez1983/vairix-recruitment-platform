---
name: teamtailor-integration
description: Cómo integrar con la API de Teamtailor sin romper rate limits ni perder datos. Usar cuando la tarea toque src/lib/teamtailor, cualquier syncer, el webhook receiver (Fase 2+) o fixtures de tests de integración externos.
---

# Teamtailor Integration

## Cuándo aplicar este skill

- Escribir o modificar código en `src/lib/teamtailor/`.
- Crear o tocar un `EntitySyncer` en `src/lib/sync/`.
- Agregar fixtures en `tests/fixtures/teamtailor/`.
- Depurar un problema de sync (429, 5xx, data mismatch).
- Preparar el webhook receiver de Fase 2+.

## Principios no negociables

1. **Rate limit primero, features después.** Todo request a
   Teamtailor pasa por el token bucket de `src/lib/teamtailor/client.ts`.
   Ninguna función de dominio hace `fetch` directo.
2. **Paginación obligatoria.** Nunca asumir que un endpoint
   devuelve todo en una página. Usar el iterable
   `client.paginate(path, params)`.
3. **JSON:API no es JSON.** Los payloads vienen con
   `{data, included, links}`. El dato útil está en `attributes`,
   las relaciones en `relationships`. Hay un normalizer en
   `src/lib/teamtailor/json-api.ts`; usarlo.
4. **Idempotencia por `teamtailor_id`.** Toda persistencia usa
   upsert con `ON CONFLICT (teamtailor_id) DO UPDATE`.
5. **Nunca persistir URLs firmadas.** Las URLs de Teamtailor
   expiran. Descargar, subir a Storage, guardar path interno.

## Headers obligatorios

Cada request incluye:

```
Authorization: Token token={TEAMTAILOR_API_TOKEN}
X-Api-Version: {TEAMTAILOR_API_VERSION}
Content-Type: application/vnd.api+json
```

El header `X-Api-Version` es obligatorio. Sin él, la API puede
cambiar de comportamiento silenciosamente.

## Rate limiting

- Límite documentado: ~50 req/10s por token (verificar contra
  tenant real).
- Config local: `TEAMTAILOR_RATE_TOKENS_PER_SECOND=4`, burst 10.
- Backoff exponencial con jitter ante 429/5xx:
  `1s × 2^n + random(0, 1000ms)`, máximo 5 intentos.
- Si la respuesta trae `Retry-After`, respetarla (override del
  backoff propio).
- Implementación: `src/lib/teamtailor/rate-limiter.ts`.

## Patrón de sync incremental

```typescript
// Pseudocódigo — la implementación real usa el cliente tipado.
const cursor = await loadLastSyncedAt('candidates');
for await (const page of client.paginate('/candidates', {
  filter: { 'updated-at': { from: cursor } },
  include: 'job-applications',
  page: { size: 30 },
})) {
  for (const record of page.data) {
    try {
      await upsertCandidate(record);
    } catch (err) {
      await logSyncError({
        entity: 'candidates',
        teamtailorId: record.id,
        error: err,
      });
    }
  }
}
await advanceLastSyncedAt('candidates', newCursor);
```

El cursor avanza **solo si el batch completo no tuvo errores
fatales**. Errores por registro no bloquean el avance.

## Testing (MSW)

- **Prohibido** pegar a Teamtailor real desde tests CI.
- Fixtures JSON reales anonimizadas en
  `tests/fixtures/teamtailor/`. Anonimización: reemplazar
  `first-name`, `last-name`, `email`, `phone`, `linkedin-url`,
  `pitch`, `parsed_text`. Mantener estructura y IDs.
- Tests mandatorios (ver `docs/test-architecture.md`):
  - Paginación con 3+ páginas.
  - 429 con `Retry-After` respetado.
  - 5xx transitorio → backoff y retry.
  - 4xx persistente → error claro, sin retry.
  - Rate limit global (100 req en < 10s respeta bucket).

## Quirks conocidos (actualizar al encontrar uno)

- IDs son **strings**, no integers. Nunca hacer `parseInt`.
- `tags` en candidates es array de **strings**, no objetos.
- Datetimes en ISO 8601; confirmar que vengan en UTC.
- Soft-delete en Teamtailor: comportamiento a verificar
  (¿desaparece de `/candidates` o viene con flag?). Documentar
  en `teamtailor-api-notes.md` §7 al encontrar el caso.
- Custom fields: pendiente de acceso al tenant. Vienen en
  `attributes.custom-fields`; mapearlos explícitamente cuando
  los tengamos.

## Qué NO hacer

- ❌ `fetch('https://api.teamtailor.com/...')` fuera del cliente.
- ❌ Hardcodear el token en tests (usar `TEAMTAILOR_API_TOKEN_TEST`).
- ❌ Asumir que un campo siempre existe. Validar con Zod/similar.
- ❌ Persistir URL de `attributes.resume` como `file_url`.
- ❌ Pegar a producción en workflows de CI de PR. Solo en
  `backfill.yml` con `workflow_dispatch` manual.

## Checklist antes de codear

- [ ] Verificar versión `X-Api-Version` vigente.
- [ ] Confirmar modo de paginación del endpoint (offset vs cursor).
- [ ] Listar custom fields del tenant (pendiente).
- [ ] Correr smoke con `DRY_RUN=true`.

## Referencias

- `docs/teamtailor-api-notes.md` — fuente de verdad de la API.
- ADR-004 — orquestación del ETL.
- `docs/use-cases.md` UC-05 — acceptance criteria del sync.
- Paper GS §4.3 _Verifiable_ — tests adversariales contra mocks.
