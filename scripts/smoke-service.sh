#!/usr/bin/env bash
set -euo pipefail

# Smoke-test that the Timeline service boots and serves on this OS.
#
# Boots the source service (or TIMELINE_SERVICE_EXECUTABLE when supplied)
# against a throwaway database and a minimal
# config (scheduler enabled with zero sync sources, inbox watcher off) and a
# throwaway AUTH_PASSWORD so the production auth preflight passes. Importing
# the API module runs initDb() against the empty database, so this also
# exercises schema creation on the host's SQLite/Bun toolchain. Then waits for
# GET /api/health to report healthy and SIGTERMs the process, asserting a clean
# (exit 0) graceful shutdown.
#
# Used by the `macos-service` CI job to gate the claim that the service runs on
# macOS — the foundation the launchd LaunchAgent (deploy/macos, slice 1b) sits
# on. Runs anywhere Bun + curl exist; `bun install` must have run first.
#
# Usage: ./scripts/smoke-service.sh   (override the port with PORT=NNNN)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_CWD="${TIMELINE_SERVICE_CWD:-$ROOT}"
SERVICE_EXECUTABLE="${TIMELINE_SERVICE_EXECUTABLE:-}"

if [ -n "$SERVICE_EXECUTABLE" ] && [ ! -x "$SERVICE_EXECUTABLE" ]; then
  echo "FAIL: TIMELINE_SERVICE_EXECUTABLE is not executable: $SERVICE_EXECUTABLE" >&2
  exit 1
fi

PORT="${PORT:-3017}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
BOOT_TIMEOUT_S="${BOOT_TIMEOUT_S:-30}"
STOP_TIMEOUT_S="${STOP_TIMEOUT_S:-15}"

TMP="$(mktemp -d)"
SVC_PID=""

cleanup() {
  if [ -n "${SVC_PID}" ] && kill -0 "${SVC_PID}" 2>/dev/null; then
    kill -KILL "${SVC_PID}" 2>/dev/null || true
  fi
  rm -rf "${TMP}" 2>/dev/null || true
}
trap cleanup EXIT

# Put the database path in config rather than the environment. This verifies
# the bootstrap resolves config before schema.ts captures the DB path.
cat > "${TMP}/config.toml" <<EOF
[database]
path = "${TMP}/timeline.db"

[scheduler]
enabled = true
stagger = false

[inbox]
watch_enabled = false
EOF

echo "Booting service (port ${PORT}, db ${TMP}/timeline.db)..."
(
  cd "$SERVICE_CWD"
  if [ -n "$SERVICE_EXECUTABLE" ]; then
    service_command=("$SERVICE_EXECUTABLE")
  else
    service_command=(bun run "$ROOT/src/service.ts")
  fi
  exec env \
    TIMELINE_CONFIG="${TMP}/config.toml" \
    TIMELINE_ENV_FILE="${TMP}/missing.env" \
    TIMELINE_MEDIA_PATH="${TMP}/media" \
    TIMELINE_HOST="127.0.0.1" \
    TIMELINE_PORT="${PORT}" \
    AUTH_PASSWORD="smoke-test-password" \
    NODE_ENV=production \
    "${service_command[@]}"
) > "${TMP}/service.log" 2>&1 &
SVC_PID=$!

# Wait for the API to come up and report healthy.
healthy=0
deadline=$(( $(date +%s) + BOOT_TIMEOUT_S ))
while [ "$(date +%s)" -lt "${deadline}" ]; do
  if ! kill -0 "${SVC_PID}" 2>/dev/null; then
    echo "FAIL: service process exited during boot"
    cat "${TMP}/service.log"
    exit 1
  fi
  body="$(curl -fsS "${HEALTH_URL}" 2>/dev/null || true)"
  if [ -n "${body}" ] && printf '%s' "${body}" | tr -d ' \n' | grep -q '"status":"healthy"'; then
    healthy=1
    echo "Healthy: ${body}"
    break
  fi
  sleep 0.5
done

if [ "${healthy}" -ne 1 ]; then
  echo "FAIL: /api/health did not report healthy within ${BOOT_TIMEOUT_S}s"
  cat "${TMP}/service.log"
  exit 1
fi

if [ -n "${TIMELINE_SMOKE_EXPECT_COMMIT:-}" ] &&
  ! printf '%s' "$body" | grep -q "\"commit\":\"${TIMELINE_SMOKE_EXPECT_COMMIT}\""; then
  echo "FAIL: /api/health did not report commit ${TIMELINE_SMOKE_EXPECT_COMMIT}"
  echo "$body"
  exit 1
fi

if [ "${TIMELINE_SMOKE_EXPECT_WEB:-0}" = "1" ]; then
  web_body="$(curl -fsS "http://127.0.0.1:${PORT}/")"
  if ! printf '%s' "$web_body" | grep -qi '<!doctype html>'; then
    echo "FAIL: packaged web frontend was not served"
    exit 1
  fi
fi

# Assert a clean graceful shutdown on SIGTERM (service.ts calls process.exit(0)).
echo "Sending SIGTERM..."
kill -TERM "${SVC_PID}"
( sleep "${STOP_TIMEOUT_S}" && kill -KILL "${SVC_PID}" 2>/dev/null ) &
watchdog=$!
if wait "${SVC_PID}"; then
  code=0
else
  code=$?
fi
kill "${watchdog}" 2>/dev/null || true
wait "${watchdog}" 2>/dev/null || true
SVC_PID=""

if [ "${code}" -ne 0 ]; then
  echo "FAIL: service did not exit cleanly on SIGTERM (exit ${code})"
  cat "${TMP}/service.log"
  exit 1
fi

echo "OK: service booted, served /api/health, and shut down cleanly."
