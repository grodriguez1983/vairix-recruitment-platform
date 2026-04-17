# 📍 Status — Recruitment Data Platform

> Actualizado al final de **cada sesión** de Claude Code. Snapshot
> del estado; no es un registro histórico completo (para eso está
> el git log).

**Última actualización**: _(pendiente — primer commit)_
**Última sesión**: _(ninguna aún)_
**Fase activa**: **Fase 1 — Fundación**

---

## ✅ Completado

_(nada todavía)_

---

## 🏃 En progreso

_(nada todavía)_

---

## ⏳ Próximo (top 3 del roadmap)

1. **F1-001** — Bootstrap del repo.
2. **F1-002** — Supabase local + primera migración.
3. **F1-003** — Schema de dominio + RLS base.

Ver `docs/roadmap.md` para el plan completo con prompts.

---

## 🚫 Bloqueos

- ⏳ **Lista de custom fields de Teamtailor** (pendiente de acceso).
- ⏳ **Tenant de staging en Teamtailor** (no existe, hay que crear).
- ⏳ **Verificar `X-Api-Version` vigente** en docs oficiales antes
  de codear F1-004.

---

## ⚠️ Drift detectado entre docs

_(lista de inconsistencias encontradas y su plan de resolución)_

- ADR-002 lista orden de sync `jobs → candidates → …`; ADR-004 y
  `spec.md` dicen `stages → users → jobs → …`.
  **Plan**: actualizar ADR-002 con nota "orden actualizado en
  ADR-004" (pendiente F1-000).

---

## 📊 Health checks

- [ ] `pnpm typecheck` — _(no repo yet)_
- [ ] `pnpm lint` — _(no repo yet)_
- [ ] `pnpm test` — _(no repo yet)_
- [ ] Coverage global ≥ 80% — _(no repo yet)_

---

## 🔗 Notas volátiles

_(cosas que se van descubriendo y hay que validar — no arquitectura
formal, solo memoria de trabajo)_

- Revisar si `text-embedding-3-small` sigue siendo el último
  modelo "small" al momento de F3-001.
- Al arrancar F1-004, confirmar rate limit real contra tenant de
  prueba (la doc dice ~50 req/10s; verificar).

---

## Convención de entradas

Al cerrar una sesión, agregar una entrada en la sección correcta:

```
- **F1-003** ✅ done — 2026-04-18 — commit abc123
  - aplicadas 13 migraciones
  - 42 tests RLS verdes
  - tipos regenerados
  - nota: agregado índice extra sobre `evaluations.needs_review`
    que no estaba en data-model.md → PR al doc pendiente
```

Si quedó algo abierto, anotarlo explícitamente:

```
- **F1-005** 🏃 in progress — 2026-04-18 — commit def456
  - lock + stale timeout implementados
  - falta: tests de race condition entre dos runs
  - bloqueado por: decisión sobre advisory locks vs lock column
```
