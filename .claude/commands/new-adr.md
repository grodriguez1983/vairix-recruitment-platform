---
name: new-adr
description: Crea un nuevo ADR desde el template, con siguiente número disponible y frontmatter prellenado.
---

# /new-adr

Creá un ADR nuevo siguiendo `docs/adr/adr-000-template.md`.

## Flujo

1. Listá los ADRs existentes:
   ```bash
   ls docs/adr/adr-*.md | sort
   ```
2. Identificá el próximo número (el mayor + 1, padeado a 3 dígitos).
3. Preguntale al usuario por:
   - Título corto (imperativo, en inglés, ej: "adopt-redis-for-bucket").
   - Contexto breve (por qué estamos pensando esto ahora).
4. Copiá `docs/adr/adr-000-template.md` a
   `docs/adr/adr-NNN-<título-kebab>.md`.
5. Prellenar:
   - Estado: `Propuesto`
   - Fecha: hoy
   - Decisores: "Equipo interno"
   - Contexto: la explicación que te dio el usuario.
6. Dejá el resto (Decisión, Alternativas, Consecuencias) vacío
   para que el usuario lo complete.
7. **No commitees todavía.** El usuario revisa y ajusta. Cuando
   esté listo, commit:
   ```
   docs(adr): add ADR-NNN <título>
   ```
8. Actualizá `README.md` del Project Knowledge si tenemos una
   sección de "ADRs resueltos" (por ahora está en
   `docs/README.md`).

## Qué NO hacer

- ❌ Marcar un ADR como `Aceptado` sin que el usuario lo apruebe.
- ❌ Inventar alternativas que el usuario no mencionó.
- ❌ Sobrescribir un ADR existente.
- ❌ Saltar un número (NNN debe ser consecutivo).

## Recordatorio

Si la decisión invalida algo de `spec.md` o de un ADR previo,
**marcarlo**:
- Nuevo ADR: sección "Supersedes: ADR-XXX".
- ADR viejo: cambiar estado a `Superseded by ADR-NNN`.
- Update de `spec.md` si aplica.
