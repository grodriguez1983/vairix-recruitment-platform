---
name: cascade-check
description: Ejecuta un cascade-closure check (paper §6.4) — invoca el subagent spec-guardian y sintetiza su output con acciones concretas. Usar antes de cortar un release, tras mergear un PR grande, o cuando sospechás drift.
---

# /cascade-check

Verificá que la cascade del spec esté cerrada (paper §6.4):
cualquier cambio reciente se propagó arriba y abajo de forma
consistente.

## Flujo

1. **Invocar el subagent `spec-guardian`** con scope:
   - Los últimos 7 días de commits, o
   - El diff completo del branch actual vs `main`.

2. Leer el reporte del spec-guardian.

3. Filtrar y clasificar por severidad:
   - 🚨 Major gaps
   - ⚠️ Minor drift
   - 🧹 Housekeeping

4. Para cada 🚨 Major:
   - Proponer un fix concreto.
   - Estimar esfuerzo (trivial / medium / big).
   - Si es big, proponer un roadmap item nuevo.

5. Para ⚠️ Minor:
   - Proponer agregarlos a `docs/status.md` como "drift detectado".

6. Para 🧹 Housekeeping:
   - Agrupar y proponer un PR separado.

## Output al usuario

```markdown
# Cascade check — <date>

## Resumen
- 🚨 N major gaps
- ⚠️ N minor drifts
- 🧹 N housekeeping items

## Acciones propuestas

### Ahora (bloquea release)
1. ...

### Esta semana
1. ...

### Housekeeping (PR chico aparte)
1. ...

## Roadmap items nuevos sugeridos
- F2-00X — ...
```

## Recordatorios

- **No aplicar fixes sin aprobación** del usuario. El command
  propone, no ejecuta.
- Si el reporte del spec-guardian señala inconsistencias en
  **este documento** o en otras convenciones, actualizarlo acá
  también.
- Si detectás que una decisión repetida no tiene ADR, proponer
  crearlo con `/new-adr`.
