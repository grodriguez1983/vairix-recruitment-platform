#!/usr/bin/env bash
# ===========================================================
# prompt-guard hook — se ejecuta al recibir cada user prompt.
#
# Dos funciones:
#   1. Inyectar recordatorio del sentinel cuando corresponde.
#   2. Detectar señales de que el usuario pide algo Tier 2+.
# ===========================================================
set -u

# Chronicle triggers mirror — dispara warnings deterministas sin
# depender de que Claude llame a mcp__chronicle__chronicle action=check.
# shellcheck disable=SC1091
source "$(dirname "$0")/chronicle-triggers.sh"

input=$(cat)

if command -v jq >/dev/null 2>&1; then
  user_prompt=$(echo "$input" | jq -r '.prompt // empty')
else
  user_prompt=$(echo "$input" | grep -oE '"prompt"[^}]*' | head -1)
fi

# Disparar cualquier chronicle trigger cuyo keyword aparezca en el prompt.
chronicle_run_triggers "$user_prompt"

# Señales de operaciones sensibles → recordatorio al usuario
sensitive_signals=(
  "drop table"
  "truncate"
  "delete from"
  "force push"
  "full resync"
  "backfill"
  "reset db"
  "disable rls"
  "service role"
  "bypass auth"
  "change embedding model"
)

lower=$(echo "$user_prompt" | tr '[:upper:]' '[:lower:]')
for signal in "${sensitive_signals[@]}"; do
  if [[ "$lower" == *"$signal"* ]]; then
    cat <<EOF
🧭 Nota para Claude Code:
    La solicitud contiene señales de operación sensible ("$signal").
    Antes de ejecutar, consultar docs/operation-classification.md,
    clasificar en tier (0/1/2/3), y pedir confirmación al usuario
    si corresponde.
EOF
    break
  fi
done

# Señales de trabajo estructural → inyectar recordatorio de sentinel
structural_signals=(
  "create a new"
  "refactor"
  "migrate"
  "add table"
  "add column"
  "new feature"
  "nuevo endpoint"
  "nuevo módulo"
  "change architecture"
  "cambiar arquitectura"
)

for signal in "${structural_signals[@]}"; do
  if [[ "$lower" == *"$signal"* ]]; then
    cat <<EOF
🧭 Recordatorio (prompt-guard):
    Esta es una tarea estructural. Antes de codear:
    1. Leer CLAUDE.md (sentinel).
    2. Leer docs/spec.md de la sección relevante.
    3. Leer los ADRs relacionados.
    4. Proponer plan breve al usuario antes de ejecutar cambios > 3 archivos.
    5. Si la decisión es no trivial → proponer ADR (/new-adr).
EOF
    break
  fi
done

exit 0
