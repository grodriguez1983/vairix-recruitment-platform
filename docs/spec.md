> **Fuente canónica del proyecto Recruitment Data Platform.**
> Última actualización: 2026-04-17 (post audit + ADRs 003-007).
> Cualquier cambio en decisiones técnicas o de producto debe reflejarse
> aquí vía ADR o actualización directa de este documento.

# 📄 Especificación del Sistema – Data Platform de Reclutamiento

## 1. 🎯 Objetivo

Construir una aplicación interna que:

- Centralice **todos los datos de candidatos desde Teamtailor**
- Permita **consultas avanzadas (estructuradas + semánticas)**
- Habilite **reutilización inteligente de candidatos**
- Sea usable por **reclutadores no técnicos**
- Sirva como base para evolucionar a:
  - Talent Intelligence
  - Matching automático
  - Recontacto inteligente

---

## 2. 🧠 Casos de Uso Clave

### 2.1 Re-descubrimiento de candidatos

> "Mostrame candidatos rechazados hace +2 años por nivel técnico bajo en Node.js"

### 2.2 Búsqueda semántica

> "Backend senior prolijo, buena comunicación pero flojo en system design"

### 2.3 Pipeline histórico

- Ver evolución de un candidato
- Saber por qué fue rechazado
- Identificar mejoras en el tiempo

### 2.4 Talent Pool interno

- Tags automáticos/manuales
- Listas reutilizables (shortlists)

### 2.5 Insights de reclutamiento

- Cuellos de botella
- Motivos de rechazo más comunes
- Performance de evaluadores

---

## 3. 🏗️ Arquitectura Propuesta (POC)

```
Teamtailor API
     ↓
ETL Sync Service (Next.js / scripts)
     ↓
PostgreSQL (Supabase)
     ↓
Embeddings + Vector Store (pgvector)
     ↓
API (Next.js)
     ↓
UI (Next.js)
```

---

## 4. 🗄️ Modelo de Datos (resumen)

> El schema completo con tipos, FKs e índices está en `data-model.md`.

### 4.1 `candidates`

- id (uuid interno)
- teamtailor_id
- nombre, email, teléfono, linkedin
- timestamps

### 4.2 `applications`

- id, candidate_id, job_id
- stage, status (active, rejected, hired, withdrawn)
- source, timestamps

### 4.3 `jobs`

- id, title, department, location, status

### 4.4 `evaluations`

- id, candidate_id, application_id
- evaluator, score, decision
- rejection_reason, notes

### 4.5 `files` (CVs)

- id, candidate_id, file_url, parsed_text

### 4.6 `tags` + `candidate_tags`

### 4.7 `embeddings`

- id, candidate_id, source_type (cv, evaluation, notes)
- content, embedding vector, model

---

## 5. ⚙️ ETL / Ingesta de Datos

> Estrategia lógica definida en **ADR-002**. Orquestación y runtime
> definidos en **ADR-004**.

### Estrategia

Sync **incremental** por `updated_at`, con backfill inicial manual.
Upsert por `teamtailor_id`, siempre idempotente.

### Runtime (ADR-004)

| Caso                       | Runtime                 |
| -------------------------- | ----------------------- |
| Sync incremental (< 5 min) | Supabase Edge Functions |
| Backfill inicial / reindex | GitHub Actions          |
| Webhooks (Fase 2+)         | Vercel API routes       |

Frecuencia incremental: cada 15 min en horario laboral, cada hora
fuera de ese rango. Configurable.

### Orden de sync

1. `stages`
2. `users` (evaluadores)
3. `jobs`
4. `candidates`
5. `applications`
6. `evaluations` / `notes`
7. `files` (descarga + storage + parse)

### Consideraciones

- Paginación obligatoria.
- Rate limit (~50 req / 10s) con backoff exponencial + jitter.
- Concurrencia controlada vía `sync_state.last_run_status`; stale
  timeout de 1h.
- Errores puntuales persistidos en `sync_errors`, no detienen el batch.
- Embeddings y parsing **no viven en el ETL**: corren en workers
  separados post-sync (ver ADR-005 y ADR-006).

---

## 6. 🧰 Stack Tecnológico

> Decisiones formalizadas en ADR-001 (Supabase + pgvector),
> ADR-004 (runtime ETL), ADR-005 (embeddings), ADR-006 (CVs).

### Frontend + Backend

