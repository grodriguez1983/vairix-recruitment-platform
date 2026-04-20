# ADR-013 — Taxonomía de skills (catálogo + aliases + resolver)

- **Estado**: Aceptado
- **Fecha**: 2026-04-20
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: ADR-012 (extracción), ADR-015 (matching/
  ranking, pendiente), `use-cases.md` UC-11, `data-model.md`
  (pendiente actualizar), ADR-003 (RLS)

---

## Contexto

ADR-012 §2 fijó que ambos backends de extracción devuelven skills
como strings crudos (`"React.js"`, `"ReactJS"`, `"react"` pueden
coexistir) y que la normalización **no** ocurre en los backends.
Esto desplaza el problema a este ADR: si no tenemos catálogo, no
podemos responder _"candidatos con ≥3 años de React"_ — una query
con `WHERE skill_raw ILIKE '%react%'` rompe en los dos sentidos
(falso positivo: "React Native", "React Router", "reactive
programming" matchean; falso negativo: un candidato que escribió
"ReactJS" en un CV y "react.js" en otro aparece con años partidos).

Observaciones sobre el dominio real:

- Tenant VAIRIX: tech recruiting. Las skills que importan son un
  conjunto razonablemente cerrado de ~300–500 ítems (lenguajes,
  frameworks, herramientas, plataformas cloud, bases de datos).
- Los CVs están en mix ES/EN — esperamos variantes como
  `"Node.js"` / `"NodeJS"` / `"nodejs"` / `"node"`.
- La primera fuente de matching para UC-11 es el filtro estructural
  (`experience_skills`); la similitud semántica complementa pero no
  sustituye. Si el resolver de skills es malo, UC-11 es malo.

Restricciones:

- No hay budget para LLM-per-skill en cada extracción (sería 2×–5×
  el costo del extractor). Queremos resolver determinístico y
  barato.
- El admin (rol en ADR-003) es quien cura el catálogo — no es
  autogenerado sin supervisión.

---

## Decisión

### 1. Estructura del catálogo: dos tablas

```sql
skills (
  id              uuid primary key default gen_random_uuid(),
  canonical_name  text not null,               -- "React", "Node.js"
  slug            text not null unique,        -- "react", "node-js"
  category        text null,                   -- "framework", "language", ...
  deprecated_at   timestamptz null,
  tenant_id       uuid null,                   -- ADR-003 hedge
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

skill_aliases (
  id              uuid primary key default gen_random_uuid(),
  skill_id        uuid not null references skills(id) on delete cascade,
  alias_normalized text not null,              -- lowercased, trim, no punct
  source          text not null check (source in ('seed', 'admin', 'derived')),
  created_at      timestamptz not null default now(),
  unique (alias_normalized)
);
```

Puntos clave:

- `slug` es estable y usable en URLs / filtros / config. No cambia
  al renombrar `canonical_name`.
- `alias_normalized` vive **una sola vez globalmente** (unique). Si
  dos skills reclaman el mismo alias, gana quien lo insertó primero
  y un reviewer humano resuelve. Evita ambigüedad silenciosa al
  resolver.
- `category` es opcional y plano. **No hay jerarquía** (React no
  "pertenece a" JavaScript en el schema). La jerarquía es bloating
  para el objetivo de UC-11.
- `deprecated_at` permite retirar skills obsoletas sin borrar (soft
  delete). Un skill deprecated se muestra pero no se propone en
  autocompletes.
- `tenant_id` nullable por ADR-003 hedge. Fase 1: todos `null`.

### 2. Resolver determinístico

`src/lib/skills/resolver.ts` (función pura, sin I/O excepto acceso
al catálogo inyectado):

```ts
function resolveSkill(
  rawInput: string,
  catalog: CatalogSnapshot,
): { skill_id: string; confidence: 'exact' | 'alias' } | null;
```

Pipeline:

1. **Normalizar input**: `toLowerCase()` → `trim()` → colapsar
   whitespace interno → **strippar puntuación final** (`.`, `,`,
   `;`, `:`) pero **conservar puntuación interna** (`.` en
   `"node.js"`, `+` en `"c++"`, `#` en `"c#"`, `/` en `"ci/cd"`).
