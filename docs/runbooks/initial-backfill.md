# 📘 Runbook — Initial Backfill desde Teamtailor

> **Consequence tier**: 2 (Hard-to-recover). Ver
> `docs/operation-classification.md`.
>
> **Requiere**: humano operando con contexto + tenant Teamtailor
> productivo + Supabase producción (o staging si existe).

---

## Pre-flight

Checklist antes de ejecutar:

- [ ] Secret `TEAMTAILOR_API_TOKEN` configurado en GitHub Actions.
- [ ] Secret `SUPABASE_SERVICE_ROLE_KEY` configurado.
- [ ] Supabase local NO está apuntando al target (verificar URL).
- [ ] Migraciones aplicadas en Supabase target
      (`supabase db push --linked`).
- [ ] Tipos TS regenerados y committeados.
- [ ] `sync_state` tiene una fila por entidad con status `idle`.
- [ ] `DRY_RUN=true` disponible para primer paso.

---

## Plan de ejecución

Orden **no negociable** (ver ADR-004 §Orquestación):

1. `stages`
2. `users`
3. `jobs`
4. `candidates`
5. `applications`
6. `evaluations`
7. `notes`
8. `files` (última — la más pesada)

### Paso 0 — Smoke test con DRY_RUN

```bash
gh workflow run backfill.yml \
  --ref main \
  -f entity=stages \
  -f dry_run=true
```

Verificar logs en Actions UI: debe listar registros a insertar sin
tocar la DB. Si algo truena acá, **abortar** y revisar.

### Paso 1 — Entidades chicas (stages, users, jobs)

```bash
for entity in stages users jobs; do
  gh workflow run backfill.yml --ref main -f entity=$entity
  sleep 30
done
```

Cada una debería tardar < 5 min. Monitorear:
- `sync_state.last_run_status` en cada entidad.
- `sync_errors` count; debería ser ≤ 1% del total.

### Paso 2 — Candidates (el core)

```bash
gh workflow run backfill.yml --ref main -f entity=candidates
```

Con ~5k candidates esperados, tarda ~30-60 min.

Monitorear durante la corrida:
- Logs de Actions (token bucket no debería saturar).
- `select count(*) from candidates;` debe crecer monotónicamente.
- Respuesta 429 de Teamtailor → workflow debería reintentar, no abortar.

### Paso 3 — Applications + evaluations + notes

```bash
for entity in applications evaluations notes; do
  gh workflow run backfill.yml --ref main -f entity=$entity
  sleep 30
done
```

Tarda ~30-45 min cada uno.

### Paso 4 — Files (última y más pesada)

⚠️ Esta es la que descarga binarios de Teamtailor y sube a Storage.
Potencial para llenar el bucket y consumir bandwidth.

```bash
gh workflow run backfill.yml --ref main -f entity=files
```

Tarda ~1-2 h con 5k CVs. Monitorear:
- Storage usage (bucket `candidate-cvs`).
- Costo potencial si el tier de Supabase escala.

---

## Durante la ejecución

**Monitoreo mínimo** (abrir dashboard con estas queries):

```sql
-- ritmo por entidad
select entity,
       last_run_status,
       records_synced,
       last_synced_at,
       last_run_error
from sync_state
order by entity;

-- errores no resueltos
select entity, count(*)
from sync_errors
where resolved_at is null
group by entity;

-- CVs parseados con problemas
select parse_error, count(*)
from files
where parse_error is not null
group by parse_error;
```

---

## Qué hacer si algo se rompe

### Rate limit sostenido (429 loop)

Síntoma: logs de Actions muestran 429 repetidos, backoff creciente.

Acción:
1. Cancelar el workflow.
2. Esperar 10 min (window de rate limit).
3. Re-ejecutar **con la misma entidad**; el ETL es idempotente y
   `last_synced_at` tendrá un cursor donde arrancar.

### Error fatal en un batch

Síntoma: `sync_state.last_run_status = 'error'`,
`last_synced_at` no avanzó.

Acción:
1. Leer `sync_state.last_run_error` → copia en post-mortem.
2. Inspeccionar `sync_errors` para row-level failures.
3. Si es un bug en el syncer: fix + PR + re-ejecutar.
4. Si es transitorio: re-ejecutar sin cambios.

### CVs parseando mal (muchos `likely_scanned`)

Expectativa: < 20%. Si > 20%, revisar:
- Si vienen PDFs con formato distinto al que espera `pdf-parse`.
- Candidato a Fase 2 OCR.
- No bloquear el backfill por esto — los files quedan accesibles,
  solo sin texto full-text.

### Storage usage explotó

Acción:
1. Auditar tamaños con:
   ```sql
   select candidate_id, sum(file_size_bytes) as bytes
   from files
   group by candidate_id
   order by bytes desc
   limit 20;
   ```
2. Si hay outliers > 10 MB (no debería — validación rechaza),
   investigar.
3. Si es volumen legítimo, planear upgrade de plan Supabase.

---

## Post-flight

- [ ] `sync_state` todas en `success`.
- [ ] `sync_errors` revisados, los resueltos marcados con
      `resolved_at`.
- [ ] Conteos en DB coinciden (± 1%) con conteos en UI de Teamtailor.
- [ ] Smoke test de búsqueda en la app: query "backend" devuelve
      resultados.
- [ ] Entrada en `docs/status.md` registrando:
  - duración total,
  - conteos por entidad,
  - errores notables,
  - costos (si aplica).

---

## Post-backfill — programar sync incremental

Una vez backfill OK, activar cron de sync incremental:

```bash
supabase functions deploy sync-incremental
supabase cron schedule "*/15 8-20 * * 1-5" sync-incremental
# Fuera de horario laboral:
supabase cron schedule "0 */1 * * *" sync-incremental-offhours
```

Primer run debería ser **trivialmente chico** (solo cambios desde
que terminó el backfill).

---

## Rollback

Si todo sale mal y hay que volver a cero:

1. **NO hacer `DROP` ni `TRUNCATE`** (Tier 3, prohibido).
2. Opción A: resetear `sync_state.last_synced_at = NULL` para
   forzar re-sync completo en el próximo run.
3. Opción B: si hay data corrupta, crear migración que soft-delete
   toda la tanda y correr backfill de nuevo. Los registros viejos
   quedan auditables.
4. Documentar en `docs/status.md` y crear ADR con lecciones.
