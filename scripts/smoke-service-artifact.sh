#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
ARTIFACT="$TMP/timeline-service"
RUN_CWD="$TMP/run"

cleanup() {
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$RUN_CWD"
bun run "$ROOT/scripts/build-service-artifact.ts" --output "$ARTIFACT"

test -x "$ARTIFACT/bin/timeline-service"
test -x "$ARTIFACT/bin/bun"
test -r "$ARTIFACT/bin/timeline-environment"
grep -q 'NODE_ENV:=production' "$ARTIFACT/bin/timeline-environment"
grep -q '/opt/homebrew/bin:/usr/local/bin' "$ARTIFACT/bin/timeline-environment"
test -f "$ARTIFACT/Resources/runtime/service.js"
test -f "$ARTIFACT/Resources/runtime/scheduler/worker.js"
test -f "$ARTIFACT/Resources/runtime/db/pool-worker.js"
test -f "$ARTIFACT/Resources/runtime/parsers/monzo.js"
test -f "$ARTIFACT/Resources/web/index.html"
test -f "$ARTIFACT/Resources/version.json"
test ! -e "$ARTIFACT/.git"

artifact_link="$(find "$ARTIFACT" -type l -print -quit)"
if [ -n "$artifact_link" ]; then
  echo "FAIL: artifact contains a symlink: $artifact_link" >&2
  exit 1
fi

echo "Probing packaged env-file semantics..."
ENV_HOME="$TMP/env-home"
mkdir -p "$ENV_HOME"
cat > "$TMP/expanded.env" <<'EOF'
TIMELINE_TEST_EXPANDED="$HOME/expanded"
PATH="$HOME/custom/bin"
EOF
env_output="$(
  HOME="$ENV_HOME" \
  PATH="/usr/bin:/bin" \
  TIMELINE_ENV_FILE="$TMP/expanded.env" \
    /bin/bash -c '
      source "$1"
      printf "expanded=%s\npath=%s\nloaded=%s\nnode=%s\n" \
        "$TIMELINE_TEST_EXPANDED" "$PATH" "$TIMELINE_ENV_FILE_LOADED" "$NODE_ENV"
    ' bash "$ARTIFACT/bin/timeline-environment"
)"
[[ "$env_output" == *"expanded=$ENV_HOME/expanded"* ]]
[[ "$env_output" == *"path=$ENV_HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$ENV_HOME/custom/bin"* ]]
[[ "$env_output" == *"loaded=1"* ]]
[[ "$env_output" == *"node=production"* ]]

if env_path_output="$(
  HOME="$ENV_HOME" TIMELINE_ENV_FILE="relative.env" \
    "$ARTIFACT/bin/timeline-service" --check-config 2>&1
)"; then
  echo "FAIL: packaged service accepted a relative env-file path" >&2
  exit 1
fi
if [[ "$env_path_output" != *"TIMELINE_ENV_FILE must be an absolute path"* ]]; then
  echo "FAIL: relative env-file path did not produce migration guidance" >&2
  echo "$env_path_output" >&2
  exit 1
fi

cat > "$ENV_HOME/config.toml" <<EOF
[database]
path = "$ENV_HOME/timeline.db"

[inbox]
watch_enabled = false
base_path = "$ENV_HOME/inbox"

[media]
path = "$ENV_HOME/media"
EOF
cat > "$TMP/config.env" <<'EOF'
if [ -n "$HOME" ]; then
  TIMELINE_CONFIG="$HOME/config.toml"
fi
AUTH_PASSWORD=smoke-test-password
EOF
HOME="$ENV_HOME" TIMELINE_ENV_FILE="$TMP/config.env" \
  "$ARTIFACT/bin/timeline-service" --check-config

grep -v AUTH_PASSWORD "$TMP/config.env" > "$TMP/no-password.env"
if password_output="$(
  HOME="$ENV_HOME" TIMELINE_ENV_FILE="$TMP/no-password.env" \
    "$ARTIFACT/bin/timeline-service" --check-config 2>&1
)"; then
  echo "FAIL: packaged service accepted a missing AUTH_PASSWORD" >&2
  exit 1