2. **Exact match** contra `skills.slug`. Match → devolver
   `{skill_id, confidence: 'exact'}`.
3. **Alias match** contra `skill_aliases.alias_normalized`. Match
   → devolver `{skill_id, confidence: 'alias'}`.
4. **No match** → devolver `null`. **No hay fuzzy matching** ni
   Levenshtein en Fase 1 (ver §Alternativas D).

El `CatalogSnapshot` es una estructura en memoria (dos `Map`s:
slug→skill_id, alias→skill_id) cargada una vez al arrancar el
worker. Invalidación: si el worker corre por días y alguien toca
el catálogo, el próximo batch recarga; dentro de un batch el
snapshot es inmutable (consistencia intra-batch).

### 3. Fallback: `experience_skills.skill_id` nullable

El upsert de `experience_skills` (disparado por el worker de
extracción, ADR-012 §7) hace:

```
INSERT INTO experience_skills (experience_id, skill_raw, skill_id, evidence_snippet)
VALUES (..., raw_string, resolveSkill(raw_string)?.skill_id, ...)
```

Si `skill_id` es null → el candidato tiene la skill _"como string
suelto"_. Consecuencias:

- Se muestra en la UI del perfil con un badge "no catalogada".
- **NO cuenta** para filtros `min_years` del matcher (ADR-015) —
  un filtro `min_years: 3 ON skill='React'` solo opera sobre
  `experience_skills.skill_id = <React.id>`, no sobre strings
  libres.
- Alimenta el **reporte de admin** (ver §5) para que el curador
  decida si agregar alias / skill nueva / descartar.

Cuando un admin agrega un alias o skill que cubre un
`experience_skills.skill_raw` previamente no-catalogado, un job
batch (`pnpm skills:reconcile`) actualiza los `skill_id` null
retroactivamente. Es idempotente y no toca filas con `skill_id`
ya resuelto.

### 4. Seed inicial (híbrido: curado + derivado)

Una sola migración de seed en `supabase/migrations/` con:

- **Lista curada** de ~50–80 skills de alta frecuencia esperada
  (React, Node.js, PostgreSQL, AWS, Python, TypeScript, Docker,
  Kubernetes, etc.) con aliases obvios (`"node"`, `"nodejs"`,
  `"node.js"` → Node.js). Vive en
  `src/lib/skills/seed/canonical.ts` como array tipado, y la
  migración es generada por un CLI `pnpm skills:gen-seed` que lee
  el array y escribe el SQL. Así el array es auditable en TS y la
  migración queda en SQL estándar del repo.
- **Aliases derivados** en una **segunda** migración, generada con
  `pnpm skills:derive-aliases-from-cvs`: escanea todos los
  `experience_skills.skill_raw` no-catalogados actuales, agrupa
  por `alias_normalized`, y lista los top N (freq ≥ 5) con su
  mejor guess de `skill_id` (ninguno, por default — el admin
  confirma). El CLI produce un `TODO.md` editable, el admin
  revisa manualmente, y al aprobar se materializa una migración.

Este paso de "derivar desde data real" solo puede correrse **una
vez que hay extracciones reales** — o sea, después del primer
backfill con catálogo curado. Es iterativo por diseño.

### 5. Mantenimiento y UI admin

Dos endpoints nuevos bajo `/admin/skills` (rol `admin` via ADR-003):

- `/admin/skills` — lista paginada con search por `canonical_name`
  y count de uso (`experience_skills` matching). Inline edit de
  `canonical_name` / `category` / `deprecated_at`. Botón "agregar
  skill".
- `/admin/skills/uncataloged` — reporte del §3: top N
  `alias_normalized` sin `skill_id`, con ejemplos de
  `evidence_snippet`. Acciones: (a) "crear skill nueva a partir
  de este alias" (b) "asignar como alias de skill existente"
  (c) "descartar permanentemente" (se agrega a
  `skills_blacklist`, ver abajo).

`skills_blacklist (alias_normalized unique)`: tabla pequeña para
strings que nunca deben promoverse (ej. `"mi experiencia laboral"`
u otros falsos positivos de extracción). El resolver no la
consulta — solo sirve para que `/admin/skills/uncataloged` oculte
filas ya revisadas y descartadas.

