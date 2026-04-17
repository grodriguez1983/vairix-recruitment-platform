#!/usr/bin/env bash
# ===========================================================
# commit-msg hook — valida Conventional Commits + TDD phase.
#
# Instalar vía husky:
#   pnpm dlx husky add .husky/commit-msg 'bash .claude/hooks/commit-msg.sh "$1"'
#
# Bloquea si:
#   - Subject no es Conventional Commit.
#   - feat: sin test: [RED] previo en el mismo scope (TDD gate).
#   - Commits vacíos (WIP, asdf, etc.)
# ===========================================================
set -u

msg_file="$1"
subject=$(head -n1 "$msg_file")

# 1. Subject no vacío y no trivial
if [[ -z "$subject" ]] || [[ "$subject" =~ ^(WIP|wip|asdf|test|fixme|todo)$ ]]; then
  cat >&2 <<EOF
❌ Commit subject inválido: "$subject"
   No se aceptan placeholders (WIP, asdf, test, etc.)
EOF
  exit 1
fi

# 2. Formato Conventional Commits
# Acepta: type(scope): subject | type: subject | type(scope): [RED]/[GREEN] subject
ccre='^(feat|fix|refactor|docs|test|chore|perf|build|ci|style|revert)(\(([a-z0-9-]+)\))?(!)?: (\[RED\]|\[GREEN\])? ?.+'
if ! [[ "$subject" =~ $ccre ]]; then
  cat >&2 <<EOF
❌ Subject no matchea Conventional Commits.

Subject actual: "$subject"

Formato esperado:
  type(scope): subject
  type(scope): [RED] subject     (para commits de test failing)
  type(scope): [GREEN] subject   (para commits de implementación)

Types válidos: feat, fix, refactor, docs, test, chore, perf, build, ci, style, revert.
Scopes sugeridos: etl, db, ui, rag, embeddings, teamtailor, sync, auth, cv, rls, infra.
EOF
  exit 1
fi

type="${BASH_REMATCH[1]}"
scope="${BASH_REMATCH[3]}"
phase="${BASH_REMATCH[5]}"  # [RED] o [GREEN] o vacío

# 3. TDD phase gate
# Si es feat:[GREEN] o fix:[GREEN], exigimos un test:[RED] previo
# con el mismo scope en los últimos 20 commits del branch.
#
# Excepción: commit body contiene "[tdd-skip: <razón>]"
if [[ "$phase" == "[GREEN]" ]] && [[ "$type" =~ ^(feat|fix)$ ]]; then
  body=$(sed -n '2,$p' "$msg_file")
  if ! [[ "$body" =~ \[tdd-skip: ]]; then
    # Buscar test: [RED] previo en el mismo scope
    if ! git log --since="7 days ago" --pretty='%s' 2>/dev/null | \
         head -20 | \
         grep -E "^test(\(${scope}\))?: \[RED\]" >/dev/null; then
      cat >&2 <<EOF
❌ TDD phase violation

Commit marcado [GREEN] (${type}(${scope})) pero no hay un
commit 'test(${scope}): [RED] ...' reciente en el branch.

Opciones:
  1. Commitear primero el test que falla:
     git commit -m 'test(${scope}): [RED] <descripción>'
  2. Si el skip es legítimo, agregar al body:
     [tdd-skip: <razón>]

Ver .claude/skills/tdd-workflow/SKILL.md
EOF
      exit 1
    fi
  fi
fi

# 4. Longitud del subject (recomendado, no bloqueante)
if [[ ${#subject} -gt 100 ]]; then
  echo "⚠️  Subject tiene ${#subject} caracteres (recomendado ≤ 72)." >&2
fi

exit 0
