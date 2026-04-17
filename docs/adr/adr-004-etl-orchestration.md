# ADR-004 — Orquestación del ETL

- **Estado**: Aceptado
- **Fecha**: 2026-04-17
- **Decisores**: Equipo interno
- **Relacionado con**: `spec.md` §5, `teamtailor-api-notes.md`, ADR-002

---

## Contexto

El spec definía la estrategia lógica de sync (incremental por
`updated_at`, confirmada en ADR-002), pero no decidía **dónde** corre
ni **cómo** se manejan concurrencia y backfill.

Variables del contexto:

- ~5.000 candidates actuales en Teamtailor, más applications, files
  y evaluations asociados. El backfill inicial puede superar la hora.
- Rate limit de Teamtailor ~50 req/10s → un backfill de 5k candidates
  con paginación (~30 por página) son ~170 requests solo de
  candidates, sin contar includes. Totalidad estimada: varias miles
  de requests.
- Next.js se hostea en Vercel (timeout máximo 60s en Hobby, 300s en
  Pro para serverless functions; 800s para fluid compute).
- No existe sandbox de Teamtailor.

---

## Decisión

### Runtime híbrido

| Caso | Runtime | Justificación |
|---|---|---|
| Sync incremental (< 5 min) | **Supabase Edge Functions** | Cerca de la DB, 150s timeout, sin cold start pesado, cron nativo. |
| Backfill inicial / reindex masivo | **GitHub Actions scheduled/manual** | Sin límite práctico de tiempo, matrix jobs para paralelizar entidades, logs persistidos, fácil de re-disparar. |
| Webhook receivers (Fase 2+) | **Vercel API routes** | Latencia baja, integra con la app Next.js. |

**No usar** Vercel Cron para el ETL: el límite de tiempo y la falta de
persistencia de estado entre invocaciones lo hacen frágil para syncs
largos.

### Orquestación por entidad

Orden fijo (respeta dependencias):

1. `stages` (catálogo chico, cambia poco)
2. `users` (evaluadores)
3. `jobs`
4. `candidates`
5. `applications`
6. `evaluations` / `notes`
7. `files` (descarga + storage + parse; la más pesada)

Cada entidad es una **función independiente**. Se invocan
secuencialmente en el incremental; en paralelo en el backfill
(respetando el rate limit global).

### Frecuencia

- Incremental: **cada 15 minutos** en horario laboral uruguayo
  (8:00-20:00 UYT), cada hora fuera de ese rango.
- Configurable vía env var `SYNC_INTERVAL_MINUTES`.
- Backfill: manual, con flag explícito `--full-resync`.

### Concurrencia (lock)

Estado persistido en `sync_state`:

```
last_run_status ∈ ('idle', 'running', 'success', 'error')
last_run_started timestamptz
```

Flujo de arranque de un run:

1. Leer fila de `sync_state` para la entidad.
2. Si `last_run_status = 'running'`:
   - Si `now() - last_run_started < 1 hour` → abortar (hay otra
     corrida activa).
   - Si ≥ 1 hora → considerar stale, tomar el lock y continuar
     (la corrida previa crasheó).
3. Update atómico: `last_run_status = 'running'`, `last_run_started = now()`.
4. Ejecutar.
5. Update final: `success` o `error` con mensaje.

El timeout de 1 hora es configurable por entidad vía
`sync_state.stale_timeout_minutes`.

### Rate limiting global

Un **token bucket compartido** entre entidades (ej: Redis o tabla
Postgres con advisory locks) limita el total agregado contra
Teamtailor a ~4 req/s. Cada función de entidad consume tokens antes
de disparar requests.

En Fase 1, si el volumen lo permite, alcanza con que **solo una
entidad corra a la vez**, eliminando la necesidad del bucket
compartido. Reevaluar cuando el backfill demuestre el cuello.

### Manejo de errores

- Error de un registro puntual → se loggea en `sync_errors`
  (tabla nueva), el batch sigue.
- Error transitorio (HTTP 5xx, 429) → backoff exponencial con
  jitter, hasta 5 reintentos.
- Error fatal (auth, rate limit sostenido, 4xx persistente) → run
  marcado como `error`, `last_synced_at` **no avanza**, alerta.
- Alertas en Fase 1 = log estructurado + email manual. Monitoreo
  real en Fase 2+.

### Ausencia de sandbox Teamtailor

Dado que no existe tenant de staging y hay que crearlo todo:

- **Desarrollo local**: fixtures JSON en `tests/fixtures/teamtailor/`
  con respuestas reales anonimizadas.
- **Integration tests**: un mock server (MSW) que responde con los
  fixtures.
- **Staging**: hablar con IT para crear un tenant de prueba en
  Teamtailor o trabajar con un subset read-only del tenant real
  filtrado por tag "test".
- **Producción**: primero apuntar a tenant real con flag
  `DRY_RUN=true` que ejecuta sin escribir en DB, solo loggea.

---

## Alternativas consideradas

### A) Todo en Vercel Cron + API routes
- **Contras**: 300s de timeout no alcanza para backfill. Romperlo
  en chunks con estado en DB es factible pero reinventa una cola.
- **Descartada para el backfill**; viable para el incremental si
  se prefiere un solo runtime.

### B) Worker dedicado (Railway, Fly, AWS ECS)
- **Pros**: sin límites, control total.
- **Contras**: otro deploy target, otro runtime, otra cosa a
  monitorear. Overkill para 5k candidates.
- **Descartada** en Fase 1. Reevaluar si superamos 50k candidates
  o agregamos workflows complejos.

### C) Job queue (BullMQ, Inngest, Trigger.dev)
- **Pros**: retry, observabilidad, scheduling.
- **Contras**: dependencia adicional, costo, curva de aprendizaje
  para el equipo.
- **Postergada**. Si el manejo manual de errores se vuelve
  insostenible, adoptar Inngest (el más liviano del grupo).

### D) Corridas full en lugar de incrementales
- Ya descartada en ADR-002.

---

## Consecuencias

### Positivas
- Cada runtime se usa para lo que hace mejor.
- El backfill largo no bloquea la app ni gasta cuota de Vercel.
- Edge Functions cerca de la DB reducen latencia de upsert masivo.
- GitHub Actions da logs gratuitos y re-ejecución trivial.

### Negativas
- Tres runtimes a mantener (Vercel, Supabase Edge, GitHub Actions).
- Setear variables de entorno y secrets en tres lugares.
  Mitigación: script de bootstrap que valida paridad.
- Testing E2E del ETL es complejo sin sandbox de Teamtailor.
  Mitigación: fixtures + MSW + flag DRY_RUN.
- Primer backfill va a ser un evento con supervisión humana.
  Documentar runbook en `docs/runbooks/initial-backfill.md`.

---

## Criterios de reevaluación

- Si el incremental empieza a superar los 150s de Edge Functions:
  migrar incremental también a GitHub Actions o worker dedicado.
- Si el manejo de errores manual se vuelve carga operativa:
  adoptar job queue (evaluar Inngest primero).
- Si se introduce un segundo ATS además de Teamtailor: replantear
  toda la orquestación con una capa de abstracción de fuentes.
