# ADR-007 — Normalización de rejection reasons

- **Estado**: Aceptado
- **Fecha**: 2026-04-17
- **Decisores**: Equipo interno
- **Relacionado con**: `spec.md` §2.5 (insights), `data-model.md`,
  `domain-glossary.md`

---

## Contexto

`spec.md` §2.5 promete "motivos de rechazo más comunes" como insight
clave. `data-model.md` ya tiene `rejection_reason` (texto libre
sincronizado de Teamtailor) y `rejection_category` (normalizada),
pero nadie define **cómo** se llega de uno al otro.

Datos:

- Teamtailor permite motivos libres, distintos por tenant.
- Sin normalización, el dashboard de §2.5 no sirve: cada rechazo es
  un string único.
- Los custom fields de nuestro tenant todavía no están confirmados.

---

## Decisión

### 1. Catálogo semi-fijo

Tabla `rejection_categories` con ~10 categorías iniciales, editables
solo por admin:

| Código | Nombre humano |
|---|---|
| `technical_skills` | Nivel técnico insuficiente |
| `experience_level` | Seniority no encaja |
| `communication` | Comunicación |
| `culture_fit` | Cultural fit |
| `salary_expectations` | Expectativas salariales |
| `availability` | Disponibilidad horaria |
| `location` | Ubicación / time zone |
| `no_show` | No se presentó |
| `ghosting` | Dejó de responder |
| `position_filled` | Posición cubierta por otro |
| `other` | Otro (fallback) |

- El código es estable (no cambia).
- El nombre humano es editable.
- Admin puede agregar categorías nuevas; deprecar en vez de borrar
  (columna `deprecated_at`).

### 2. Normalización post-sync

Job separado (Edge Function) que corre **después del sync de
evaluations**:

1. Lee evaluations con `rejection_reason` no vacío y
   `rejection_category_id` null (o con `normalization_attempted_at`
   anterior a algún cutoff si cambió la lógica).
2. Aplica reglas de matching.
3. Si matchea → asigna `rejection_category_id`.
4. Si no matchea → asigna `other` y setea
   `needs_review = true`.
5. Update `normalization_attempted_at`.

### 3. Estrategia de matching (Fase 1: keywords)

Para cada categoría, un set de keywords y frases en ES y EN:

```
technical_skills:
  - "technical", "nivel técnico", "skills técnicas", "coding"
  - "algorithm", "algoritmo", "data structure"
  - "knowledge gap", "falta de conocimientos"

communication:
  - "communication", "comunicación", "inglés"
  - "hard to understand", "poco claro"

salary_expectations:
  - "salary", "expectativa salarial", "pretensión"
  - "out of budget", "fuera de presupuesto"
```

El matching es case-insensitive, sobre `rejection_reason` y
opcionalmente sobre `notes`. Reglas priorizadas (la primera que
matchea gana).

Las reglas viven en `src/lib/normalization/rejection-rules.ts`
versionadas en el repo. **No** en la DB en Fase 1.

### 4. Mapeo desde custom fields de Teamtailor

Si el tenant tiene un custom field estructurado tipo "Rejection
Reason" con valores controlados, se mapea directamente sin pasar
por keyword matching.

Este mapeo se configura en `rejection_field_mappings` (tabla) una
vez que tengamos acceso a los custom fields del tenant. Hasta
entonces, keyword matching es la única vía.

### 5. Review manual

El admin tiene una vista "Rejections por revisar" con:

- Evaluations marcadas `needs_review = true`.
- Campos editables: `rejection_category_id` y un botón "sugerir
  nueva categoría".

Al asignar manualmente, se puede opcionalmente agregar la frase
como keyword a la categoría (siembra futuras normalizaciones).

### 6. Upgrade a LLM (Fase 2+)

Si el volumen de `needs_review` supera un umbral (ej: > 30% de los
rechazos):

- Upgrade a clasificación vía LLM con few-shot prompt.
- Modelo candidato: `claude-haiku` o `gpt-4o-mini` por costo.
- Se mantiene el fallback a keyword matching por si el LLM está
  down.

Este upgrade se documenta en ADR nuevo cuando se active.

---

## Alternativas consideradas

### A) Solo texto libre, sin normalización
- **Pros**: cero trabajo.
- **Contras**: rompe el caso de uso de insights del spec §2.5.
- **Descartada**.

### B) Catálogo 100% rígido (enum en DB)
- **Pros**: integridad fuerte.
- **Contras**: agregar categoría requiere migración. En producto
  interno iterativo, demasiado rígido.
- **Descartada** a favor de tabla editable.

### C) LLM desde día uno
- **Pros**: mejor precisión, menos mantenimiento de keywords.
- **Contras**: costo, latencia, dependencia de proveedor LLM en el
  ETL. Para 5k evaluations, keyword matching alcanza.
- **Postergada** a Fase 2+.

### D) Pedirle al reclutador que elija la categoría cuando rechaza
- **Pros**: datos limpios en origen.
- **Contras**: no tenemos control sobre la UX de Teamtailor. La
  data viene como venga. No aplica.
- **Descartada por contexto**.

### E) Crowdsource: sugerir categoría en la UI y dejar al reclutador confirmar
- **Pros**: data se mejora con el tiempo.
- **Contras**: Fase 2+ feature.
- **Postergada**.

---

## Consecuencias

### Positivas
- Insights de §2.5 viables desde Fase 1.
- Costo nulo de operación (sin LLM calls).
- Iterable: agregar una categoría o keyword es un PR chico.
- Transparente: las reglas están en código, versionadas y testeables.

### Negativas
- Precisión de keyword matching es limitada. Esperable 60-75% de
  precisión inicial, mejorando con curation.
- Mantener las reglas es trabajo humano recurrente.
- El bucket `other` + `needs_review` puede crecer si nadie revisa.
  Mitigación: dashboard con métrica visible para admin.

---

## Criterios de reevaluación

- Si precisión medida < 60% tras 3 meses de uso: upgrade a LLM.
- Si >= 40% de rejections caen en `other`: revisar catálogo.
- Si el tenant de Teamtailor agrega custom field estructurado para
  rejection reason: preferir mapeo directo.
