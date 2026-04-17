---
name: rls-policies
description: Cómo escribir, aplicar y testear Row Level Security policies en Supabase siguiendo ADR-003. Usar cuando la tarea requiera agregar una tabla nueva, modificar permisos, cambiar el modelo de roles, o escribir tests de autorización.
---

# RLS Policies

## Cuándo aplicar este skill

- Crear tabla nueva → activar RLS + escribir policies + tests.
- Cambiar matriz de acceso en `data-model.md` §16.
- Debuggear un "permission denied" inesperado.
- Agregar un rol nuevo (ej: `hiring_manager` en Fase 2).
- Onboarding: entender cómo funciona la auth en el proyecto.

## Principios no negociables

1. **RLS siempre activa en tablas de dominio.** Sin excepciones.
   Si el feature necesita bypass, usar **service role** (solo en
   ETL y workers) o crear una policy explícita.
2. **Service role key NUNCA expuesta al cliente.** Solo Edge
   Functions, GitHub Actions, scripts admin locales.
3. **Tests por policy.** Cada policy tiene al menos un test
   positivo (role correcto accede) y uno adversarial (role
   incorrecto rechazado).
4. **Custom claim `role` en JWT** es la fuente de verdad.
   Viene de `app_users.role`.

## Roles en Fase 1 (ADR-003)

| Rol         | JWT claim          | Acceso general                                                                        |
| ----------- | ------------------ | ------------------------------------------------------------------------------------- |
| `recruiter` | `role='recruiter'` | R/W candidates, applications, tags, shortlists, notes. R de evaluations.              |
| `admin`     | `role='admin'`     | Todo lo anterior + sync_state, rejection_categories, soft-deleted records, app_users. |
| `anon`      | no JWT / null      | Nada.                                                                                 |

`hiring_manager` queda para Fase 2.

## Inyección del claim `role`

Función Supabase que enriquece el JWT al login:

```sql
create or replace function auth.jwt_custom_claims(user_id uuid)
returns jsonb as $$
  select jsonb_build_object(
    'role', (select role from app_users where auth_user_id = user_id),
    'app_user_id', (select id from app_users where auth_user_id = user_id)
  );
$$ language sql stable;
```

Configurar el hook en Supabase Auth → Custom Claims. Ver
runbook si no está aplicado.

## Patrón de policies por tabla

Para cada tabla de dominio, 4 policies mínimo (SELECT, INSERT,
UPDATE, DELETE). Nunca crear una "ALL" policy — siempre separar.

```sql
-- Ejemplo: candidates
alter table candidates enable row level security;

-- SELECT: recruiter y admin leen no-borrados; admin lee todo
create policy "candidates_select_visible"
  on candidates for select
  using (
    (auth.jwt() ->> 'role') in ('recruiter','admin')
    and (deleted_at is null or (auth.jwt() ->> 'role') = 'admin')
  );

-- INSERT: recruiter y admin
create policy "candidates_insert"
  on candidates for insert
  with check ((auth.jwt() ->> 'role') in ('recruiter','admin'));

-- UPDATE: recruiter sobre no-borrados; admin total
create policy "candidates_update"
  on candidates for update
  using (
    (auth.jwt() ->> 'role') in ('recruiter','admin')
    and (deleted_at is null or (auth.jwt() ->> 'role') = 'admin')
  )
  with check (true);

-- DELETE (hard): solo admin, y en Fase 1 nadie usa esto
create policy "candidates_delete_admin"
  on candidates for delete
  using ((auth.jwt() ->> 'role') = 'admin');
```

**Soft delete** (`deleted_at = now()`) es un UPDATE, no un DELETE.
La policy de UPDATE es la que gobierna.

## Tablas admin-only

```sql
-- sync_state, sync_errors, app_users, rejection_categories
alter table sync_state enable row level security;

create policy "sync_state_admin_all"
  on sync_state for all
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');
```

## Multi-tenant hedge (ADR-003)

Aunque en Fase 1 `tenant_id` es null, la policy ya está preparada:

```sql
-- Fase 2+ activaría esta variante; en Fase 1 tenant_id es null
create policy "candidates_select_tenant"
  on candidates for select
  using (
    (auth.jwt() ->> 'role') in ('recruiter','admin')
    and (
      tenant_id is null  -- Fase 1: registros sin tenant
      or tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    )
  );
```

## Tests de RLS (obligatorios)

Helper en `tests/helpers/rls.ts`:

```typescript
export async function asRole(role: 'recruiter' | 'admin' | null) {
  const token = role ? makeTestJwt({ role, sub: 'test-user' }) : null;
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  });
}
```

Matriz mínima por tabla:

```typescript
describe('candidates RLS', () => {
  test('recruiter can read non-deleted', async () => { ... });
  test('recruiter cannot see soft-deleted', async () => {
    const client = await asRole('recruiter');
    await seed({ deleted_at: new Date() });
    const { data } = await client.from('candidates').select('*');
    expect(data).toHaveLength(0);
  });
  test('admin sees soft-deleted', async () => { ... });
  test('anon denied', async () => {
    const client = await asRole(null);
    const { error } = await client.from('candidates').select('*');
    expect(error?.code).toBe('PGRST301'); // JWT required
  });
  // Cross-tenant test (aunque tenant_id null en Fase 1)
  test('tenant isolation enforced', async () => { ... });
});
```

## Debugging

Comandos útiles:

```sql
-- ¿qué policies tiene una tabla?
select * from pg_policies where tablename = 'candidates';

-- ¿el JWT actual cómo es?
select auth.jwt();

-- Simular una query como un user específico (solo localhost)
set local role authenticated;
set local "request.jwt.claims" = '{"role":"recruiter","sub":"..."}';
select * from candidates;
reset role;
```

## Qué NO hacer

- ❌ Deshabilitar RLS "por un ratito" para debuggear en staging.
  Usá `supabase db dump` + local.
- ❌ Policy `USING (true)` en tablas de dominio. Es bypass.
- ❌ Usar `auth.uid()` para gating de rol; ese claim identifica
  usuario, no rol. Usá `auth.jwt() ->> 'role'`.
- ❌ Crear un role `superadmin` nuevo sin ADR.
- ❌ Testear RLS con service role key (bypass total; no prueba
  nada).

## Checklist al crear una tabla

- [ ] Migración `NNN_add_<tabla>.sql` sin RLS todavía.
- [ ] Migración separada `NNN_rls_<tabla>.sql` que:
  - [ ] `enable row level security`.
  - [ ] 4 policies mínimo (select/insert/update/delete).
  - [ ] Considera soft delete si aplica.
  - [ ] Considera tenant_id si la tabla lo tiene.
- [ ] Tests en `tests/rls/<tabla>.test.ts`.
- [ ] Matriz de `data-model.md` §16 actualizada.

## Referencias

- ADR-003 — auth y roles.
- `data-model.md` §16 — matriz de acceso.
- `docs/test-architecture.md` §6 — estrategia de tests RLS.
- `docs/operation-classification.md` — revocar RLS es Tier 2.
