# ADR-017 — `match_results.INSERT` por el recruiter dueño del parent run

- **Estado**: Aceptado
- **Fecha**: 2026-04-21
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: ADR-015 §5 y §8 (persistencia + RLS del ranker),
  ADR-003 (Auth + RLS), `CLAUDE.md` §🏛️ Auth y RLS, migración
  `20260420000007_rls_match_runs_and_results.sql`, F4-008 (API
  `/api/matching/run`)

---

## Contexto

ADR-015 §5 define `match_results` como **inmutable post-insert**: cada
corrida es un snapshot y las filas sólo nacen una vez. ADR-015 §8
describe la RLS en una línea: _"SELECT misma policy que `match_runs`
(join-based o duplicación de `tenant_id`)"_. No aclara quién puede
**insertar** resultados.

La migración `20260420000007_rls_match_runs_and_results.sql` resolvió
el silencio asumiendo que el output del ranker lo escribía un worker
en background con service role — por eso el policy actual de
`match_results` es **admin-only INSERT**:

```sql
create policy "match_results_admin_insert"
  on match_results for insert
  to authenticated
  with check (public.current_app_role() = 'admin');
```

En F4-008 el plan es disparar el ranker desde la request del recruiter
(`POST /api/matching/run`, DoD: "top-N inline"). En F1 no hay queue,
ni cron, ni worker asíncrono. El endpoint tiene que escribir
`match_results` durante el handler.

Tensión detectada:

- **CLAUDE.md #4 Auth y RLS** prohíbe service role en "routes
  disparadas por usuario" (solo ETL y embeddings).
- **Migración** asume service role como único camino.
- **Roadmap F4-008** pide respuesta síncrona.

Tres caminos (ver `docs/status.md` bloqueo F4-008):

A) Ampliar CLAUDE.md a "tercer uso legítimo de service role".
B) Abrir RLS a que el recruiter dueño del `match_run` inserte sus
propios `match_results`.
C) Worker async real (no hay infra en F1).

---

## Decisión

**Opción B**: permitir `INSERT` en `match_results` al recruiter
**cuando el parent `match_run.triggered_by` es él mismo**. Admin sigue
pudiendo insertar cualquier fila.

### Policy nueva

```sql
create policy "match_results_insert_own_run_or_admin"
  on match_results for insert
  to authenticated
  with check (
    public.current_app_role() = 'admin'
    or exists (
      select 1
      from match_runs mr
      where mr.id = match_results.match_run_id
        and mr.triggered_by = public.current_app_user_id()
    )
  );
```

Reemplaza a `match_results_admin_insert` (drop + create). Las otras
policies (`match_results_select_via_run`, `match_results_admin_delete`)
quedan intactas. La ausencia de policy UPDATE + el trigger
`enforce_match_results_insert_only` siguen garantizando inmutabilidad
post-insert.

### Qué se preserva

1. **Inmutabilidad** (ADR-015 §5): el trigger `before update` rechaza
   cualquier `UPDATE` incluso con service role. Agregar INSERT para
   recruiters no debilita esto.
2. **Auditabilidad**: cada fila en `match_results` está atada a un
   `match_run` que carga `triggered_by` (columna identidad, frozen
   por el trigger de state-machine). La cadena _recruiter → run →
   results_ es recuperable.
3. **Boundary service-role**: CLAUDE.md #4 no cambia. Las únicas
   rutas que usan service role siguen siendo ETL + embeddings workers
   - scripts batch.

### Qué cambia

- La migración original documenta que la regla cambió con este ADR.
- El test RLS `recruiter cannot insert results (backend-only via
service role)` se reemplaza por dos tests:
  - `recruiter can insert results for their own run`
  - `recruiter cannot insert results for another recruiter's run`.
- ADR-015 §8 se lee ahora con este ADR como complemento.

---

## Consecuencias

### Positivas

- **Simplicidad**: el endpoint `POST /api/matching/run` usa el mismo
  cliente RLS-scoped que ya valida ownership del `job_query`. Sin
  bifurcación service/user dentro del handler.
- **No reescribe CLAUDE.md**. La regla global sigue intacta.
- **No requiere infra**. F1 sigue sin queues.
- **RLS como contrato único**: si mañana un admin quiere forensic
  replay sobre un run ajeno, sigue teniendo INSERT vía el leg
  `current_app_role() = 'admin'`.

### Negativas / riesgos

- **Superficie de ataque ligeramente mayor**: antes sólo admin podía
  insertar `match_results`. Ahora cualquier recruiter puede — pero
  sólo en runs que él mismo disparó (FK + policy). Si alguna
  vulnerabilidad permitiera falsificar `match_run_id`, el recruiter
  podría inyectar filas en su propio run. El daño es acotado: no
  puede tocar runs ajenos, no puede modificar filas existentes
  (trigger), y el `breakdown_json` es suyo de todos modos.
- **Drift futuro**: si en Fase 2+ se mueve a worker asíncrono con
  queue, el recruiter ya no necesita INSERT directo. El policy
  puede revertirse a admin-only sin tocar datos.

### Alternativas descartadas

- **A) Ampliar CLAUDE.md**: romper una regla inviolable global para
  un caso puntual es un ratio riesgo/beneficio malo. La regla
  protege principalmente contra leaks accidentales de service role
  al cliente; sumar un tercer uso legítimo la diluye.
- **C) Worker async real**: overkill para F1 (5–15 usuarios), rompe
  UX síncrona del DoD F4-008, requiere infra de lease/dedup. Se
  reevaluará si p95 del ranker sube.

---

## Notas de implementación

- Migración: `20260421000001_rls_match_results_insert_own_run.sql`
  (drop de la policy admin-only + create de la nueva).
- Tests RLS: actualizar `tests/rls/matching-runs-and-results.test.ts`.
- El endpoint en F4-008 usa `createClient()` (RLS-scoped) — no hace
  falta un cliente service-role ad-hoc.

---

## Criterios de reevaluación

- Si la escala pasa de ~100 candidatos/run a 10k+: mover a async
  worker (C) y revertir policy a admin-only.
- Si aparece un caso donde un tercero (no recruiter, no admin) deba
  insertar `match_results` (p.ej. un bot de evaluación externo): no
  extender esta policy, crear rol separado.
