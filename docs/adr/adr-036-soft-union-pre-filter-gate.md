# ADR-036 — Soft union pre-filter gate

- **Estado**: Aceptado
- **Fecha**: 2026-05-22
- **Decisores**: Owner VAIRIX + Claude Code
- **Relacionado con**: ADR-015 (matching-and-ranking), ADR-021
  (alternative-group-id), ADR-033 (server-side RPC matching pipeline),
  ADR-016 (rescue bucket)

---

## Contexto

El pre-filter actual (ADR-015 + ADR-033, RPC `match_pre_filter`) usa
**must_have_groups** como única compuerta de inclusión:

- Si todos los must-have del JD están sin resolver (`skill_id = null`)
  o el JD no marca ningún must-have, **el pool entero pasa al ranker**
  — todos los `candidates` visibles por RLS, hoy ~8 700 filas en prod.
- Las soft (no-must-have) son señales de scoring pero **nunca filtran**.

Caso observado (2026-05-22, run `/matching/new`): JD con dos
requirements ambos `must_have=false` (React + Node.js, soft). El
pre-filter no tiene must-have activos ⇒ devuelve los ~8 692
candidatos. El ranker procesa la totalidad cuando, por la propia
forma del JD, **un candidato sin React ni Node tiene total_score 0
por construcción** y no aporta valor al recruiter.

El costo no es solo de CPU — cada chunk del pipeline FE-driven
(ADR-034) corre `match_load_aggregates` + ranking deterministic
sobre filas que están condenadas a `total_score ≈ 0`. En el run
observado: 4 300 candidatos procesados en ~10 min sobre un pool
de 8 692. La señal de "este candidato no tiene NINGUNA de las
tecnologías pedidas" está estructuralmente disponible antes del
ranker y se está desperdiciando.

## Decisión

Extender el pre-filter con un **segundo gate aditivo** llamado
_soft union gate_:

> Sea `any_of_skill_ids` = unión de `requirement.skill_id` para todo
> requirement con `skill_id != null` (must y soft). Un candidato es
> incluído si y solo si:
>
> 1. Cubre todos los must-have groups activos (regla previa,
>    inalterada), Y
> 2. Si `any_of_skill_ids` es no vacío: tiene ≥1 fila en
>    `experience_skills` cuyo `skill_id ∈ any_of_skill_ids`.

Equivalencias:

- JD sin requirements resueltos ⇒ `any_of_skill_ids` vacío ⇒ gate (2)
  inactivo ⇒ comportamiento previo (todo el pool pasa, modulo gate
  must-have).
- JD con must-have resueltos ⇒ todo candidato que pasa gate (1)
  trivialmente pasa gate (2) (la unión incluye los must-have).
- JD con solo soft resueltos ⇒ gate (1) no aplica (sin grupos activos),
  gate (2) excluye a los de cero overlap. **Este es el caso que
  motivó la decisión.**

### Por qué unión y no intersección

Una intersección ("debe tener todas las soft") rompería la semántica
de "soft": pedir Tailwind y Sass como soft no debería excluir a un
candidato con solo Tailwind. La unión preserva la intención: filtrar
solo a los que tienen **cero** de las tecnologías pedidas — la
señal estructural más fuerte de no-match.

### Por qué no usar el ranker para esto

El ranker es CPU local sobre aggregates ya cargados; la decisión
"este candidato tiene cero overlap" se puede tomar en SQL antes de
cargar los aggregates. La diferencia es ~10-100× en throughput (índice
sobre `experience_skills.skill_id` vs leer experiencias completas

- idiomas + skills + merge de variantes). Mover la decisión al
  ranker desperdicia el round-trip de `match_load_aggregates`.

### Pre-filter excluded pool (rescate FTS)