fi
if [[ "$password_output" != *"AUTH_PASSWORD must be set outside development"* ]]; then
  echo "FAIL: missing AUTH_PASSWORD did not explain the requirement" >&2
  echo "$password_output" >&2
  exit 1
fi

cat > "$TMP/missing-config.env" <<'EOF'
TIMELINE_CONFIG="$HOME/missing.toml"
EOF
if missing_config_output="$(
  HOME="$ENV_HOME" TIMELINE_ENV_FILE="$TMP/missing-config.env" \
    "$ARTIFACT/bin/timeline-service" --check-config 2>&1
)"; then
  echo "FAIL: packaged preflight accepted a missing explicit config" >&2
  exit 1
fi
if [[ "$missing_config_output" != *"TIMELINE_CONFIG does not exist"* ]]; then
  echo "FAIL: missing explicit config silently fell back" >&2
  echo "$missing_config_output" >&2
  exit 1
fi

if empty_config_output="$(
  HOME="$ENV_HOME" TIMELINE_ENV_FILE="$TMP/missing.env" TIMELINE_CONFIG="" \
    "$ARTIFACT/bin/timeline-service" --check-config 2>&1
)"; then
  echo "FAIL: packaged preflight accepted an empty explicit config" >&2
  exit 1
fi
if [[ "$empty_config_output" != *"TIMELINE_CONFIG must be an absolute path"* ]]; then
  echo "FAIL: empty explicit config silently fell back" >&2
  echo "$empty_config_output" >&2
  exit 1
fi

"$ARTIFACT/bin/bun" --no-env-file -e '
  import { Database } from "bun:sqlite";
  const db = new Database(process.argv[1]);
  db.exec("CREATE TABLE sync_sources (source TEXT PRIMARY KEY, settings TEXT NOT NULL)");
  db.prepare("INSERT INTO sync_sources VALUES (?, ?)").run(
    "backup",
    JSON.stringify({ destination: "./backups" }),
  );
  db.close();
' "$ENV_HOME/app-state.db"
if sync_path_output="$(
  HOME="$ENV_HOME" TIMELINE_ENV_FILE="$TMP/config.env" \
    "$ARTIFACT/bin/timeline-service" --check-config 2>&1
)"; then
  echo "FAIL: packaged preflight accepted a relative stored sync path" >&2
  exit 1
fi
if [[ "$sync_path_output" != *"sync.backup.destination must be an absolute path"* ]]; then
  echo "FAIL: relative stored sync path did not produce migration guidance" >&2
  echo "$sync_path_output" >&2
  exit 1
fi
rm -f "$ENV_HOME/app-state.db" "$ENV_HOME/app-state.db-shm" "$ENV_HOME/app-state.db-wal"

if relative_output="$(
  HOME="$ENV_HOME" \
  TIMELINE_ENV_FILE="$TMP/config.env" \
  TIMELINE_DB_PATH="./timeline.db" \
    "$ARTIFACT/bin/timeline-service" --check-config 2>&1
)"; then
  echo "FAIL: packaged service accepted a relative database path" >&2
  exit 1
fi
if [[ "$relative_output" != *"TIMELINE_DB_PATH must be an absolute path"* ]]; then
  echo "FAIL: relative database path did not produce migration guidance" >&2
  echo "$relative_output" >&2
  exit 1
fi

echo "Probing packaged Monzo entry point..."
mkdir -p "$TMP/home"
if monzo_output="$(
  HOME="$TMP/home" \
  TIMELINE_DB_PATH="$TMP/monzo.db" \
  TIMELINE_ENV_FILE="$TMP/missing.env" \
    "$ARTIFACT/bin/timeline-service" monzo --headless 2>&1
)"; then
  echo "FAIL: unconfigured packaged Monzo parser unexpectedly succeeded" >&2
  exit 1