Todo cambio al catálogo que venga de la UI admin se registra con
`source='admin'` en `skill_aliases`. Permite auditar qué es seed
vs qué es curación humana.

### 6. RLS

- `skills`: SELECT abierto a `recruiter` + `admin`. INSERT /
  UPDATE / DELETE solo `admin`.
- `skill_aliases`: idem `skills`.
- `skills_blacklist`: SELECT + INSERT + DELETE solo `admin`.
  `recruiter` no la ve ni la toca.
- Todas con `enable row level security` + `force`, como el resto
  del dominio (ADR-003).

### 7. Interacción con ADR-015 (ranker)

El ranker de UC-11 consume `experience_skills.skill_id`
directamente. Para cada requisito `{skill: "React", min_years: 3}`
del llamado descompuesto (ADR-014, pendiente), el flow es:

1. Resolver `"React"` contra el catálogo → `skill_id`.
2. Si no resuelve (no existe en catálogo) → **error accionable al
   usuario**: "la skill 'React' no está en el catálogo; agregala
   desde /admin/skills o reescribí el llamado". No se silencia.
3. Si resuelve → query SQL sobre `experience_skills` con
   `skill_id = ?`, joineada con `candidate_experiences` para años
   (overlapping, ADR-015).

Esto fuerza que el catálogo esté "al día" respecto al vocabulario
de los llamados que llegan, y hace visible la deuda de catálogo en
vez de devolver `0 results` sin explicar por qué.

---

## Alternativas consideradas

### A) Sin catálogo — matching por regex / ILIKE sobre `skill_raw`

- **Pros**: sin schema nuevo, sin curación.
- **Contras**: falsos positivos ("React Native" matchea "React"),
  falsos negativos ("nodejs" vs "node.js"), imposible responder
  años por skill con precisión. Rompe el contrato de UC-11.
- **Descartada** — es exactamente el problema que este ADR
  resuelve.

### B) LLM resolver — pasar el `skill_raw` a un LLM que lo mapee

- **Pros**: recall altísimo, maneja variantes raras y acrónimos
  ("k8s" → Kubernetes, "PG" → PostgreSQL).
- **Contras**: ~1000 candidates × ~15 skills/CV × costo-por-query
  es caro y lento. No determinístico: el mismo string puede
  mapear distinto según drift del modelo. Difícil auditar.
- **Postergada**. Trigger de re-evaluación: si el §5 reporta >
  30% de skills sin catalogar después de 2 rondas de curación
  humana, considerar un LLM resolver _como asistente_ para el
  admin (no como reemplazo del catálogo determinístico).

### C) Catálogo jerárquico (React isA Framework isA JS-ecosystem)

