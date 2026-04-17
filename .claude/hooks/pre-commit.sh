#!/usr/bin/env bash
# ===========================================================
# pre-commit hook — gate de Verifiable (paper §4.3).
# Corre antes de cada commit. Bloquea si algo no pasa.
# Instalar vía husky:
#   pnpm dlx husky add .husky/pre-commit 'bash .claude/hooks/pre-commit.sh'
# ===========================================================
set -euo pipefail

echo "🔎 pre-commit checks..."

# 1. Archivos staged
staged=$(git diff --cached --name-only --diff-filter=ACMR)
if [[ -z "$staged" ]]; then
  echo "   nada staged, salgo."
  exit 0
fi

# 2. Detectar secretos obvios
if echo "$staged" | grep -qE '\.env($|\.)' | grep -v '\.env\.example'; then
  echo "❌ hay un .env staged. Remover con: git reset HEAD .env*"
  exit 1
fi

if echo "$staged" | xargs grep -lE '(SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY|TEAMTAILOR_API_TOKEN)\s*=\s*[^${]' 2>/dev/null | grep -v '\.env\.example'; then
  echo "❌ secret literal detectado en archivos staged. Reemplazar por env var."
  exit 1
fi

# 3. Lint + format sobre archivos staged
if command -v pnpm >/dev/null 2>&1; then
  echo "   ▸ lint-staged..."
  pnpm lint-staged

  # 4. Typecheck completo (es rápido si ya está cacheado)
  echo "   ▸ typecheck..."
  pnpm typecheck

  # 5. Tests de los archivos que se tocaron (si existen test relacionados)
  echo "   ▸ tests (changed)..."
  if ! pnpm test --run --changed --passWithNoTests 2>&1; then
    echo "❌ tests fallaron. Arreglar antes de commitear."
    exit 1
  fi
else
  echo "⚠️  pnpm no disponible; skip checks automáticos."
fi

# 6. Verificar que si hay migración nueva, los tipos TS estén regenerados
migration_changes=$(echo "$staged" | grep -E '^supabase/migrations/.*\.sql$' || true)
if [[ -n "$migration_changes" ]]; then
  types_staged=$(echo "$staged" | grep -E '^src/types/database\.ts$' || true)
  if [[ -z "$types_staged" ]]; then
    cat >&2 <<EOF
❌ Hay migración staged pero src/types/database.ts no está staged.

   Corré:
     pnpm supabase:types
     git add src/types/database.ts

   Y commiteá de nuevo.
EOF
    exit 1
  fi
fi

echo "✅ pre-commit OK"
