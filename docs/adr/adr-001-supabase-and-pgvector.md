# ADR-001 — Supabase + pgvector como stack de datos

- **Estado**: Aceptado
- **Fecha**: 2026-04-17
- **Decisores**: Equipo interno
- **Relacionado con**: `spec.md` §6, `data-model.md`

---

## Contexto

El sistema requiere:
- Base de datos relacional con FKs y queries complejas.
- Búsqueda full-text (filtros estructurados).
- Búsqueda vectorial (semántica) sobre CVs y evaluations.
- Storage para CVs (PDFs).
- Auth para reclutadores internos.
- Setup rápido (POC), bajo costo operativo, propiedad de los datos.

Volumen esperado en el horizonte de 12 meses:
- ~10k candidates, ~30k applications, ~50k evaluations
- ~10k CVs almacenados
- ~100k embeddings (múltiples por candidate)

---

## Decisión

Adoptar **Supabase** como plataforma única para:
- Postgres (modelo relacional + JSONB para raw data)
- **pgvector** para búsqueda vectorial
- Storage (bucket para CVs)
- Auth (reclutadores internos)

No adoptar en esta fase:
- Elasticsearch / OpenSearch
- Pinecone, Weaviate, Qdrant u otros vector stores externos
- Bases de datos separadas para OLTP vs search

---

## Alternativas consideradas

### A) Postgres self-hosted + pgvector
- **Pros**: control total, sin vendor lock-in fuerte.
- **Contras**: costo operativo alto, hay que resolver backups, auth y
  storage por separado.
- **Descartada**: no aporta valor en fase POC.

### B) Postgres + Elasticsearch
- **Pros**: búsqueda muy potente, features avanzadas (aggregations,
  facets, highlighting nativo).
- **Contras**: dos sistemas a sincronizar, doble costo, doble
  operación. Overkill para el volumen esperado.
- **Descartada por ahora**: reevaluar si superamos 500k candidates o
  si la búsqueda full-text de Postgres resulta insuficiente.

### C) Supabase + Pinecone (o similar)
- **Pros**: mejor performance a gran escala en vector search.
- **Contras**: costo adicional, sync de IDs, latencia extra, otro
  servicio a monitorear.
- **Descartada**: pgvector alcanza de sobra para el volumen de Fase 1-3.

### D) Firebase / Firestore
- **Pros**: setup trivial, auth incluido.
- **Contras**: modelo documental, queries complejas dolorosas, sin
  búsqueda vectorial nativa, vendor lock-in fuerte.
- **Descartada**: el dominio es fundamentalmente relacional.

---

## Consecuencias

### Positivas
- Un solo proveedor para DB, storage, auth y vectors → menos fricción.
- Postgres como denominador común permite queries híbridas (filtros
  SQL + vector similarity) en una sola query.
- RLS de Supabase simplifica el modelo de permisos.
- Tipos TS generados automáticamente desde el schema.
- Migración a Postgres self-hosted es trivial si hiciera falta.

### Negativas
- pgvector tiene límites a gran escala (> millones de vectores con
  alta dimensionalidad). Trigger para reevaluar: p95 de query vectorial
  > 500ms o índice > 10GB.
- Dependencia de Supabase para auth y storage. Mitigación: envolver
  sus SDKs en adapters propios.
- Full-text de Postgres es menos sofisticado que Elasticsearch
  (sin fuzzy scoring avanzado, sin BM25 tuning fino). Aceptable en
  fase POC.

---

## Criterios de reevaluación

Revisitar esta decisión si se cumple **cualquiera** de:
- Superamos 500k candidates o 5M embeddings
- Queries híbridas superan p95 > 1s en producción
- Requerimos features de Elasticsearch (facets complejos, highlighting
  avanzado, synonyms tuning)
- Supabase deja de ser costo-efectivo (>$500/mes sin justificación)
