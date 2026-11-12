#!/usr/bin/env bash
#
# Release what a settled agent worktree no longer needs:
#   - stop this worktree's dev server
#   - delete the local databases, which `bun run seed` (or prepare-sample/full) rebuilds
#   - restore the .no-local-db guard so a resumed thread fails loudly instead of
#     opening a fresh empty ./timeline.db
#
# Idempotent — styal can run it more than once per worktree.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"

main_worktree=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
if [ "$main_worktree" = "$repo_root" ]; then
  echo "Refusing to settle the main clone at $repo_root" >&2
  exit 1
fi

bun run dev:stop || echo "!!  could not stop the dev server; continuing"

for db in timeline.db app-state.db embeddings.db; do
  rm -f "$db" "$db-wal" "$db-shm"
done
touch .no-local-db

echo "Removed local databases. Run 'bun run seed' to rebuild them."
