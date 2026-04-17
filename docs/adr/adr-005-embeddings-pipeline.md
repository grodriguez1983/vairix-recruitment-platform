# ADR-005 — Embeddings: proveedor, modelo y pipeline

- **Estado**: Aceptado
- **Fecha**: 2026-04-17
- **Decisores**: Equipo interno
- **Relacionado con**: `spec.md` §7.2, §8, `data-model.md`, ADR-001

---

## Contexto

`data-model.md` ya asumía `vector(1536)` y mencionaba
`text-embedding-3-small` sin ADR que lo respalde. El spec define el
caso de uso (búsqueda semántica, RAG) pero deja abierto:

- Proveedor de embeddings.
- Dimensión.
- Dónde se dispara la generación (ETL, worker separado, on-demand).
- Cómo se detectan cambios para re-embeber.
- Presupuesto.

Volumen esperado:

- ~5k candidates × ~3 fuentes (CV + evaluaciones agregadas + perfil)
  ≈ 15k embeddings iniciales.
- Crecimiento orgánico: ~500 candidates/mes ≈ 1.5k embeddings nuevos.
- Corpus mixto ES/EN (Uruguay + staff augmentation en US).

---

## Decisión

### Proveedor y modelo

**OpenAI `text-embedding-3-small`**, dimensión **1536**.

Ratifica lo que `data-model.md` ya asumía.

### Pipeline

**Worker separado, post-sync.** No se genera nada de embeddings
dentro de las funciones de ETL. Queda explícito el principio de
separación de capas del spec.

Arquitectura:

```
Teamtailor sync → upsert en Postgres
                       ↓
            (trigger or cron)
                       ↓
  embeddings worker → lee fuentes con content_hash outdated
                   → genera embedding
                   → upsert en `embeddings` con nuevo content_hash
```

Runtime del worker: **Supabase Edge Function** invocada por cron
cada 15 min, o disparada manualmente tras un backfill.

### Detección de cambios

Columna `content_hash text` en `embeddings`, calculada como
SHA-256 sobre el texto fuente + nombre de modelo.

Algoritmo del worker:

1. Para cada fuente candidata (cv, evaluation, notes, profile):
   - Calcular hash del content actual.
   - Comparar con `embeddings.content_hash` del registro existente
     para esa `(candidate_id, source_type, source_id)`.
   - Si difiere o no existe → regenerar embedding.
2. Upsert por clave `(candidate_id, source_type, source_id)`.

El hash incluye el nombre de modelo para forzar regeneración si
cambiamos de modelo en el futuro.

### Fuentes a embeber

| `source_type` | Contenido                                                 | Cuándo se regenera               |
| ------------- | --------------------------------------------------------- | -------------------------------- |
| `cv`          | `files.parsed_text` del CV más reciente del candidate     | Al cambiar `parsed_text`         |
| `evaluation`  | `evaluations.notes` cuando existen                        | Al cambiar `notes`               |
| `notes`       | Concatenación de `notes.body` del candidate               | Al agregarse o editarse una note |
| `profile`     | Texto sintético: "Nombre, headline, tags, sumario del CV" | Cuando cambia cualquier input    |

### Chunking

Para Fase 1: **no chunking**. Se embebe el texto completo de cada
fuente hasta el límite del modelo (8192 tokens).

Si un CV excede el límite, se truncará al primer chunk y se loggeará
warning. En Fase 2 se puede introducir chunking con overlap si se
detectan CVs largos relevantes que se pierden.

### Costos estimados

- Precio actual de `text-embedding-3-small`: **~$0.02 por 1M tokens**.
- Estimación total Fase 1 (15k embeddings × 2k tokens promedio):
  ~30M tokens = **~$0.60 backfill completo**.
- Crecimiento orgánico: ~$0.06/mes.

Costos despreciables. No hace falta presupuesto formal.

### Búsqueda semántica (uso de los embeddings)

Al servir una query de búsqueda:

1. Generar embedding de la query del usuario con el mismo modelo.
2. Query SQL con pgvector:
   ```sql
   select candidate_id, source_type,
          1 - (embedding <=> $1) as similarity
   from embeddings
   where $filters
   order by embedding <=> $1
   limit 50;
   ```
3. Agrupar por candidate_id, tomar la mejor similitud, aplicar
   filtros estructurales adicionales.

Para búsqueda híbrida (estructurada + semántica): aplicar filtros
SQL primero (índices B-tree) y pasar el subset a la query vectorial.

---

## Alternativas consideradas

### A) Voyage AI (`voyage-3` o `voyage-3-lite`)

- **Pros**: benchmarks superiores en retrieval, multilingüe fuerte.
- **Contras**: proveedor menos maduro, menos librerías, costo
  similar a OpenAI pero sin ventaja marcada para este caso.
- **Descartada Fase 1**, reevaluar en Fase 3 si la calidad en
  español flojea.

### B) Cohere `embed-multilingual-v3`

- **Pros**: multilingüe nativo, 1024 dim (más eficiente).
- **Contras**: menor adopción, menos tooling.
- **Descartada**.

### C) Modelo local (`bge-m3`, `e5-mistral`)

- **Pros**: sin costo por token, sin vendor lock-in.
- **Contras**: infraestructura GPU, setup complejo, latencia.
  No justifica con 5k candidates.
- **Descartada**.

### D) Embeddings en el ETL (inline)

- **Contras**: mezcla responsabilidades, hace el sync más lento y
  frágil, dificulta re-embebidos masivos.
- **Descartada** explícitamente (violaría principio del spec).

### E) Sin content_hash, usar `updated_at` de la fuente

- **Pros**: más simple.
- **Contras**: `updated_at` cambia por metadata irrelevante; regenera
  embeddings innecesariamente (costo + tiempo).
- **Descartada**: el hash es exacto y barato de calcular.

---

## Consecuencias

### Positivas

- Costo prácticamente nulo en Fase 1.
- Pipeline claro y desacoplado del ETL.
- Cambio de modelo en el futuro solo requiere cambiar una constante
  y disparar un re-embedding masivo (el hash detecta el cambio).
- Dimensión 1536 compatible con la mayoría de modelos del mercado si
  hubiera que migrar (se puede truncar, no al revés).

### Negativas

- Vendor lock-in a OpenAI a nivel de API. Mitigación: envolver el
  cliente en `src/lib/embeddings/provider.ts` con interfaz genérica.
- Búsqueda semántica requiere una llamada a OpenAI por query de
  usuario. Latencia ~300ms. Aceptable para el caso de uso.
- Al no chunkear, CVs muy largos pierden información del final.
  Aceptado como trade-off de Fase 1.
- `text-embedding-3-small` es "pequeño" en la familia de OpenAI. Si
  la calidad no alcanza, el upgrade natural es `text-embedding-3-large`
  (3072 dim) → cambio de schema. Por eso el hedge del hash.

---

## Criterios de reevaluación

- Si la recuperación en queries de prueba tiene precisión < 70% en
  un set curado: probar `text-embedding-3-large` o Voyage.
- Si el gasto mensual supera $50: revisar volúmenes, posiblemente
  reducir fuentes embebidas.
- Si aparece requerimiento de on-prem / air-gapped: migrar a modelo
  local.
