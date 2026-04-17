# 🛑 Operation Classification — Consequence Tiers

> **Gate de la propiedad Defended** (paper §4.3). Este documento
> clasifica operaciones por **reversibilidad**: cuáles pueden
> desandarse, cuáles requieren recovery, cuáles son irreversibles y
> exigen confirmación humana explícita antes de ejecutarse.
>
> Claude Code **debe consultar este archivo** antes de ejecutar
> cualquier operación que pueda caer en tiers 2 o 3.

---

## Tiers

| Tier | Nombre | Definición | Gate requerido |
|---|---|---|---|
| 0 | **Reversible** | El resultado puede deshacerse con un comando trivial o es idempotente. | Ninguno extra. |
| 1 | **Recoverable** | Hay plan de recovery documentado, pero requiere esfuerzo > 5 min. | Confirmar con humano vía prompt explícito. |
| 2 | **Hard-to-recover** | Requiere restore de backup o re-sync masivo. Horas de downtime. | Confirmación humana + ADR o runbook. |
| 3 | **Irreversible** | Imposible de deshacer sin pérdida real de data o estado externo. | Confirmación humana **por cada invocación**. Nunca en automation. |

---

## Catálogo de operaciones

### Tier 0 — Reversibles (proceder)

- Leer tablas.
- Crear un nuevo ADR, doc, skill o command.
- Agregar una migration nueva (append-only, documentada).
- Crear un branch nuevo.
- Correr tests.
- Generar tipos desde schema (`supabase gen types typescript`).
- Upsert en tablas de dominio por ETL (idempotente por `teamtailor_id`).
- Regenerar embeddings (el hash gobierna).

### Tier 1 — Recoverable (pedir confirmación humana)

- `UPDATE` masivo (> 100 rows) sin `WHERE` específico del tipo
  `WHERE id = X`.
- `supabase db reset` en **local** (destruye DB local; recovery vía
  re-seed).
- Invalidar todos los embeddings forzando re-generación (`UPDATE
  embeddings SET content_hash = NULL`).
- Cambiar `rejection_rules.ts` — aunque es código, afecta dataset
  pre-normalizado; re-correr normalizer.
- Rotar el token de Teamtailor (corta sync hasta actualizar secret).
- Cambiar la `role` de un `app_user`.
- Archivar una shortlist ajena.

**Protocolo**: Claude Code describe la operación, estima impacto,
pide confirmación textual del humano antes de ejecutar.

### Tier 2 — Hard-to-recover (confirmar + runbook)

- `supabase db reset` en **staging**.
- Ejecutar backfill full (`--full-resync`) fuera de ventana de
  mantenimiento.
- Alterar una columna existente con riesgo de pérdida (`ALTER TABLE
  ... DROP COLUMN`, `ALTER COLUMN TYPE` con downcast).
- Revocar policy RLS (aunque sea "por 5 min" para debug).
- Cambiar el modelo de embeddings (dispara re-embedding de 15k+
  rows; costo en $).
- Borrar un bucket de Storage.
- Operar sobre `auth.users` directamente (bypass de app_users).

**Protocolo**: requerir referencia a runbook existente en
`docs/runbooks/`, o crear uno antes. Confirmación humana + un admin
con contexto suficiente para aprobar.

### Tier 3 — Irreversible (STOP — no ejecutar sin humano encima)

- `DROP TABLE` en cualquier ambiente con data real.
- `TRUNCATE` en staging o prod.
- `DELETE FROM candidates` / aplicaciones / evaluaciones sin soft
  delete.
- Hard delete físico de archivos en bucket `candidate-cvs`
  (los binarios originales en Teamtailor pueden haber expirado).
- `supabase db reset` en **producción** (nunca).
- Cambiar `teamtailor_id` de un row ya sincronizado (rompe
  idempotencia para siempre).
- Mergear a `main` bypassing protection rules.
- Forzar push a `main`.
- Revocar el último JWT admin (self-lockout).
- Revocar acceso a la API de OpenAI sin plan de rollback.
- Eliminar una migration aplicada (en vez de crear una nueva que la
  revierta).

**Protocolo**: Claude Code **se niega** a ejecutar. Requiere comando
humano explícito, idealmente ejecutado por el humano mismo, no
delegado al agente.

---

## Interacción con el hook `pre-tool-use.sh`

El hook bloquea automáticamente comandos que matcheen patrones
tier-3 en bash:

- `DROP TABLE`
- `TRUNCATE`
- `DELETE FROM` sin `WHERE id =` o `WHERE teamtailor_id =`
- `supabase db reset` contra URL que no sea `localhost`
- `git push --force` a `main`
- `rm -rf` sobre paths sensibles

Si el comando es legítimo (ej: drop de una tabla temporal en
migration), hay que documentarlo en el commit message y el humano
confirma vía `CLAUDE_ALLOW_DESTRUCTIVE=1 <comando>`.

---

## Revisión periódica

Este catálogo se actualiza cuando:
- Aparece una nueva operación riesgosa (nuevo servicio, nueva tabla
  sensible).
- Un incident post-mortem identifica una operación que debería
  haber estado acá.

Cualquier PR que introduce una operación nueva de Tier 2+ **debe**
actualizar este archivo y citarlo en el commit.

---

## Anti-ejemplos (historia prevenida)

Casos hipotéticos que este catálogo debería prevenir:

1. **Claude corre `DELETE FROM candidates WHERE tenant_id IS NULL`**
   pensando que limpia dirty data → borra todos los candidates
   porque `tenant_id` es null en Fase 1. **Bloqueado por hook**.

2. **Claude re-genera embeddings de todo** sin darse cuenta que
   cuesta $10 × quantidad arbitraria → **Tier 1**, pide confirmación.

3. **Claude hace `supabase db reset`** en ambiente staging
   esperando que sea local → **Tier 2**, hook chequea URL.

4. **Claude cambia el modelo de embeddings** de `small` a `large`
   en un PR de refactor → **Tier 2**, requiere ADR nuevo por el
   cambio de 1536 → 3072 dim (rompe schema).

---

## Referencias

- Paper Generative Specification §4.3 *Defended: Consequence Classification*.
- CLAUDE.md sección "Operaciones prohibidas sin autorización".
- `.claude/hooks/pre-tool-use.sh`.
