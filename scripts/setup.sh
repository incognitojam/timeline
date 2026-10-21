#!/usr/bin/env bash
#
# Prepare a clone or agent worktree for development:
#   - copy the gitignored files listed in .worktreeinclude from the main clone
#   - link the shared imports directory
#   - activate the tracked Git hooks
#   - install dependencies (root + web/)
#   - prepare a local sample ./timeline.db
#
# Idempotent — safe to re-run: `bun run setup`.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

main_worktree=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
is_worktree=true
[ "$main_worktree" = "$repo_root" ] && is_worktree=false

warnings=()

step() { printf '\n==> %s\n' "$1"; }
warn() {
  printf '!!  %s\n' "$1"
  warnings[${#warnings[@]}]="$1"
}

step "Configuring Git hooks"
if git config --bool extensions.worktreeConfig >/dev/null 2>&1; then
  git config --worktree core.hooksPath .githooks
else
  git config --local core.hooksPath .githooks
fi
echo "    core.hooksPath = .githooks"

if [ "$is_worktree" = true ]; then
  step "Copying gitignored files from $main_worktree"
  while IFS= read -r entry; do
    case "$entry" in '' | '#'*) continue ;; esac
    if [ -e "$entry" ]; then
      echo "    kept existing $entry"
    elif [ -e "$main_worktree/$entry" ]; then
      mkdir -p "$(dirname "$entry")"
      cp "$main_worktree/$entry" "$entry"
      echo "    copied $entry"
    else
      warn "$entry is listed in .worktreeinclude but missing from $main_worktree"
    fi
  done < .worktreeinclude

  step "Linking ./imports"
  if [ -d imports ] && [ ! -L imports ]; then
    warn "./imports is a real directory — leaving it alone"
  elif [ -d "$main_worktree/imports" ]; then
    ln -sfn "$main_worktree/imports" imports
    echo "    imports -> $main_worktree/imports"
  else
    warn "no imports directory at $main_worktree/imports"
  fi
fi

# Guards writes until prepare-sample has produced ./timeline.db, which removes it.
[ -f timeline.db ] || touch .no-local-db

step "Installing dependencies and preparing ./timeline.db"
log_dir=$(mktemp -d "${TMPDIR:-/tmp}/timeline-setup.XXXXXX")
trap 'rm -rf "$log_dir"' EXIT

(bun install --frozen-lockfile && bun run prepare-sample) >"$log_dir/backend.log" 2>&1 &
backend_pid=$!
(cd web && bun install --frozen-lockfile) >"$log_dir/web.log" 2>&1 &
web_pid=$!

failed=0
for job in "backend:$backend_pid" "web:$web_pid"; do
  name=${job%%:*}
  if wait "${job##*:}"; then
    status=ok
  else
    status=FAILED
    failed=1
  fi
  printf '\n--- %s (%s) ---\n' "$name" "$status"
  cat "$log_dir/$name.log"
done

if [ ${#warnings[@]} -ne 0 ]; then
  printf '\n==> Warnings\n'
  for warning in "${warnings[@]}"; do
    printf '!!  %s\n' "$warning"
  done
fi

if [ "$failed" -ne 0 ]; then
  printf '\nSetup failed.\n' >&2
  exit 1
fi

printf '\nSetup complete.\n'
