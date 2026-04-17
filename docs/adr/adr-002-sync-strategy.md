# ADR-002 — Estrategia de sincronización con Teamtailor

- **Estado**: Aceptado
- **Fecha**: 2026-04-17
- **Decisores**: Equipo interno
- **Relacionado con**: `spec.md` §5, `teamtailor-api-notes.md`

---

## Contexto

El sistema depende exclusivamente de **Teamtailor** como fuente de
datos. Necesitamos una estrategia de ingesta que sea:

- Confiable frente a rate limits (~50 req / 10s).
- Eficiente (no traer todo el dataset en cada corrida).
- Idempotente (re-correrlo no genera duplicados ni corrupción).
- Observable (saber qué se sincronizó, cuándo, con qué error).
- Simple de operar en POC, pero evolucionable a near-real-time.

---

## Decisión

Adoptar **polling batch con sync incremental por `updated_at`**
como estrategia primaria de ingesta para Fase 1.

### Detalles

1. **Backfill inicial**: una única corrida full, paginada, respetando
   rate limits. Puede tardar horas. Se ejecuta manualmente.

2. **Sync incremental**: corrida periódica (cron o manual en POC) que:
   - Lee `sync_state.last_synced_at` para la entidad.
   - Llama al endpoint con
     `filter[updated-at][from]=<last_synced_at>`.
   - Itera todas las páginas.
   - **Upsert por `teamtailor_id`** a cada registro.
   - Actualiza `sync_state` al finalizar.

3. **Orden de sync** (por dependencias):
   1. `jobs`
   2. `candidates`
   3. `applications`
   4. `evaluations` / `notes`
   5. `files` (descarga + storage + parse)

4. **Manejo de errores**:
   - Error de un registro → se loggea, se incrementa contador, el
     batch continúa.
   - Error fatal (auth, 5xx persistente) → se marca el run como
     `error`, se preserva `last_synced_at` previo, se alerta.

5. **Webhooks**: **fuera de scope** para Fase 1. Se adoptarán en
   Fase 2+ para reducir latencia a near-real-time.

---

## Alternativas consideradas

### A) Full sync en cada corrida

- **Pros**: simple, sin estado.
- **Contras**: inviable por rate limits a volumen real; desperdicia
  cuota; lento.
- **Descartada**.

### B) Webhooks desde el inicio

- **Pros**: near-real-time.
- **Contras**: requiere endpoint público autenticado, reintentos,
  deduplicación, y **aún así** hace falta sync incremental como
  safety net por eventos perdidos. Overkill para POC.
- **Descartada en Fase 1**, adoptar en Fase 2+ **en combinación** con
  sync incremental, no como reemplazo.

### C) Cursor opaco provisto por Teamtailor

- **Pros**: sin drift de paginación.
- **Contras**: soporte parcial según endpoint; menos universal que
  `updated-at`.
- **Aceptada como optimización** donde el endpoint lo soporte.

### D) CDC (Change Data Capture)

- Teamtailor no expone CDC nativo. N/A.

---

## Consecuencias

### Positivas

- Baja complejidad operativa en POC.
- Robusto frente a rate limits.
- Estado persistido → observabilidad y retomabilidad.
- Compatible con futuro agregado de webhooks (coexisten).

### Negativas

- Latencia de propagación = intervalo de cron (ej: 15 min).
- Depende de que `updated-at` sea confiable en Teamtailor. **Riesgo a
  verificar** en las primeras corridas contra el tenant real.
- Borrados físicos en Teamtailor pueden no reflejarse si el endpoint
  no los lista. Mitigación: reconciliación periódica (semanal) que
  compara IDs conocidos vs IDs actuales.

---

## Criterios de reevaluación

Migrar a webhooks + sync como safety net si:

- Se necesita latencia < 5 minutos para algún caso de uso.
- El volumen de cambios por intervalo satura la cuota de API.
- Aparece un caso de negocio que requiera reaccionar a eventos
  (ej: notificación automática cuando se rechaza un candidato).
