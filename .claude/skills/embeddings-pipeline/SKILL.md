---
name: embeddings-pipeline
description: Cómo generar, invalidar y consultar embeddings con el pipeline del proyecto (provider abstraction, content_hash, detección de cambios, búsqueda vectorial con pgvector). Usar cuando la tarea toque src/lib/embeddings, la función edge del worker, o queries que crucen pgvector.
---

# Embeddings Pipeline

## Cuándo aplicar este skill

- Implementar o modificar el worker de embeddings.
- Agregar un nuevo `source_type` (hoy: `cv`, `evaluation`,
  `notes`, `profile`).
- Construir o optimizar una query de búsqueda vectorial o híbrida.
- Depurar por qué un candidate no aparece en semantic search.

## Principios no negociables

1. **Desacoplado del ETL.** El worker corre post-sync, nunca
   durante. Separar siempre.
2. **Provider abstraction.** Toda llamada al modelo pasa por
   `src/lib/embeddings/provider.ts`, que expone una interfaz
   `{ embed(text: string): Promise<number[]> }`. Cambiar de
   OpenAI a otro proveedor debería ser cambiar una implementación.
3. **`content_hash` gobierna la regeneración.** Nunca confiar en
   `updated_at` para decidir si re-embebar.
4. **Upsert por `(candidate_id, source_type, source_id)`**.
   No hay embeddings duplicados por fuente.
5. **Cambiar el modelo = Tier 2** (ver
   `docs/operation-classification.md`). Requiere ADR.

## Hash: qué entra y qué no

```typescript
import { createHash } from 'crypto';

export function contentHash(content: string, model: string): string {
  return createHash('sha256').update(`${model}::${content}`).digest('hex');
}
```

**Incluir siempre**:

- El texto normalizado (trim, whitespace colapsado).
- El nombre del modelo (`text-embedding-3-small`).

**Nunca incluir**:

- Timestamps.
- Metadata que cambia sin cambiar el contenido real.
- El `candidate_id` (el hash es del contenido, no de la fuente).

## Fuentes a embeber (Fase 3)

| `source_type` | `source_id`                    | Contenido                                          |
| ------------- | ------------------------------ | -------------------------------------------------- |
| `cv`          | `files.id` del CV más reciente | `files.parsed_text`                                |
| `evaluation`  | `evaluations.id`               | `evaluations.notes` (si existe)                    |
| `notes`       | `null`                         | concat de `notes.body` del candidate               |
| `profile`     | `null`                         | texto sintético: "Nombre, headline, tags, sumario" |

Nota: `source_id` es FK lógica — en la tabla `embeddings` es
`uuid` sin constraint, porque puede referenciar distintas tablas.

## Worker loop (pseudo-TS)

```typescript
export async function runEmbeddingsWorker(): Promise<void> {
  const candidates = await findCandidatesNeedingEmbedding();
  for (const c of candidates) {
    for (const src of sourcesOf(c)) {
      const content = normalize(src.content);
      const hash = contentHash(content, MODEL);

      const existing = await repos.embeddings.findBySource(c.id, src.type, src.sourceId);
      if (existing?.content_hash === hash) continue;

      const vector = await provider.embed(content);
      await repos.embeddings.upsert({
        candidate_id: c.id,
        source_type: src.type,
        source_id: src.sourceId,
        content,
        content_hash: hash,
        embedding: vector,
        model: MODEL,
      });
    }
  }
}
```

## Búsqueda

### Semántica pura

```sql
select candidate_id,
       source_type,
       1 - (embedding <=> $1) as similarity
from embeddings
order by embedding <=> $1
limit 50;
```

El operador `<=>` es distancia coseno en pgvector; `1 - distancia`
es similitud.

### Híbrida (el modo que importa)

Filtros estructurados **primero**, vector similarity **después**:

```sql
with filtered as (
  select c.id as candidate_id
  from candidates c
  join applications a on a.candidate_id = c.id
  where a.status = 'rejected'
    and a.rejected_at < now() - interval '1 year'
    and c.deleted_at is null
)
select e.candidate_id,
       e.source_type,
       1 - (e.embedding <=> $1) as similarity
from embeddings e
join filtered f on f.candidate_id = e.candidate_id
order by e.embedding <=> $1
limit 50;
```

**Razón**: `ivfflat` es más eficiente sobre un subset chico que
sobre toda la tabla. Filtros primero = órdenes de magnitud más rápido.

### Agregación por candidate

Un candidate con 3 embeddings que matchean aparece UNA vez con la
mejor similitud:

```sql
select candidate_id, max(similarity) as best
from (
  -- query anterior
) scored
group by candidate_id
order by best desc;
```

## Testing

Tests obligatorios (ver `use-cases.md` UC-06):

- `test_embedding_regenerated_when_content_changes`
- `test_embedding_skipped_when_hash_matches`
- `test_embedding_hash_includes_model_name`
- `test_embedding_worker_idempotent`

Para tests determinísticos, mockear el provider con MSW o un
provider falso que devuelva un vector estable por `hash(input)`.
No es el embedding real, pero permite asserts reproducibles.

## Costos y budget

- `text-embedding-3-small`: ~$0.02 por 1M tokens.
- 15k embeddings × ~2k tokens ≈ 30M tokens ≈ **$0.60 backfill**.
- Crecimiento: ~$0.06/mes.
- **Regenerar todo** (cambio de modelo): $0.60 de golpe. No
  dramático, pero documentar en ADR.

## Índice pgvector

```sql
create index idx_embeddings_vector on embeddings
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);
```

Con 15k rows, `lists = 100` es razonable. A > 1M rows, reevaluar
a `lists = 1000` o HNSW (si Supabase lo habilita). Re-evaluar en
ADR-005 §Criterios.

## Qué NO hacer

- ❌ Embeddings dentro del ETL (ADR-005 lo prohíbe).
- ❌ Regenerar todos los embeddings en cada cron tick.
- ❌ Hacer el hash sin el nombre de modelo.
- ❌ Guardar el embedding del usuario final (la query) en la tabla.
- ❌ Chunking manual en Fase 1. Un CV que excede 8192 tokens se
  trunca al primer chunk; warning loggeado. Fase 2+ introduce
  chunking real si hace falta.

## Referencias

- ADR-005 — decisión de proveedor, modelo, hash.
- `data-model.md` §13 — schema de `embeddings`.
- `docs/use-cases.md` UC-06 — acceptance criteria.
- `docs/architecture.md` §5 — flujo de búsqueda híbrida.
