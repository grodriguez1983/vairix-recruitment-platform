# ADR-008 — Chronicle MCP para memoria persistente del equipo

- **Estado**: Aceptado
- **Fecha**: 2026-04-17
- **Decisores**: Equipo interno
- **Relacionado con**: ADR-001..007 (Chronicle referencia a todos como
  memorias Core), `docs/operation-classification.md`,
  `docs/runbooks/install-chronicle-mcp.md`, `.mcp.json`

---

## Contexto

El scaffolding existente (`CLAUDE.md`, ADRs, skills, hooks, runbooks)
resuelve el problema del _stateless reader_ del paper _Generative
Specification_ en el **nivel estructural**: toda decisión
arquitectónica o regla inviolable está escrita, versionada, y es
legible por un agente sin contexto previo.

Lo que **no** está cubierto por ese scaffolding:

1. **Gotchas de runtime**: librerías con comportamiento raro, quirks
   de Teamtailor descubiertos en el ETL, incidentes de sistema
   operativo (ej: Finder de macOS filtrando dotfiles al
   descomprimir).
2. **Preferencias transversales del equipo**: `pnpm` vs npm, scopes
   válidos de Conventional Commits, estilo de naming, etc.
3. **Procedural memory**: comandos y receipts que se usan
   repetidamente (regenerar tipos tras migración, chmod tras
   unzip, etc.).
4. **Triggers contextuales** sobre palabras clave sensibles
   (`backfill`, `DROP TABLE`, `git push --force`) alineados con
   `docs/operation-classification.md`.
5. **Session recovery**: si Claude Code crashea o el usuario cierra
   la sesión, no hay forma de recuperar contexto más allá de `git
log` + `status.md`.

Documentar cada gotcha como ADR es **granularidad incorrecta** — los
ADRs están para decisiones estables. Documentarlos a mano en un wiki
externo es alta fricción y el agente no los accede automáticamente.

---

## Decisión