fi
if [[ "$monzo_output" != *"Monzo not configured."* ]]; then
  echo "FAIL: packaged Monzo parser did not reach its headless configuration check" >&2
  echo "$monzo_output" >&2
  exit 1
fi
expected_monzo_auth="'$ARTIFACT/bin/timeline-service' monzo auth"
if [[ "$monzo_output" != *"$expected_monzo_auth"* ]]; then
  echo "FAIL: packaged Monzo parser did not report its packaged auth command" >&2
  echo "$monzo_output" >&2
  exit 1
fi

echo "Probing packaged Monzo config handoff..."
MONZO_HOME="$TMP/monzo-home"
MONZO_DATA="$TMP/monzo-data"
mkdir -p "$MONZO_HOME/.config/timeline" "$MONZO_DATA"
cat > "$MONZO_HOME/.config/timeline/config.toml" <<EOF
[database]
path = "$MONZO_DATA/timeline.db"

[inbox]
watch_enabled = false

[media]
path = "$MONZO_DATA/media"
EOF
cat > "$MONZO_HOME/.config/timeline/monzo.json" <<'EOF'
{"credentials":{"client_id":"example-client","client_secret":"example-secret"}}
EOF
HOME="$MONZO_HOME" TIMELINE_ENV_FILE="$TMP/missing.env" \
  "$ARTIFACT/bin/timeline-service" monzo status
test -f "$MONZO_DATA/app-state.db"
test ! -e "$MONZO_HOME/.local/share/timeline/app-state.db"

echo "Probing packaged Sharp runtime..."
(
  cd "$ARTIFACT/Resources/runtime"
  "$ARTIFACT/bin/bun" --no-env-file -e '
    const sharp = (await import("sharp")).default;
    const image = await sharp({
      create: { width: 1, height: 1, channels: 4, background: "#000000" },
    }).png().toBuffer();
    if (image.length === 0) throw new Error("Sharp produced an empty image");
  '
)

sqlite_library="${TIMELINE_SQLITE_LIBRARY_PATH:-}"
if [ -z "$sqlite_library" ] && command -v brew >/dev/null 2>&1; then
  brew_prefix="$(brew --prefix sqlite 2>/dev/null || true)"
  if [ -n "$brew_prefix" ] && [ -f "$brew_prefix/lib/libsqlite3.dylib" ]; then
    sqlite_library="$brew_prefix/lib/libsqlite3.dylib"
  fi
fi

if [ -n "$sqlite_library" ]; then
  echo "Probing packaged sqlite-vec runtime..."
  (
    cd "$ARTIFACT/Resources/runtime"
    TIMELINE_SQLITE_LIBRARY_PATH="$sqlite_library" \
      "$ARTIFACT/bin/bun" --no-env-file -e '
        import { Database } from "bun:sqlite";
        import * as sqliteVec from "sqlite-vec";
        Database.setCustomSQLite(process.env.TIMELINE_SQLITE_LIBRARY_PATH);
        const db = new Database(":memory:");
        try {
          sqliteVec.load(db);
          const row = db.query("select vec_version() as version").get();
          if (!row?.version) throw new Error("sqlite-vec returned no version");
        } finally {
          db.close();
        }
      '
  )
else
  echo "SKIP: sqlite-vec probe needs a SQLite build with extension loading"
fi

commit="$(
  "$ARTIFACT/bin/bun" --no-env-file -e \
    'process.stdout.write((await Bun.file(process.argv[1]).json()).commit)' \
    "$ARTIFACT/Resources/version.json"
)"

echo "Smoke-testing artifact outside the checkout..."
PATH="/usr/bin:/bin" \
  PORT=3018 \
  TIMELINE_SERVICE_EXECUTABLE="$ARTIFACT/bin/timeline-service" \
  TIMELINE_SERVICE_CWD="$RUN_CWD" \
  TIMELINE_SMOKE_EXPECT_COMMIT="$commit" \
  TIMELINE_SMOKE_EXPECT_WEB=1 \
  "$ROOT/scripts/smoke-service.sh"

echo "OK: relocatable service artifact passed runtime and service probes."
