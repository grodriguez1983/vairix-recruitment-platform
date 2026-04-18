#!/usr/bin/env bash
# ===========================================================
# chronicle-triggers.sh — mirror local de los triggers de Chronicle.
#
# Diseño: Chronicle MCP no se puede llamar desde un bash hook (es tool
# del lado de Claude). Pero los hooks SÍ ven cada prompt/bash antes de
# ejecutarlo. Este archivo guarda el contenido literal de los triggers
# críticos para que el hook los emita aunque Claude no llame a chronicle.
#
# Convención: cualquier cambio en un trigger se hace en DOS lugares:
#   1. `mcp__chronicle__chronicle action=trigger` (fuente semántica).
#   2. Este archivo (fuente del safety-net determinístico).
#
# Esta redundancia es intencional (ver docs/status.md y CLAUDE.md §
# "Persistencia (3 capas)"). Si divergen, gana el comportamiento del
# hook porque es lo que realmente frena la operación.
# ===========================================================
set -u

# Emite el contenido de un trigger con formato prominente.
# Uso: chronicle_emit "<keyword>" "<severity>" "<mensaje>"
chronicle_emit() {
  local keyword="$1"
  local severity="$2"
  local msg="$3"
  local icon="⚠️"
  case "$severity" in
    critical) icon="🚫" ;;
    warning)  icon="⚠️" ;;
    info)     icon="ℹ️" ;;
  esac
  cat >&2 <<EOF

${icon}  CHRONICLE TRIGGER: ${keyword} (${severity})
${msg}

    (Este trigger también está en Chronicle MCP — llamá
    mcp__chronicle__chronicle action=check trigger_action=${keyword}
    para registrar el hit y obtener contexto relacionado.)

EOF
}

# ---- Keywords que disparan el trigger google-drive ----
# Match case-insensitive sobre prompts o bash commands.
chronicle_match_google_drive() {
  local text_lower="$1"
  [[ "$text_lower" == *"google drive"*    ]] && return 0
  [[ "$text_lower" == *"google docs"*     ]] && return 0
  [[ "$text_lower" == *"google sheets"*   ]] && return 0
  [[ "$text_lower" == *"integracion con google"* ]] && return 0
  [[ "$text_lower" == *"integración con google"* ]] && return 0
  [[ "$text_lower" == *"gdrive"*          ]] && return 0
  [[ "$text_lower" == *"drive api"*       ]] && return 0
  [[ "$text_lower" == *"sheets api"*      ]] && return 0
  [[ "$text_lower" == *"googleapis.com"*  ]] && return 0
  return 1
}

chronicle_msg_google_drive() {
  cat <<'EOF'
STOP — la integración con Google Drive/Sheets está EXPLÍCITAMENTE DIFERIDA
por decisión del usuario (2026-04-18):

  "la integracion con google docs se va a hacer despues de terminar
   el resto de las cosas del roadmap"

NO arrancar: downloader de Sheets, auth OAuth a Google, service
accounts, descarga automática de planillas VAIRIX, npm i googleapis.

Enfoque actual: recruiter ve la URL del Sheet en /candidates/[id]
(sección "Planilla VAIRIX"), la descarga a mano, sube el xlsx cuando
F1-007 cree el bucket candidate-cvs. Filtro has_vairix_cv_sheet ya
cubre la búsqueda. Ver docs/roadmap.md §F1-006 y status.md.
EOF
}

# ---- Keywords que disparan el trigger backfill ----
chronicle_match_backfill() {
  local text_lower="$1"
  [[ "$text_lower" == *"backfill"*          ]] && return 0
  [[ "$text_lower" == *"full resync"*       ]] && return 0
  [[ "$text_lower" == *"full-resync"*       ]] && return 0
  [[ "$text_lower" == *"full sync"*         ]] && return 0
  [[ "$text_lower" == *"sync:full"*         ]] && return 0
  [[ "$text_lower" == *"workflow run backfill"* ]] && return 0
  return 1
}

chronicle_msg_backfill() {
  cat <<'EOF'
ANTES de correr backfill / full-resync contra Teamtailor en vivo,
checklist obligatorio:

  1. TEAMTAILOR_API_TOKEN rotado a least-privilege (read-only, sin
     escritura). La clave "Dev" inicial tenía Admin+RW — ver
     docs/runbooks/initial-backfill.md §pre-flight.
  2. Base URL correcta: https://api.na.teamtailor.com/v1 (tenant
     VAIRIX es NA). El global api.teamtailor.com devuelve 401
     idéntico a token inválido — NO hay pista de "wrong region".
  3. ETL_SKIP_EMBEDDINGS=1 si no querés disparar reindex masivo.
  4. Validar mapeo con muestras chicas ANTES del full (feedback
     persistente del usuario — ver memoria en auto-memory).
  5. sync_state, sync_errors y logs a mano para auditar.
EOF
}

# ---- Keywords que disparan el trigger push-main ----
chronicle_match_push_main() {
  local text_lower="$1"
  [[ "$text_lower" == *"git push origin main"* ]] && return 0
  [[ "$text_lower" == *"push -u origin main"*  ]] && return 0
  [[ "$text_lower" == *"push to main"*         ]] && return 0
  [[ "$text_lower" == *"push a main"*          ]] && return 0
  [[ "$text_lower" == *"merge to main"*        ]] && return 0
  [[ "$text_lower" == *"merge a main"*         ]] && return 0
  [[ "$text_lower" == *"gh pr merge"*          ]] && return 0
  return 1
}

chronicle_msg_push_main() {
  cat <<'EOF'
STOP — push/merge directo a main está prohibido sin autorización
explícita (CLAUDE.md §Operaciones prohibidas, docs/operation-classification.md).

Gate obligatorio antes de cualquier merge:
  ✅ pnpm typecheck limpio
  ✅ pnpm lint limpio
  ✅ pnpm test verde
  ✅ Si hubo migración: supabase db diff aplicado + tipos regenerados
  ✅ Si hubo decisión estructural: ADR creado en docs/adr/
  ✅ docs/status.md actualizado
  ✅ PR revisado (security-reviewer si toca auth/RLS/secrets)

Si igual querés mergear, el usuario tiene que autorizarlo de forma
explícita EN ESTA SESIÓN.
EOF
}

# ---- Runner ----
# Uso: chronicle_run_triggers "<texto>" (el texto a analizar; se
# convertirá a lowercase acá). Emite todos los triggers que matcheen.
chronicle_run_triggers() {
  local text="$1"
  local lower
  lower=$(echo "$text" | tr '[:upper:]' '[:lower:]')

  if chronicle_match_google_drive "$lower"; then
    chronicle_emit "google-drive" "warning" "$(chronicle_msg_google_drive)"
  fi
  if chronicle_match_backfill "$lower"; then
    chronicle_emit "backfill" "critical" "$(chronicle_msg_backfill)"
  fi
  if chronicle_match_push_main "$lower"; then
    chronicle_emit "push-main" "critical" "$(chronicle_msg_push_main)"
  fi
}