- **Pros**: queries más expresivas ("cualquier framework JS
  moderno").
- **Contras**: complejidad de taxonomía, imposible de mantener
  con el equipo chico, el ranker se complica. UC-11 no lo pide
  ("pedinos 3 años de React" es la query, no "3 años de algún
  framework JS").
- **Descartada**. Si el caso aparece en Fase 2+, se agrega como
  tabla aparte sin romper el catálogo plano.

### D) Fuzzy matching (Levenshtein, trigram) en el resolver

- **Pros**: captura typos humanos en CVs ("Postgre" →
  PostgreSQL).
- **Contras**: falsos positivos insidiosos ("Java" ↔ "JavaScript"
  tienen Levenshtein bajo y significado muy distinto). Debugging
  complejo.
- **Descartada** para Fase 1. Si aparece la necesidad, se puede
  agregar como paso 4 del resolver con threshold alto y confianza
  marcada (`'fuzzy'`), pero sin silenciar el mismatch.

### E) Importar taxonomía externa (LinkedIn Skills, O\*NET, ESCO)

- **Pros**: ~30k+ skills ya curadas con variantes.
- **Contras**: licencia (LinkedIn no lo exporta), ruido (miles de
  skills que nunca veremos), mantener sincronía con upstream.
- **Descartada** — overkill para ~500 skills relevantes a tech
  recruiting en VAIRIX. Se puede usar como _inspiración_ para el
  seed curado de §4, pero no como fuente viva.

### F) Una sola tabla con `aliases jsonb`

- **Pros**: menos joins, menos tablas.
- **Contras**: perdés unique constraint sobre alias globalmente
  (dos skills pueden reclamar el mismo alias sin error). El
  resolver requiere scan completo del array. Menos auditable
  (quién agregó qué alias).
- **Descartada**.

---

## Consecuencias

### Positivas

- Resolver barato y determinístico — 0 llamadas externas, cache
  in-memory trivial.
- `experience_skills.skill_id` nullable permite evolucionar el
  catálogo sin re-extraer: `pnpm skills:reconcile` llena los null
  retroactivamente.
- El reporte admin de §5 convierte la deuda de catálogo en un
  backlog visible, no en un bug silencioso.
- Jerarquía plana → schema mínimo, migraciones simples.

### Negativas

- Requiere curación humana continua — un admin tiene que revisar
  `/admin/skills/uncataloged` periódicamente. Sin esto, la cola
  crece y UC-11 pierde recall gradualmente.
- El paso §7.2 (error accionable si el llamado menciona una skill
  no-catalogada) va a ser fricción al arranque hasta que el
  catálogo se asiente. Trade-off aceptado: prefiero fricción
  visible a silent-zero-results.
- No capturamos typos ni variantes exóticas en Fase 1 (sin fuzzy
  / sin LLM). Candidatos con errores de tipeo en su CV aparecen
  sub-representados. Documentado como riesgo conocido.

---

## Criterios de reevaluación

- Si `/admin/skills/uncataloged` acumula > 200 entradas sin
  revisar por más de 4 semanas: automatizar parcialmente
  (sugerencias de LLM con approve/reject humano, o seed desde
  taxonomía externa).
- Si recall de UC-11 medido sobre un panel de ~30 queries reales
  es < 70% por falta de aliases: activar paso fuzzy en el
  resolver con threshold alto.
- Si aparece necesidad de jerarquía (ej. "mostrame cualquier
  framework JS"): no tocar `skills`; agregar tabla
  `skill_parents (child_id, parent_id)` aparte.
- Si la categorización plana no alcanza (ej. un skill es lenguaje
  Y framework según contexto): agregar `skill_tags` jsonb sin
  romper schema existente.
- Si llega un segundo tenant con vocabulario distinto: `tenant_id`
  del hedge ya está; activar filtros en resolver + catálogo por
  tenant.

---

## Notas de implementación

### Función SQL del resolver (helper usable desde otras queries)

```sql
create or replace function public.resolve_skill(p_raw text)
returns uuid
language sql
stable
set search_path = public, extensions
as $$
  select s.id
  from skills s
  where s.slug = public.normalize_skill_alias(p_raw)
    and s.deprecated_at is null
  union all
  select sa.skill_id
  from skill_aliases sa
  where sa.alias_normalized = public.normalize_skill_alias(p_raw)
  limit 1;
$$;
```

`normalize_skill_alias(text)` es otra función pura SQL que
replica el step 1 del resolver TS (lowercase, trim, strip
punctuation terminal). Tener una versión SQL y una TS idénticas
evita drift: los tests adversariales deben verificar que
`resolver.ts(x) === resolve_skill(x)` para un set de entradas.

### Tests obligatorios (RED antes de implementar)

- `test_resolver_exact_slug_match`
- `test_resolver_alias_match`
- `test_resolver_no_match_returns_null`
- `test_resolver_normalizes_casing_and_whitespace`
- `test_resolver_preserves_internal_punct` (c++, c#, node.js,
  ci/cd)
- `test_resolver_deprecated_skill_not_matched`
- `test_alias_global_uniqueness_enforced`
- `test_reconcile_backfills_null_skill_ids`
- `test_reconcile_is_idempotent`
- `test_sql_and_ts_resolvers_agree_on_fixture_set`
- `test_admin_only_can_insert_skill` (RLS)
- `test_recruiter_can_read_skills_only`
- `test_uncataloged_report_groups_and_sorts_by_frequency`
- `test_blacklist_hides_entry_from_uncataloged_report`

### Dependencias

- Ninguna nueva. Todo SQL estándar + TypeScript puro.
