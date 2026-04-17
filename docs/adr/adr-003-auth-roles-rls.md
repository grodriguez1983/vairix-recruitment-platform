# ADR-003 — Autenticación, roles y Row Level Security

- **Estado**: Aceptado
- **Fecha**: 2026-04-17
- **Decisores**: Equipo interno
- **Relacionado con**: `spec.md` §9, `data-model.md`, ADR-001

---

## Contexto

El spec original no definía estrategia de auth ni permisos, pero
`data-model.md` ya declaraba "RLS activada en todas las tablas con
policies por rol (recruiter, admin)" sin respaldo. Hay que formalizar.

Restricciones:

- **Uso exclusivamente interno** de VAIRIX (confirmado 2026-04-17).
- **5-15 usuarios esperados**, todos empleados de VAIRIX.
- No hay compromisos de compliance formales (ni GDPR ni similares).
- El spec no descarta ofrecer la herramienta a terceros a futuro,
  pero no es un objetivo actual.
- Necesidad de soportar soft delete con visibilidad diferenciada
  por rol.

---

## Decisión

### 1. Single-tenant con hedge

**Fase 1: single-tenant.** Una sola instancia para VAIRIX.

Sin embargo, agregamos desde día uno una columna `tenant_id uuid`
**nullable** en tablas base (`candidates`, `jobs`, `applications`,
`evaluations`, `files`, `tags`, `shortlists`). En Fase 1 queda en
`null` o en un UUID fijo por env. Si en el futuro se decide
multi-tenant, la migración es una actualización masiva + cambio de
RLS, no un rediseño.

### 2. Auth

- **Supabase Auth** (magic link + password opcional).
- Sin registro público: los usuarios se crean por invitación desde
  el panel de admin o vía script.
- JWT de Supabase como fuente de verdad de la identidad.

### 3. Roles

Dos roles en Fase 1:

| Rol | Permisos |
|---|---|
| `recruiter` | Lectura/escritura sobre candidates, applications, tags, shortlists, notes propias. Lectura de evaluations. NO ve sync logs ni config. |
| `admin` | Todo lo del recruiter + sync state, configuración, rejection categories, user management, soft-deleted records. |

**`hiring_manager` queda fuera de Fase 1.** Si aparece el caso de uso,
se agrega en Fase 2 como read-only filtrado por jobs asignados.

### 4. Modelo de usuario de la aplicación

Tabla `app_users` separada de `auth.users` de Supabase:

- Vincula `auth_user_id` ↔ `role` ↔ metadata propia.
- Permite editar rol sin tocar la tabla `auth.users`.
- **No confundir** con la tabla `users` (sincronizada desde
  Teamtailor para poblar `evaluations.user_id`).

> Se esperan ~15 filas en `app_users`; se esperan más en `users`
> (todos los que hayan evaluado alguna vez en Teamtailor).

### 5. Row Level Security

RLS activa en todas las tablas del dominio. Policies base:

```sql
-- Ejemplo sobre candidates (el patrón se repite)
alter table candidates enable row level security;

-- recruiter y admin pueden leer no-borrados
create policy "read_visible_candidates"
  on candidates for select
  using (
    deleted_at is null
    or (auth.jwt() ->> 'role') = 'admin'
  );

-- recruiter y admin pueden insertar
create policy "insert_candidates"
  on candidates for insert
  with check (
    (auth.jwt() ->> 'role') in ('recruiter', 'admin')
  );

-- recruiter y admin pueden actualizar
create policy "update_candidates"
  on candidates for update
  using (
    deleted_at is null
    or (auth.jwt() ->> 'role') = 'admin'
  );

-- solo admin borra (soft delete)
create policy "soft_delete_candidates"
  on candidates for update
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');
```

Tablas sensibles (`sync_state`, `app_users`, `rejection_categories`):
**solo admin**, tanto lectura como escritura.

El claim `role` se inyecta en el JWT desde una función
`auth.jwt_custom_claims` que lee `app_users.role`.

### 6. Soft delete

- Columna `deleted_at timestamptz` en todas las tablas de dominio.
- `recruiter` **no ve** registros con `deleted_at is not null`.
- `admin` los ve y puede restaurar poniendo `deleted_at = null`.
- No hay hard delete desde la UI en Fase 1. Solo por script manual.

