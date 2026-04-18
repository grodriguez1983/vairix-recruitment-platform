# ADR-010 — Ingesta de Teamtailor custom fields

- **Estado**: Aceptado
- **Fecha**: 2026-04-18
- **Decisores**: Equipo interno
- **Relacionado con**: `spec.md` §4, `data-model.md`, ADR-002, ADR-004, ADR-003

---

## Contexto

Una auditoría del tenant productivo sobre una muestra de 900 candidates
sincronizados reveló que el syncer actual **no usa `?include=...`** en
las llamadas a Teamtailor. `raw_data.relationships` trae sólo
`{self, related}` links; los recursos sideloaded (`custom-field-values`,
`form-answers`, `uploads`, `interviews`, `questions`, `answers`) quedan
sin persistir.

Los custom fields del tenant hoy son 4, todos sobre `Candidate`:

| api-name                 | field-type | is-private | uso                               |
| ------------------------ | ---------- | ---------- | --------------------------------- |
| `asp-salariales`         | Text       | **true**   | expectativa salarial              |
| `pre-propuesta-aprobada` | Date       | false      | fecha de aprobación de pre-oferta |
| `ltimo-seguimiento`      | Date       | false      | fecha del último follow-up        |
| `hired-salary`           | Text       | **true**   | salario contratado                |

Dos de los cuatro están marcados `is-private=true` y contienen datos de
compensación. El flujo real del recruiter incluye además:

- Formularios de entrevista técnica cuyos resultados viven hoy en
  Google Docs (integración separada, ADR pendiente).
- CVs en formato VAIRIX adaptados por llamado (posible integración
  adicional con Drive).
- Potencial aparición futura de más custom fields (el tenant los puede
  crear sin aviso) y, eventualmente, `form-answers`/`questions` sobre
  applications/interviews cuando se mapeen los `interviews` de TT.

Sin una estrategia explícita, el proximo custom field creado por un
recruiter se perdería silenciosamente.

---

## Decisión

### 1. Modelo de almacenamiento: EAV por owner con columnas tipadas

Dos tablas nuevas:

- `custom_fields` — catálogo de definiciones, mirror de
  `/custom-fields` de TT. Filas identificables por `teamtailor_id`.
  Contiene metadata (`api_name`, `field_type`, `owner_type`,
  `is_private`, etc.).
- `candidate_custom_field_values` — valores asociados a cada
  `candidate` × `custom_field`, con columnas tipadas por
  `field_type` (`value_text`, `value_date`, `value_number`,
  `value_boolean`) más `raw_value` para debug cuando el cast falla.

```sql
custom_fields (
  id uuid primary key default gen_random_uuid(),
  teamtailor_id text unique not null,
  api_name text not null,
  name text not null,
  field_type text not null,    -- 'text' | 'date' | 'number' | 'boolean' | otros
  owner_type text not null,    -- 'Candidate' | 'Job' | ...
  is_private boolean not null default false,
  is_searchable boolean not null default false,
  raw_data jsonb,
  synced_at timestamptz not null default now()
);

candidate_custom_field_values (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references candidates(id) on delete cascade,
  custom_field_id uuid not null references custom_fields(id) on delete cascade,
  teamtailor_value_id text unique not null,
  field_type text not null,
  value_text text,
  value_date date,
  value_number numeric,
  value_boolean boolean,
  raw_value text,
  updated_at timestamptz not null default now(),
  unique (candidate_id, custom_field_id)
);
```

Cuando lleguen custom fields sobre otros owners (jobs, etc.) o
`form-answers` sobre applications/interviews, se crea una tabla
hermana con la misma forma (`<owner>_custom_field_values` /
`<owner>_answers`). No se usa un modelo polymorphic único (ver §3).

### 2. Sideload en el cliente: nuevo `paginateWithIncluded()`

El iterator `paginate()` existente se preserva intacto. Se agrega
un segundo método al `TeamtailorClient`:

```ts
paginateWithIncluded<A>(
  path: string,
  params?: Record<string, string>,
): AsyncIterable<{ resource: TTParsedResource<A>; included: TTParsedResource[] }>;
```

Cada yield entrega el recurso primario junto con **los recursos
`included` de la página entera** repetidos en cada yield. Los syncers
que necesitan sideload filtran el `included` por tipo y
relationship.id. Los syncers existentes no se tocan.

### 3. Tablas por owner, no polymorphic único

No se usa una tabla única `custom_field_values (owner_type, owner_id, ...)`
porque:

- Postgres no soporta FKs polymorphic nativas; se perdería
  integridad referencial.
- Las RLS policies se vuelven `CASE owner_type WHEN 'candidate' ...`;
  con tablas separadas cada policy es simple y alineada con la tabla
  del owner.
- El overhead de una tabla nueva por owner es trivial (~20 líneas
  de migración).

### 4. PII: traer is_private con flag en la fila, RLS decide

Los campos `is-private=true` de TT se traen igual. La fila en
`candidate_custom_field_values` **no** replica el flag (vive en la
definición `custom_fields.is_private`). Una policy RLS sobre
`candidate_custom_field_values` puede joinear con `custom_fields`
para bloquear `SELECT` cuando `is_private=true` y el rol actual no
es `recruiter_senior` o `admin`.

