#!/usr/bin/env bash
set -euo pipefail

# Check that this checkout's service upgrades a database written by a release.
#
# Seeds a synthetic database with the release's own code (a temporary worktree
# at its tag), then boots this checkout's service against a copy with
# smoke-service.sh, which runs initDb() and waits for a healthy /api/health.
# Afterwards the event count must be unchanged and every event type declared.
#
# Usage: ./scripts/smoke-upgrade.sh [vX.Y.Z]
# Without a tag, uses the latest published release (GitHub's latest release, via gh).
# Needs full history with tags, and `bun install` in this checkout.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# A fixed anchor keeps the seeded events identical from run to run.
ANCHOR="2026-01-31"

from="${1:-$(gh api 'repos/{owner}/{repo}/releases/latest' --jq .tag_name)}"
if [[ ! "$from" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "FAIL: not a stable release tag: '${from}'" >&2
  exit 1
fi
if ! git -C "$ROOT" merge-base --is-ancestor "$from" HEAD; then
  echo "FAIL: $from is not an ancestor of HEAD" >&2
  exit 1
fi

TMP="$(mktemp -d)"
OLD="$TMP/release"
DATA="$TMP/seed"
cleanup() {
  git -C "$ROOT" worktree remove --force "$OLD" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "Seeding with $from..."
git -C "$ROOT" worktree add --quiet --detach "$OLD" "$from"
(cd "$OLD" && bun install --frozen-lockfile > "$TMP/install.log" 2>&1) || {
  cat "$TMP/install.log"
  echo "FAIL: could not install $from dependencies" >&2
  exit 1
}
# The seed sees only these variables, so nothing in this shell or the real HOME
# can point it at real data.
bun_bin="$(bun -e 'process.stdout.write(process.execPath)')"
mkdir "$TMP/home"
(cd "$OLD" && env -i HOME="$TMP/home" PATH="$(dirname "$bun_bin"):/usr/bin:/bin" \
  "$bun_bin" --no-env-file run seed -- --anchor="$ANCHOR" --out="$DATA" > "$TMP/seed.log" 2>&1) || {
  cat "$TMP/seed.log"
  echo "FAIL: $from could not seed a database" >&2
  exit 1
}

# Prints "<events> <enabled sync sources>" for the databases in a directory.
# shellcheck disable=SC2016 # the TypeScript is for bun, not the shell
inspect() {
  (cd "$ROOT" && "$bun_bin" --no-env-file -e '
    import { Database } from "./src/db/sqlite";
    const directory = process.argv[1];
    const timeline = new Database(`${directory}/timeline.db`, { readonly: true });
    const appState = new Database(`${directory}/app-state.db`, { readonly: true });
    const events = timeline.query("SELECT count(*) AS n FROM events").get().n;
    const enabled = appState.query("SELECT count(*) AS n FROM sync_sources WHERE enabled != 0").get().n;
    console.log(`${events} ${enabled}`);
  ' "$1")
}

read -r events_before enabled_sources < <(inspect "$DATA")
# The scheduler runs during the boot; a seeded source must never reach a network service.
if [ "$enabled_sources" != 0 ]; then
  echo "FAIL: the $from seed enabled $enabled_sources sync sources" >&2
  exit 1
fi
echo "Seeded $events_before events with $from."

echo "Booting this checkout's service against a copy of the $from database..."
TIMELINE_SMOKE_SEED_DIR="$DATA" TIMELINE_SMOKE_SAVE_DIR="$TMP/upgraded" \
  BOOT_TIMEOUT_S="${BOOT_TIMEOUT_S:-120}" "$ROOT/scripts/smoke-service.sh"

read -r events_after _ < <(inspect "$TMP/upgraded")
if [ "$events_after" != "$events_before" ]; then
  echo "FAIL: the upgrade changed the event count from $events_before to $events_after" >&2
  exit 1
fi
(cd "$ROOT" && "$bun_bin" --no-env-file src/scripts/check-event-types.ts "$TMP/upgraded/timeline.db")
echo "OK: this checkout upgraded a $from database."
