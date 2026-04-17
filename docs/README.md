# 📚 Knowledge Base — Recruitment Data Platform

Estos archivos están pensados para subir al **Project Knowledge** de
claude.ai del proyecto `Recruitment Data Platform`.

## Orden de carga sugerido

1. `spec.md` — fuente canónica. **Subir primero.**
2. `domain-glossary.md` — glosario del dominio.
3. `teamtailor-api-notes.md` — notas de la API externa.
4. `data-model.md` — schema SQL completo.
5. `claude-code-conventions.md` — convenciones del repo.
6. `ui-style-guide.md` — guía de estilos visual (derivada de VAIRIX).
7. `adr/adr-001-supabase-and-pgvector.md`
8. `adr/adr-002-sync-strategy.md`
9. `adr/adr-003-auth-roles-rls.md`
10. `adr/adr-004-etl-orchestration.md`
11. `adr/adr-005-embeddings-pipeline.md`
12. `adr/adr-006-cv-storage-and-parsing.md`
13. `adr/adr-007-rejection-reasons-normalization.md`

## Cómo mantener esta base

- Cada nueva decisión arquitectónica → nuevo ADR en `adr/`.
- Cambios de schema → actualizar `data-model.md` **y** crear migración.
- Cuando encuentren un quirk de Teamtailor → agregar a la sección 7 de
  `teamtailor-api-notes.md`.
- Si un término nuevo aparece repetido → agregarlo a `domain-glossary.md`.

## Qué NO subir al Project

- `.env` o secrets.
- Dumps de datos reales (PII de candidatos).
- Código fuente del repo (eso lo ve Claude Code, no el Project).

## Estado de decisiones

### Resueltas (con ADR)

- ✅ Stack de datos → ADR-001
- ✅ Estrategia de sync → ADR-002
- ✅ Auth, roles y RLS → ADR-003
- ✅ Orquestación del ETL → ADR-004
- ✅ Embeddings pipeline → ADR-005
- ✅ CV storage y parsing → ADR-006
- ✅ Normalización de rejection reasons → ADR-007

### Pendientes (backlog de ADRs)

- ⏳ Data retention / PII (no urgente, uso interno sin GDPR formal)
- ⏳ Multilingüismo y full-text search avanzado
- ⏳ Observabilidad y métricas (Fase 2)
- ⏳ Estrategia de testing del ETL (Fase 1, agregar runbook)
- ⏳ LLM provider para RAG (Fase 4)
- ⏳ Upgrade de rejection normalization a LLM (criterio en ADR-007)

### Bloqueos externos

- ⏳ Lista de custom fields de Teamtailor (pendiente de acceso)
- ⏳ Creación de tenant de staging en Teamtailor (no existe, crear)