Para Fase 1 (único rol efectivo: admin) esto es inerte, pero el
contrato queda listo para Fase 2. El servicio de read expone los
valores igual que el resto de la PII del candidato (ADR-003).

### 5. Orden de sync: catálogo antes que instancias

El syncer `custom-fields` (catálogo) corre **antes** de `candidates`.
Es low-volume (≤ 50 filas en tenants típicos) y el syncer de
candidates necesita resolver `custom-field.id` (TT) → `custom_fields.id`
(UUID local) al persistir los valores sideloaded.

Nuevo orden: `stages → users → jobs → custom-fields → candidates → applications`.

### 6. Mapeo de `field-type` → columna tipada

TT devuelve valores como strings. El parser castea según `field-type`:

| TT `field-type`        | columna destino            | fallback                                                          |
| ---------------------- | -------------------------- | ----------------------------------------------------------------- |
| `CustomField::Text`    | `value_text`               | `raw_value` siempre                                               |
| `CustomField::Date`    | `value_date` (ISO 8601)    | si no parsea, `value_date=null`, `raw_value` sí                   |
| `CustomField::Number`  | `value_number`             | si no parsea, null + raw                                          |
| `CustomField::Boolean` | `value_boolean`            | si no parsea, null + raw                                          |
| Cualquier otro         | todas las `value_*` = null | `raw_value` guardado, field_type persistido, el consumidor decide |

El `raw_value` **siempre** se guarda (incluyendo cuando el cast
funciona). Esto da reversibilidad y permite detectar casts lossy a
posteriori.

---

## Alternativas consideradas

### A) `candidates.custom_fields jsonb` keyed by api-name

- **Pros**: cero migraciones al agregar fields nuevos; minimal code
  change.
- **Contras**: sin tipos, filtrar por fecha/número requiere casts en
  runtime; `is_private` y metadata por valor no tiene lugar; los
  `form-answers` de interviews (múltiples respuestas estructuradas)
  fuerzan anidamiento creciente.
- **Descartada porque**: la data custom crece en volumen y forma
  (interview forms, custom fields en jobs) y el jsonb se convierte
  en un basurero tipado-en-runtime. Además, RLS basado en
  `is_private` requiere una tabla con la metadata.

### C) Columnas tipadas en `candidates` por cada custom field

- **Pros**: type safety total, filtros ergonómicos.
- **Contras**: cada custom field nuevo en TT = migración; los
  `form-answers` con estructura dinámica no caben.
- **Descartada porque**: no escala. Los custom fields los define el
  recruiter en el admin de TT sin pasar por el equipo de producto.

### D) Tabla única `custom_field_values` polymorphic

- **Pros**: una sola tabla sirve candidates, jobs, applications,
  interviews.
- **Contras**: sin FK duras; RLS con `CASE owner_type`; queries con
  filtro por owner_type en todos lados.
- **Descartada porque**: la ganancia (una tabla menos) no compensa la
  pérdida de integridad ni la complejidad de RLS.

---

## Consecuencias

### Positivas

- Los custom fields del tenant se persisten con su semántica
  (`is_private`, `field_type`, `owner_type`).
- Filtros ergonómicos en SQL (`value_date >= now() - '30 days'`,
  `value_number > 5000`).
- Patrón reusable: cuando aparezcan `form-answers` / custom fields
  en jobs, se replica la forma en una tabla nueva.
- `raw_value` preservado → auditabilidad y reversión si detectamos
  casts malos a posteriori.
- El cliente recupera el sideload sin romper los 4 syncers existentes.

### Negativas

- Dos tablas nuevas, un syncer nuevo, + extensión del syncer de
  candidates. Overhead inicial no trivial.
- El syncer de candidates crece: además de mapear al row de
  `candidates` tiene que filtrar `included`, resolver FK a
  `custom_fields`, y upsertar N filas de valores por cada candidate.
- Cambio estructural en el orden del ETL (custom-fields antes de
  candidates) → runbook y scripts de sync deben actualizarse.
- Un custom field que desaparece en TT no se borra automáticamente
  de `candidate_custom_field_values` (cleanup queda para F2).

---

## Criterios de reevaluación

- Si los custom fields de TT superan ~50 por owner, revisar si
  justifica indexes adicionales en `value_text` (GIN trigram para
  LIKE) o materialized views por `api_name`.
- Si aparece un tenant multi-owner intensivo (ej.: > 5 owner types
  con custom fields) reconsiderar la tabla polymorphic (D).
- Si el costo de latencia del sideload de `custom-field-values` se
  vuelve dominante (páginas lentas en TT), separar en un syncer
  propio `candidate-custom-field-values` que corra después de
  `candidates`.

---

## Notas de implementación

- La unicidad de `teamtailor_value_id` en
  `candidate_custom_field_values` permite upsert idempotente aunque
  TT devuelva el mismo value varias veces en runs parciales.
- El `unique(candidate_id, custom_field_id)` es defensa en profundidad:
  TT emite a lo sumo un valor por pareja, pero ante un bug aguas
  arriba preferimos rechazar en DB antes que acumular duplicados.
- Custom fields que cambien de `field-type` en TT (raro pero posible)
  se detectan en el syncer al comparar con el row existente; la
  política es actualizar la metadata y re-parsear en la próxima
  corrida de candidates.