Adoptar [Chronicle MCP](https://github.com/jghiringhelli/chronicle-mcp)
como capa de memoria persistente del equipo, **complementaria** (no
reemplazo) al scaffolding existente.

### 1. Setup de dos niveles

- **User-level**: `~/.chronicle/config.json` con `userId`,
  `deviceId`, `dbPath`. No se versiona (user-specific).
- **Project-level**: entrada `chronicle` en `.mcp.json` del repo,
  con `${HOME}` expandido en runtime para portabilidad entre
  máquinas del equipo.

### 2. Storage

- **Primary**: SQLite local en `~/.chronicle/chronicle.db`.
- **Cross-PC sync (Railway Postgres)**: **NO activar en Fase 1**.
  Cualquier sincronización a infra externa implica potencialmente
  enviar referencias a PII de candidatos fuera del perímetro local
  y requiere ADR dedicado.

### 3. Política de triaje — qué va a Chronicle y qué no

| Tipo de conocimiento                | Destino                   |
| ----------------------------------- | ------------------------- |
| Decisión arquitectónica estructural | ADR                       |
| Término de dominio                  | `docs/domain-glossary.md` |
| Caso de uso / feature               | `docs/spec.md`            |
| Gotcha de runtime (lib, TT, OS)     | Chronicle (Semantic)      |
| Preferencia de código/tooling       | Chronicle (Preference)    |
| Procedimiento conocido (comandos)   | Chronicle (Procedural)    |
| "Cómo hicimos X" (histórico)        | Chronicle (Episodic)      |

**Regla de promoción**: si un item de Chronicle se consulta
repetidamente y cruza el umbral "esto debería ser regla formal",
se abre ADR. Chronicle funciona de facto como _inbox_ de futuros
ADRs.

### 4. Seeds iniciales

Seed de 15 memorias en el primer setup (ver runbook Etapa 3):

- 7 Architectural (Core tier) — refs a ADR-001..007
- 3 Procedural (Core tier) — rate limit TT, chmod tras unzip,
  regen de tipos post-migración
- 2 Semantic (Buffer tier) — quirk de macOS Finder, ausencia de
  sandbox en TT
- 3 Preference (Working tier) — pnpm, Conventional Commits,
  TypeScript estricto

### 5. Triggers sobre operaciones sensibles

Tres triggers alineados con `docs/operation-classification.md`:

- **Tier 2** (backfill, full-resync, sync:full) → recordar runbook.
- **Tier 3** (DROP TABLE, TRUNCATE, `supabase db reset`,
  `git push --force`) → exigir `CLAUDE_ALLOW_DESTRUCTIVE=1` y
  override humano; verificar target no-remoto.
- **Deploy / merge a main** → pre-deploy checklist.

### 6. Revisión periódica

Review mensual del tier Core de Chronicle. Para cada item:

- ¿Debería ser ADR? → abrirlo, mantener la memoria como referencia.
- ¿Sigue vigente? → si no, `forget`.
- ¿Se promovió correctamente de Buffer/Working → Core? → validar.

---

## Alternativas consideradas

### A) Todo en ADRs

- **Pros**: un único lugar, versionado, searchable con grep.
- **Contras**: granularidad incorrecta; los ADRs son decisiones
  estables, los gotchas de runtime cambian con el ecosistema.
  Crecería la carpeta `docs/adr/` con ruido de bajo valor.
- **Descartada**.

### B) Status quo — sin memoria persistente

- **Pros**: cero dependencias nuevas.
- **Contras**: cada sesión de Claude Code re-descubre los mismos
  quirks. Especialmente costoso en Fase 1 mientras se levanta el
  ETL contra Teamtailor (ecosistema con muchos tropiezos
  conocidos).
- **Descartada**.

### C) Wiki externo (Notion, Confluence, etc.)

- **Pros**: UI humana, búsqueda rica.
- **Contras**: el agente no accede automáticamente, no hay
  `session_start`, no hay triggers. Alta fricción de escritura.
- **Descartada**.

### D) ForgeCraft + CodeSeeker (mismo autor del paper)

- **Pros**: del mismo ecosistema conceptual del paper.
- **Contras**: ForgeCraft es redundante con el scaffolding
  artesanal existente; CodeSeeker es menos útil en greenfield.
- **Postergada** (no descartada). CodeSeeker es candidato natural
  para Fase 2+ cuando el codebase crezca.

---

## Consecuencias

### Positivas

- **Session recovery** tras crashes de Claude Code.
- **Triggers automáticos** sobre palabras clave de ops sensibles,
  alineados con `operation-classification.md` sin duplicar la
  lógica allá.
- **Memoria cross-session y cross-project**: si el dev trabaja en
  múltiples repos del equipo, las preferences se reutilizan.
- **Con `teamId`** (opt-in futuro): memoria compartida real del
  equipo.
- El scaffolding queda más limpio: los ADRs no se ensucian con
  gotchas tácticos.

### Negativas

- **Dependencia externa adicional** (SQLite local; opcional Postgres
  si se activa Railway).
- **Riesgo de "wiki paralelo"**: si la política de triaje se
  relaja, Chronicle se llena de cosas que deberían ser ADRs.
  Mitigación: review mensual del tier Core.
- **Si se activa Railway sync**: PII potencialmente cruzando
  perímetro. Mitigación: no activar sin ADR específico.
- **Acoplamiento al workflow**: si Chronicle se vuelve crítico, un
  bug en `chronicle-mcp` o en su DB degrada la productividad.
  Mitigación: SQLite es backup-friendly (un solo archivo);
  documentar procedimiento de backup si llega a ser crítico.

---

## Criterios de reevaluación

- **Si > 20% de memories en Core tier deberían haber sido ADRs**:
  revisar la política de triaje (señal de que estamos abusando
  Chronicle como wiki).
- **Si aparece requerimiento de compliance real (GDPR, SOC2)**:
  reevaluar cualquier decisión de sync externo; definir data
  retention en la DB local.
- **Si Chronicle se vuelve dependencia crítica del workflow**
  (Claude Code no puede arrancar sin él): documentar procedimiento
  de backup de `chronicle.db` y plan de contingencia en un runbook.
- **Si el equipo crece más allá de 5 personas**: reevaluar la
  conveniencia de activar Railway sync con `teamId` para
  coherencia de memoria entre todos.

---

## Notas de implementación

Ver runbook operativo completo en
`docs/runbooks/install-chronicle-mcp.md`. Incluye setup paso a paso,
plantillas de seeds, comandos de validación, y sección de
_Lecciones aprendidas_ que se actualiza con cada ejecución.
