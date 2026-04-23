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

# `.env.example` es un template safe y `.env.test` contiene las
# claves well-known que imprime `supabase start` (mismos literales
# que tests/rls/helpers.ts ya comitea). Ver ADR-019.
if echo "$staged" | xargs grep -lE '(SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY|TEAMTAILOR_API_TOKEN)\s*=\s*[^${]' 2>/dev/null | grep -vE '(\.env\.example|\.env\.test)$'; then
  echo "❌ secret literal detectado en archivos staged. Reemplazar por env var."
  exit 1
fi

# 2b. Detectar valores literales de claves Supabase por prefijo
# (nuevo modelo: sb_secret_..., sb_publishable_...)
if echo "$staged" | xargs grep -lE 'sb_secret_[A-Za-z0-9_-]{10,}' 2>/dev/null | grep -vE '(\.env\.example|\.env\.test)$'; then
  echo "❌ se detectó un valor literal sb_secret_... en archivos staged. NUNCA commitear secret keys."
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
  # TDD_RED=1 bypasea la gate para commits test: [RED] (ver
  # .claude/skills/tdd-workflow/SKILL.md). El hook commit-msg sigue
  # exigiendo que todo feat/fix [GREEN] tenga un [RED] previo, asi
  # que este escape no relaja la disciplina TDD.
  if [[ "${TDD_RED:-0}" == "1" ]]; then
    echo "   ▸ tests (changed)... SKIPPED (TDD_RED=1)"
  else
    echo "   ▸ tests (changed)..."
    if ! pnpm exec vitest run --changed --passWithNoTests 2>&1; then
      echo "❌ tests fallaron. Arreglar antes de commitear."
      echo "   Si es un commit TDD [RED] intencional, usa TDD_RED=1 git commit ..."
      exit 1
    fi
  fi
else
  echo "⚠️  pnpm no disponible; skip checks automáticos."
fi

# 6. Verificar que si hay migración nueva, los tipos TS estén regenerados
# La regla real es: el archivo de tipos en HEAD debe reflejar el schema vivo.
# Se acepta tanto (a) tipos staged con cambios, como (b) tipos ya en HEAD
# coincidiendo con la regeneración actual. Esto permite commits secuenciales
# de migraciones cuando los tipos fueron regenerados una sola vez al final
# de aplicar el lote.
migration_changes=$(echo "$staged" | grep -E '^supabase/migrations/.*\.sql$' || true)
if [[ -n "$migration_changes" ]]; then
  types_staged=$(echo "$staged" | grep -E '^src/types/database\.ts$' || true)
  if [[ -z "$types_staged" ]]; then
    # Caso (b): comparar generación actual vs archivo en disk.
    # Si coinciden, los tipos están al día — OK.
    if command -v pnpm >/dev/null 2>&1 && [[ -f src/types/database.ts ]]; then
      # Escribir a tempfile preserva trailing newlines (command substitution los
      # stripea y arruina el diff).
      tmpfile=$(mktemp)
      pnpm --silent exec supabase gen types typescript --local >"$tmpfile" 2>/dev/null || true
      if [[ -s "$tmpfile" ]] && diff -q "$tmpfile" src/types/database.ts >/dev/null 2>&1; then
        echo "   ℹ️  src/types/database.ts ya refleja el schema vivo (sin diff)."
        rm -f "$tmpfile"
      else
        rm -f "$tmpfile"
        cat >&2 <<EOF
❌ Hay migración staged pero src/types/database.ts no está al día.

   Corré:
     pnpm supabase:types
     git add src/types/database.ts

   Y commiteá de nuevo.
EOF
        exit 1
      fi
    fi
  fi
fi

echo "✅ pre-commit OK"
