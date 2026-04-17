#!/usr/bin/env bash
# ===========================================================
# pre-tool-use hook — gate de la propiedad Defended (paper §4.3)
#
# Recibe por stdin un JSON con el tool y sus parámetros.
# Bloquea (exit 2) operaciones Tier 2/3 sin flag explícita.
# Ver docs/operation-classification.md.
# ===========================================================
set -u

# Leer input JSON completo
input=$(cat)

# Extraer campos relevantes (usando jq si está disponible, fallback a grep)
if command -v jq >/dev/null 2>&1; then
  tool_name=$(echo "$input" | jq -r '.tool_name // empty')
  command=$(echo "$input" | jq -r '.tool_input.command // empty')
else
  tool_name=$(echo "$input" | grep -o '"tool_name"[^,]*' | cut -d'"' -f4)
  command=$(echo "$input" | grep -o '"command"[^,]*' | cut -d'"' -f4)
fi

# Solo nos importan comandos Bash
[[ "$tool_name" != "Bash" ]] && exit 0

# Si el override está activo, dejar pasar (uso solo local y explícito)
if [[ "${CLAUDE_ALLOW_DESTRUCTIVE:-}" == "1" ]]; then
  echo "⚠️  CLAUDE_ALLOW_DESTRUCTIVE=1 — operación permitida bajo responsabilidad del operador" >&2
  exit 0
fi

block() {
  local reason="$1"
  cat >&2 <<EOF
🚫 BLOCKED by pre-tool-use hook

Operación: ${command}
Razón: ${reason}

Ver docs/operation-classification.md para cómo proceder.
Si es legítima, ejecutar con CLAUDE_ALLOW_DESTRUCTIVE=1 prefix.
EOF
  exit 2
}

# ---- Patrones Tier 3 (irreversibles) ----

if [[ "$command" =~ DROP[[:space:]]+TABLE ]]; then
  block "DROP TABLE detectado. Tier 3 — irreversible."
fi

if [[ "$command" =~ TRUNCATE[[:space:]] ]]; then
  block "TRUNCATE detectado. Tier 3 — irreversible."
fi

# DELETE sin WHERE específico (teamtailor_id = ... o id = ...)
if [[ "$command" =~ DELETE[[:space:]]+FROM ]]; then
  if ! [[ "$command" =~ WHERE[[:space:]]+(id|teamtailor_id)[[:space:]]*= ]]; then
    block "DELETE FROM sin WHERE específico. Tier 2/3."
  fi
fi

# git push --force a main
if [[ "$command" =~ git[[:space:]]+push[[:space:]]+(-f|--force) ]]; then
  if [[ "$command" =~ main|master ]]; then
    block "git push --force a main detectado. Tier 3."
  fi
fi

# git push directo a main
if [[ "$command" =~ git[[:space:]]+push[[:space:]]+origin[[:space:]]+main ]]; then
  block "Push directo a main. Se requiere PR."
fi

# supabase db reset contra url no-local
if [[ "$command" =~ supabase[[:space:]]+db[[:space:]]+reset ]]; then
  if [[ "$command" =~ --linked|--db-url ]]; then
    if ! [[ "$command" =~ localhost ]]; then
      block "supabase db reset contra target no-local. Tier 3."
    fi
  fi
fi

# rm -rf sobre paths sensibles
if [[ "$command" =~ rm[[:space:]]+-rf ]]; then
  if [[ "$command" =~ (supabase/migrations|\.git|docs|src|\ /\ ) ]]; then
    block "rm -rf sobre path sensible."
  fi
fi

# ---- Patrones Tier 2 (hard-to-recover) — log pero no bloquea ----

if [[ "$command" =~ (pnpm[[:space:]]+sync:full|reindex|gh[[:space:]]+workflow[[:space:]]+run[[:space:]]+backfill) ]]; then
  echo "⚠️  Operación Tier 2 detectada: ${command}" >&2
  echo "    Verificá que exista un humano supervisando y que haya runbook." >&2
  # No bloquea (las permisisons ask la van a gatear igual).
fi

exit 0