- Next.js (App Router, TypeScript estricto)

### Base de Datos + Storage + Auth

- Supabase (Postgres + Storage privado + Auth)
- pgvector para búsqueda vectorial

### Auth y permisos (ADR-003)

- Supabase Auth, sin registro público
- Dos roles en Fase 1: `recruiter`, `admin`
- RLS activa en todas las tablas de dominio

### Embeddings (ADR-005)

- Proveedor: OpenAI `text-embedding-3-small`, 1536 dim
- Worker separado post-sync
- Detección de cambios por SHA-256 de contenido

### Parsing CVs (ADR-006)

- `pdf-parse` + `mammoth`
- Sin OCR en Fase 1 (marcar `likely_scanned`)
- Bucket privado, URLs firmadas on-demand

### Búsqueda

- Full-text search de Postgres con config `simple` (ES+EN mix)
- Vector search (pgvector)
- Híbrida (filtros SQL + vector similarity)
- Elasticsearch: NO en roadmap inicial

---

## 7. 🔍 Sistema de Búsqueda

### 7.1 Búsqueda estructurada

Filtros por skills, fecha, resultado, evaluador, status, job.

### 7.2 Búsqueda semántica

Flujo:

1. Query del usuario → embedding
2. Comparar con embeddings de CV + evaluaciones
3. Ranking por similitud coseno

### 7.3 Búsqueda híbrida

SQL filters sobre metadata + vector similarity sobre contenido.

---

## 8. 🤖 Uso de RAG

### Casos

- "¿Por qué rechazamos a este candidato?"
- "¿Este candidato mejoró en sus últimas postulaciones?"
- "Resumime el historial de X"

### Flujo

1. Retrieval de contexto relevante (evaluaciones + CV + notas)
2. LLM responde con citas a la fuente

---

## 9. 🧑‍💼 UX para Reclutadores

- 🔎 Barra de búsqueda tipo Google (punto de entrada principal)
- 🎯 Filtros simples (no queries SQL a la vista)
- 🏷️ Tags visibles y editables
- 📄 Vista consolidada del candidate:
  - CV
  - Evaluaciones
  - Historial de aplicaciones
  - Tags y notas
- 📋 Shortlists (Fase 1) para curar candidates por búsqueda

Principio: el reclutador no debería necesitar entender el modelo de datos.

### 9.1 Auth y roles (ver ADR-003)

- Sin registro público. Usuarios creados por invitación.
- Dos roles:
  - `recruiter`: uso diario, CRUD candidates/tags/shortlists.
  - `admin`: todo lo anterior + sync, config, rejection categories.
- `hiring_manager` fuera de Fase 1.

---

## 10. 🚀 Roadmap

### Fase 1 — Fundación

- Auth + RLS (ADR-003)
- Sync de datos desde Teamtailor (ADR-004)
- UI básica: búsqueda y perfil
- Búsqueda estructurada
- Sistema de tags manual
- **Shortlists**
- CV storage + parsing básico (ADR-006)

### Fase 2 — Enriquecimiento

- Normalización de rejection reasons (ADR-007)
- Webhooks de Teamtailor
- Tags automáticos (derivados de CV)
- Métricas y observabilidad

### Fase 3 — Semántica

- Embeddings (ADR-005)
- Búsqueda semántica e híbrida
- OCR de CVs escaneados

### Fase 4 — Inteligencia

- RAG sobre historial del candidate
- Insights automáticos de reclutamiento
- `hiring_manager` como rol (si aplica)

---

## 11. 💡 Futuro (post-roadmap)

- Recontacto automático de candidatos dormant
- Scoring con IA
- Matching candidato ↔ job abierto
- Dashboard de recruiting metrics

---

## 12. ⚠️ Riesgos

- **Datos inconsistentes** en Teamtailor (campos vacíos, formatos variados)
- **Evaluaciones no estructuradas** → parsing débil en fase 1
- **CVs diversos** (formato, idioma, calidad)
- **Rate limits** de Teamtailor en sync inicial (full backfill)
- **Sesgo en embeddings** si el corpus histórico está sesgado

---

## 13. 🧩 Conclusión

Este sistema transforma:

> "base de CVs"
> →
> **motor de decisiones de hiring basado en datos**

Ventajas:

- Bajo costo operativo
- Stack simple (un solo proveedor de DB)
- Altamente escalable
- Dueño de los datos (no dependencia de features del ATS)
