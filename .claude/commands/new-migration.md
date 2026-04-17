---
name: new-migration
description: Crea una migración de Supabase con timestamp correcto, naming consistente y comentario de rollback. Opcionalmente crea también la migración RLS asociada.
---

# /new-migration

Creá una migración nueva siguiendo el skill
`supabase-migrations`.

## Flujo

1. Preguntá al usuario:
   - Verbo (`add`, `alter`, `seed`, `rls`, `fn`, `trigger`).
   - Scope (ej: `candidates`, `candidate_email_index`).
   - ¿Requiere migración RLS adjunta?

2. Generá el timestamp con `date -u +%Y%m%d%H%M%S`.

3. Creá:
   ```
   supabase/migrations/<timestamp>_<verb>_<scope>.sql
   ```

4. Template base del archivo:
   ```sql
   -- Migration: <verb> <scope>
   -- Author: Claude Code (generated via /new-migration)
   -- Date: YYYY-MM-DD
   -- Rollback: <describir rollback explícito, ej: "drop table X cascade">
   --
   -- Related: docs/data-model.md §N, ADR-XXX

   -- <SQL aquí>
   ```

5. Si el usuario pidió RLS adjunta, crear también:
   ```
   supabase/migrations/<timestamp+1s>_rls_<scope>.sql
   ```
   con template:
   ```sql
   -- RLS policies for <scope>
   -- Rollback: drop policy ...; alter table <scope> disable row level security;

   alter table <scope> enable row level security;

   -- SELECT
   create policy "<scope>_select_visible"
     on <scope> for select
     using (
       (auth.jwt() ->> 'role') in ('recruiter','admin')
       -- TODO: agregar condición de deleted_at si aplica
     );

   -- INSERT
   create policy "<scope>_insert"
     on <scope> for insert
     with check ((auth.jwt() ->> 'role') in ('recruiter','admin'));

   -- UPDATE
   create policy "<scope>_update"
     on <scope> for update
     using ((auth.jwt() ->> 'role') in ('recruiter','admin'))
     with check ((auth.jwt() ->> 'role') in ('recruiter','admin'));

   -- DELETE (hard) solo admin — evitar en Fase 1
   create policy "<scope>_delete_admin"
     on <scope> for delete
     using ((auth.jwt() ->> 'role') = 'admin');
   ```

6. **NO aplicar todavía.** Recordale al usuario:
   ```bash
   supabase db reset        # local
   pnpm supabase:types      # regenerar tipos
   pnpm test tests/rls/<scope>.test.ts  # tests RLS
   ```

7. Commit message sugerido:
   ```
   feat(db): <verb> <scope>
   ```

## Guardas

- Si el verbo es `drop` o el SQL contiene `DROP TABLE` /
  `TRUNCATE` / `DELETE FROM`: **STOP**. Pedir confirmación humana
  explícita. Es Tier 2+ (ver `docs/operation-classification.md`).
- Si se intenta `disable row level security` en tabla de
  dominio: **STOP**. Es Tier 2.

## Checklist post-creación

- [ ] Archivo nombrado correctamente (timestamp + verb + scope).
- [ ] Rollback documentado en comentario.
- [ ] Si agrega tabla → migración RLS adjunta.
- [ ] Si agrega tabla → matriz en `data-model.md` §16 actualizada.
- [ ] Si es decisión no trivial → ADR asociado.