Los candidatos excluídos por el gate (2) **no entran** al
`excluded` pool del RPC: el rescate FTS (ADR-016) busca candidatos
con must-have en `files.parsed_text`, no candidatos sin overlap
con las soft. Excluir por cero-overlap es decir "este pool no
aplica al JD", no "este candidato tiene la skill en otra forma".

## Consecuencias

### Positivas

- Pool al ranker se contrae al subconjunto con ≥1 overlap. En el
  caso observado, eso reduce 8 692 → algunos cientos típicamente.
- El total_score nunca se ve "contaminado" por filas con cero match.
  El top-N que devuelve `/finalize` queda libre de candidatos
  basura.
- Costo SQL marginal: una JOIN extra contra `experience_skills`
  filtrada por un array UUID con índice. Sub-segundo en el pool
  observado.
- Backward-compat con el contrato del RPC: `any_of_skill_ids` es un
  arg nuevo. Si se pasa `null` o vacío, el comportamiento es
  idéntico al previo.

### Costos

- Una decisión más en el pre-filter ⇒ más superficie de invariantes
  a documentar. Se contiene en `pre-filter.ts` (impl pura) +
  `match_pre_filter` RPC (impl SQL espejo) + estos tests.
- Si en el futuro se agrega un signal complementario "search by
  parsed_text" o similar como gate (3), el RPC empieza a tener varios
  args con la misma forma. Sigue siendo aditivo, pero conviene
  consolidar en un objeto `gates_in jsonb` si se acumulan más.

### Cambios al schema y RPC

Migración aditiva (`20260522000001_match_pre_filter_any_of.sql`):

- `create or replace function public.match_pre_filter(jsonb, uuid,
uuid[])`. Nueva firma con un tercer arg `any_of_skill_ids_in
uuid[] default null` (default permite que clientes legacy llamen
  sin pasar el arg).
- Cuerpo extendido: con `any_of_skill_ids_in` no nulo y no vacío,
  filtra `visible_candidates` por presencia en `experience_skills`
  con `skill_id = any(any_of_skill_ids_in)`. La decisión se aplica
  _antes_ del cálculo de `covered_count_per_candidate` para evitar
  trabajo desperdiciado.

### Cambios al contrato del service

`preFilterByMustHave` (impl pura) acepta el cómputo de la unión
internamente — la fuente es la misma `ResolvedDecomposition`. No
hay cambio en la firma pública.

`db-deps.ts` adapter: deriva `any_of_skill_ids` del resolved y lo
pasa al RPC. Igual que con `buildMustHaveGroups`, se exporta
`collectAnyOfSkillIds` desde `pre-filter.ts` como single source of
truth.

## Alternativas consideradas

### A. Implementar el filtro en el ranker (return 0-score → drop)

Rechazada — desperdicia el load de aggregates. La señal está en SQL,
no hay razón de subirla a TS.

### B. Filtrar solo cuando hay **algún** must-have resuelto

Rechazada — el caso motivador es JD con cero must-have resueltos
(todos soft). Es exactamente cuando el gate aporta más.

### C. Intersección de soft ("debe tener todas")

Rechazada — rompe la semántica de "soft" (ver §Por qué unión).

### D. Gate basado en parsed_text (FTS) en lugar de experience_skills

Rechazada — la FTS es para rescate de must-have (ADR-016), no para
filtro de masa. Activar FTS sobre 8 700 candidatos × N skills es
~100× más caro que un index lookup en `experience_skills`.

## Notas de implementación

- La unión se computa sobre **todos** los `req.skill_id` resueltos,
  sin importar `must_have`. Es la única definición consistente con
  la semántica "el candidato debe tener algo de lo pedido".
- `alternative_group_id` no afecta esta decisión: la unión es
  flat, los grupos son ortogonales al filtro de overlap.
- El RPC mantiene `security invoker` y `set search_path = public`
  ⇒ RLS preservado.
- Tests: invariantes en `pre-filter.test.ts` (sin RPC), e integración
  en la suite de matching contra la DB local.