### 7. Terminología de API keys de Supabase (modelo 2025+)

Supabase deprecó las JWT-based `anon` / `service_role` keys a fines
de 2025. Proyectos creados desde ~Nov 2025 **ya no las exponen**;
vienen con el modelo nuevo:

| Nuevo nombre | Env var | Prefijo | Reemplaza a |
|---|---|---|---|
| Publishable key (única por proyecto) | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_` | `anon` key (legacy) |
| Secret key (N por proyecto, rotables individualmente) | `SUPABASE_SECRET_KEY` | `sb_secret_` | `service_role` key (legacy) |

Propiedades relevantes del modelo nuevo:

- **Rotación y revocación por clave**: se pueden emitir múltiples
  secret keys con nombre y revocar cada una sin afectar a las otras.
  Cada evento queda en el audit log de la organización.
- **Desacopladas del JWT secret**: rotar el JWT secret ya no
  implica rotar las API keys.
- **Drop-in compatible**: el supabase-js client acepta los valores
  nuevos en el mismo slot donde antes iban anon/service_role.

**Regla del repo**:

- Proyecto creado como **greenfield** (sin código legacy): usar
  **solo** los nombres nuevos. El repo no mantiene compat con los
  nombres antiguos.
- Las reglas de §5 RLS y de segregación de secret key (solo en
  Edge Functions, CI backfill, scripts admin) **no cambian**:
  la secret key sigue siendo la que bypasea RLS.
- El hook de pre-commit escanea además el prefijo literal
  `sb_secret_` como guardrail adicional anti-leak.
- Escuchar el **audit log** de keys en la review mensual; si
  alguna clave aparece inesperadamente o no sabemos quién la
  creó, revocar.

**Out of scope de este ADR**: decisión de rotar claves en un
intervalo fijo. Se evalúa cuando el proyecto salga a producción
(Fase 2+).

---

## Alternativas consideradas

### A) Sin auth (token compartido)
- **Pros**: trivial para POC.
- **Contras**: auditoría imposible, riesgo si se filtra el token,
  no escala.
- **Descartada**.

### B) Multi-tenant desde día uno
- **Pros**: listo para terceros.
- **Contras**: complejidad de RLS por tenant, overhead innecesario
  para 15 usuarios de una sola empresa.
- **Descartada**: el hedge de `tenant_id` nullable da 95% del futuro
  por 5% del costo.

### C) Auth custom (Lucia, NextAuth)
- **Pros**: más flexibilidad.
- **Contras**: duplica lo que ya hace Supabase Auth, complica RLS
  (que se integra nativamente con `auth.uid()` y `auth.jwt()`).
- **Descartada**.

### D) Incluir `hiring_manager` en Fase 1
- **Pros**: cubre un caso real.
- **Contras**: agrega policies adicionales, filtros por job asignado,
  UI diferenciada. No hay demanda confirmada.
- **Postergada a Fase 2** si surge la necesidad.

---

## Consecuencias

### Positivas
- Auth robusto con cero código propio de criptografía.
- RLS centraliza permisos en la DB, imposible "olvidarse" desde el
  código de aplicación.
- Futuro multi-tenant requiere migración, no rediseño.
- Auditoría implícita vía `auth.uid()` en logs de cambios.

### Negativas
- RLS hace el debugging más complejo; todo query desde cliente va
  con JWT del usuario. Mitigación: en tests y scripts usar el
  service role key con precaución.
- `tenant_id nullable` exige disciplina para no olvidar setearlo
  cuando se haga multi-tenant. Check constraint documentado.
- Cambio de rol de un usuario requiere regenerar su JWT
  (logout/login). Aceptable para 15 usuarios.

---

## Criterios de reevaluación

- Si se supera 30 usuarios: revisar si siguen bastando 2 roles.
- Si aparece un cliente externo interesado en usar el producto:
  activar plan multi-tenant (requiere ADR nuevo).
- Si se introduce integración con clientes externos que deben ver
  un subset de candidates: evaluar role `external_viewer`.
