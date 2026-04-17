#!/usr/bin/env bash
# ===========================================================
# post-edit hook — gate de la propiedad Bounded (paper §4.3)
#
# Tras Write o Edit, verifica que el archivo editado no exceda
# los límites de la spec (300 líneas max, salvo whitelist).
# ===========================================================
set -u

input=$(cat)

if command -v jq >/dev/null 2>&1; then
  file_path=$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty')
else
  file_path=$(echo "$input" | grep -oE '"(file_path|path)"[^,]*' | head -1 | cut -d'"' -f4)
fi

[[ -z "$file_path" ]] && exit 0
[[ ! -f "$file_path" ]] && exit 0

# Whitelist de archivos que pueden pasarse de 300 líneas:
#   - tipos auto-generados
#   - seeds con muchas filas
#   - lockfiles
#   - schemas dumpeados
whitelist_patterns=(
  "src/types/database.ts"
  "pnpm-lock.yaml"
  "package-lock.json"
  "supabase/migrations/*_seed_*.sql"
  "docs/adr/adr-*.md"
  "docs/roadmap.md"
  "docs/use-cases.md"
  "docs/data-model.md"
  "docs/ui-style-guide.md"
  "docs/spec.md"
  "docs/teamtailor-api-notes.md"
)

# Docs pueden ser más largos que código (son enumerativos, no navigables).
# El límite de 300 líneas es para código que el agente lee contextualmente.
# Documentos son lectura dirigida.

for pattern in "${whitelist_patterns[@]}"; do
  case "$file_path" in
    $pattern) exit 0 ;;
  esac
done

line_count=$(wc -l < "$file_path")
threshold=300

if [[ "$line_count" -gt "$threshold" ]]; then
  cat >&2 <<EOF
⚠️  BOUNDED VIOLATION — $file_path tiene $line_count líneas (máximo $threshold).

Ver CLAUDE.md §"Code Standards".
Propuestas:
  - Extraer sub-módulos en archivos separados.
  - Si es un archivo legítimamente grande (fixture, snapshot,
    tipo generado), agregarlo a la whitelist en post-edit.sh.

Este warning no bloquea la edición, pero debe resolverse antes
del próximo commit.
EOF
  # No bloqueamos (exit 1 rompería el flujo); solo warn.
fi

# Detectar console.log fuera de tests y scripts
if [[ "$file_path" =~ \.(ts|tsx)$ ]] && \
   [[ ! "$file_path" =~ \.test\. ]] && \
   [[ ! "$file_path" =~ /scripts/ ]]; then
  if grep -q 'console\.\(log\|debug\)' "$file_path"; then
    echo "⚠️  console.log detectado en $file_path — usar logger estructurado" >&2
  fi
fi

# Detectar `any` explícito
if [[ "$file_path" =~ \.(ts|tsx)$ ]] && \
   [[ ! "$file_path" =~ \.d\.ts$ ]] && \
   [[ ! "$file_path" =~ /src/types/database\.ts ]]; then
  # Buscar `: any` o `as any` pero ignorar comments
  if grep -nE '^[^/]*:\s*any\b|\bas\s+any\b' "$file_path" >/dev/null 2>&1; then
    echo "⚠️  uso de 'any' detectado en $file_path — preferir 'unknown' + narrowing" >&2
  fi
fi

exit 0
