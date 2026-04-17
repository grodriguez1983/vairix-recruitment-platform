#!/usr/bin/env bash
# ===========================================================
# bootstrap.sh — setup inicial y validación de paridad de env.
#
# Corre al clonar el repo para:
#   1. Verificar que las versiones de tooling coinciden.
#   2. Copiar .env.example a .env.local si no existe.
#   3. Validar que las variables requeridas están seteadas.
#   4. Verificar paridad entre .env.example, Vercel, Supabase,
#      y GitHub secrets (si las credenciales están disponibles).
#
# Uso:
#   bash scripts/bootstrap.sh              # chequeo local
#   bash scripts/bootstrap.sh --full        # incluye remotes
# ===========================================================
set -euo pipefail

FULL=false
if [[ "${1:-}" == "--full" ]]; then FULL=true; fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ok()   { echo "✅ $*"; }
warn() { echo "⚠️  $*"; }
fail() { echo "❌ $*" >&2; exit 1; }

# -----------------------------------------------------------
# 1. Tooling versions
# -----------------------------------------------------------

echo "▶ Checando tooling..."

if [[ -f .nvmrc ]]; then
  required_node=$(cat .nvmrc)
  actual_node=$(node -v 2>/dev/null | sed 's/v//; s/\..*//')
  if [[ "$actual_node" != "$required_node"* ]]; then
    warn "Node $actual_node ≠ requerido $required_node (ver .nvmrc)"
  else
    ok "Node $actual_node"
  fi
fi

if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm -v)"
else
  fail "pnpm no instalado. npm i -g pnpm"
fi

if command -v supabase >/dev/null 2>&1; then
  ok "supabase $(supabase -v 2>/dev/null | head -1)"
else
  warn "supabase CLI no instalada. brew install supabase/tap/supabase"
fi

if command -v jq >/dev/null 2>&1; then
  ok "jq disponible"
else
  warn "jq no instalado (recomendado para hooks). brew install jq"
fi

# -----------------------------------------------------------
# 2. .env.local
# -----------------------------------------------------------

echo "▶ Checando .env..."

if [[ ! -f .env.example ]]; then
  fail ".env.example no existe. Esto es sospechoso."
fi

if [[ ! -f .env.local ]]; then
  warn ".env.local no existe — copiando desde .env.example"
  cp .env.example .env.local
  warn "Editá .env.local con tus credenciales antes de continuar."
fi

# -----------------------------------------------------------
# 3. Variables requeridas en .env.local
# -----------------------------------------------------------

echo "▶ Validando variables requeridas..."

required_vars=(
  NEXT_PUBLIC_SUPABASE_URL
  NEXT_PUBLIC_SUPABASE_ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY
  TEAMTAILOR_API_TOKEN
  TEAMTAILOR_API_VERSION
  OPENAI_API_KEY
  OPENAI_EMBEDDING_MODEL
  APP_ENV
)

missing=()
for var in "${required_vars[@]}"; do
  if ! grep -qE "^${var}=.+" .env.local 2>/dev/null; then
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  warn "Faltan en .env.local: ${missing[*]}"
  warn "Editá .env.local antes de correr el ETL."
else
  ok "Todas las variables requeridas están seteadas"
fi

# -----------------------------------------------------------
# 4. Paridad entre .env.example y remotes (solo --full)
# -----------------------------------------------------------

if $FULL; then
  echo "▶ Validando paridad de secrets en remotes..."

  # Extraer nombres de vars de .env.example (sin valores)
  example_vars=$(grep -oE '^[A-Z_][A-Z0-9_]*=' .env.example | sed 's/=$//')

  # 4a. Vercel
  if command -v vercel >/dev/null 2>&1; then
    vercel_vars=$(vercel env ls 2>/dev/null | awk '/^[A-Z_]+/ {print $1}' || true)
    for v in $example_vars; do
      # Skip vars que NO van a Vercel (ej: SUPABASE_ACCESS_TOKEN, CLAUDE_*)
      [[ "$v" =~ ^(SUPABASE_ACCESS_TOKEN|CLAUDE_|DRY_RUN) ]] && continue
      if ! grep -q "^$v$" <<< "$vercel_vars"; then
        warn "Vercel no tiene: $v"
      fi
    done
  else
    warn "Vercel CLI no disponible, skip check"
  fi

  # 4b. Supabase Edge Functions secrets
  if command -v supabase >/dev/null 2>&1; then
    supa_secrets=$(supabase secrets list 2>/dev/null | awk 'NR>2 {print $1}' || true)
    # Vars que Edge Functions necesitan (ETL, worker, parser)
    edge_vars=(
      TEAMTAILOR_API_TOKEN TEAMTAILOR_API_VERSION
      OPENAI_API_KEY OPENAI_EMBEDDING_MODEL
      SUPABASE_SERVICE_ROLE_KEY
    )
    for v in "${edge_vars[@]}"; do
      if ! grep -q "^$v$" <<< "$supa_secrets"; then
        warn "Supabase Edge secrets no tiene: $v"
      fi
    done
  fi

  # 4c. GitHub Actions secrets
  if command -v gh >/dev/null 2>&1; then
    gh_secrets=$(gh secret list 2>/dev/null | awk '{print $1}' || true)
    # Vars que GitHub Actions necesita (backfill, CI)
    gh_vars=(
      TEAMTAILOR_API_TOKEN TEAMTAILOR_API_VERSION
      SUPABASE_SERVICE_ROLE_KEY SUPABASE_PROJECT_REF
      SUPABASE_ACCESS_TOKEN
    )
    for v in "${gh_vars[@]}"; do
      if ! grep -q "^$v$" <<< "$gh_secrets"; then
        warn "GitHub secrets no tiene: $v"
      fi
    done
  fi
fi

# -----------------------------------------------------------
# 5. Git hooks instalados (husky)
# -----------------------------------------------------------

echo "▶ Checando git hooks..."

if [[ -d .husky ]] && [[ -f .husky/pre-commit ]]; then
  ok "husky hooks presentes"
else
  warn "husky no inicializado. Corré: pnpm prepare"
fi

# -----------------------------------------------------------
# 6. Supabase local status
# -----------------------------------------------------------

echo "▶ Checando Supabase local..."

if command -v supabase >/dev/null 2>&1; then
  if supabase status >/dev/null 2>&1; then
    ok "Supabase local arriba"
  else
    warn "Supabase local no arrancó. Corré: supabase start"
  fi
fi

echo
echo "✨ bootstrap finalizado."
echo
echo "Próximos pasos:"
echo "  1. Revisar warnings arriba."
echo "  2. Editar .env.local con credenciales reales."
echo "  3. pnpm install"
echo "  4. supabase start"
echo "  5. pnpm dev"
