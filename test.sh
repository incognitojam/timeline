#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: ./test.sh [all|static|unit|backend|frontend|browser] [Playwright arguments for browser]" >&2
}

suite="${1:-all}"
if [ "$#" -gt 0 ]; then shift; fi
case "$suite" in
  all | static | unit | backend | frontend | browser) ;;
  *)
    usage
    exit 2
    ;;
esac

if [ "$suite" != "browser" ] && [ "$#" -gt 0 ]; then
  usage
  exit 2
fi

case "${PLAYWRIGHT_IGNORE_SNAPSHOTS:-0}" in
  0 | 1) ;;
  *)
    echo "PLAYWRIGHT_IGNORE_SNAPSHOTS must be 0 or 1" >&2
    exit 1
    ;;
esac

if ! git check-ignore -q .scratch; then
  printf '\n.scratch/\n' >> "$(git rev-parse --git-path info/exclude)"
fi
mkdir -p .scratch
log_dir="$(mktemp -d .scratch/test-suite.XXXXXX)"
pending_pids=()
pending_labels=()
pending_logs=()

cleanup() {
  for pid in ${pending_pids[@]+"${pending_pids[@]}"}; do
    kill "$pid" 2>/dev/null || true
  done
  rm -rf "$log_dir"
}
trap cleanup EXIT

step=0
run_step() {
  local label="$1"
  local log_file
  local started_at
  local status=0
  local stream=false
  shift

  if [ "${1:-}" = "--stream" ]; then
    stream=true
    shift
  fi

  step=$((step + 1))
  log_file="$log_dir/$step.log"
  started_at=$SECONDS

  printf '%s... ' "$label"
  if "$stream"; then
    printf '\n'
    "$@" 2>&1 || status=$?
  else
    "$@" >"$log_file" 2>&1 || status=$?
  fi

  if "$stream"; then printf '%s... ' "$label"; fi
  if [ "$status" -eq 0 ]; then
    printf 'passed (%ss)\n' "$((SECONDS - started_at))"
  else
    printf 'failed (%ss)\n\n' "$((SECONDS - started_at))"
    if ! "$stream"; then cat "$log_file"; fi
    return "$status"
  fi
}

start_step() {
  local label="$1"
  local log_file
  shift
  step=$((step + 1))
  log_file="$log_dir/$step.log"
  printf '%s... started\n' "$label"
  (
    started_at=$SECONDS
    status=0
    "$@" >"$log_file" 2>&1 || status=$?
    printf '%s' "$((SECONDS - started_at))" >"$log_file.seconds"
    exit "$status"
  ) &
  pending_pids+=("$!")
  pending_labels+=("$label")
  pending_logs+=("$log_file")
}

wait_steps() {
  local failed=0
  local status
  local i
  for ((i = 0; i < ${#pending_pids[@]}; i++)); do
    status=0
    wait "${pending_pids[$i]}" || status=$?
    if [ "$status" -eq 0 ]; then
      printf '%s... passed (%ss)\n' "${pending_labels[$i]}" "$(cat "${pending_logs[$i]}.seconds")"
    else
      printf '%s... failed (exit %s)\n' "${pending_labels[$i]}" "$status"
      cat "${pending_logs[$i]}"
      failed=1
    fi
  done
  pending_pids=()
  pending_labels=()
  pending_logs=()
  return "$failed"
}

in_web() {
  (cd web && "$@")
}

run_backend_tests() {
  if [ -n "${TIMELINE_SQLITE_LIBRARY_PATH:-}" ]; then
    echo "Using sqlite-vec-capable SQLite: $TIMELINE_SQLITE_LIBRARY_PATH"
  fi
  bun test --timeout 30000 --max-concurrency 4 || return "$?"
  # bunfig.toml pins discovery to src/, so scripts/ needs an explicit path.
  bun test --timeout 30000 ./scripts/
}

install_root_dependencies() {
  run_step "Installing dependencies" bun install --frozen-lockfile
}

install_frontend_dependencies() {
  run_step "Installing frontend dependencies" in_web bun install --frozen-lockfile
}

run_go_sidecar_checks() {
  (cd tools/timeline-gmessages && go vet ./... && go test ./...)
}

run_static_suite() {
  run_step "Checking public release safety" bun run src/scripts/check-public-release-safety.ts
  run_step "Checking product version" bun run version:check
  run_step "Linting" bun run lint
  # The google-messages sync source depends on this binary's JSONL contract.
  if command -v go >/dev/null 2>&1; then
    run_step "Checking Go sidecar" run_go_sidecar_checks
  fi
}

start_backend_checks() {
  local brew_prefix
  local brew_sqlite

  # The embeddings vector index (sqlite-vec) is a loadable SQLite extension, but
  # bun:sqlite binds to macOS's system SQLite, which is built without dynamic
  # extension loading. Point it at Homebrew's SQLite when present so the
  # sqlite-vec tests run here (and in CI on the macOS host) instead of silently
  # skipping. Linux's system SQLite generally loads extensions already.
  if [ -z "${TIMELINE_SQLITE_LIBRARY_PATH:-}" ]; then
    brew_sqlite=""
    if command -v brew >/dev/null 2>&1 && brew_prefix="$(brew --prefix sqlite 2>/dev/null)"; then
      brew_sqlite="$brew_prefix/lib/libsqlite3.dylib"
    fi
    for candidate in "$brew_sqlite" \
      /opt/homebrew/opt/sqlite/lib/libsqlite3.dylib \
      /usr/local/opt/sqlite/lib/libsqlite3.dylib; do
      if [ -n "$candidate" ] && [ -f "$candidate" ]; then
        export TIMELINE_SQLITE_LIBRARY_PATH="$candidate"
        break
      fi
    done
  fi

  # --timeout bumped from the 5s default so slow hooks on bursty CI runners
  # (tmpdir SQLite setup) are a slowdown, not a failure.
  start_step "Running backend tests" run_backend_tests
  start_step "Type checking backend" bunx tsc --noEmit
}

start_frontend_checks() {
  start_step "Running frontend tests" in_web bun run test:run
  start_step "Type checking frontend" in_web bunx tsc --noEmit
}

start_unit_suite() {
  start_backend_checks
  start_frontend_checks
}

run_browser_suite() {
  if [ "${PLAYWRIGHT_IGNORE_SNAPSHOTS:-0}" = "1" ]; then
    run_step "Installing Playwright Chromium" --stream in_web bunx playwright install chromium || return "$?"
    run_step "Running browser tests (visual snapshots skipped)" --stream in_web bunx playwright test "$@"
  else
    run_step "Running browser tests (Linux screenshots)" --stream ./scripts/test-browser.sh "$@"
  fi
}

case "$suite" in
  all)
    install_root_dependencies
    install_frontend_dependencies
    run_static_suite
    start_unit_suite
    # Playwright builds the production frontend before starting its preview.
    # A second concurrent Vite build would race on web/dist.
    browser_status=0
    run_browser_suite || browser_status=$?
    unit_status=0
    wait_steps || unit_status=$?
    if [ "$browser_status" -ne 0 ] || [ "$unit_status" -ne 0 ]; then exit 1; fi
    ;;
  static)
    install_root_dependencies
    run_static_suite
    ;;
  unit)
    install_root_dependencies
    install_frontend_dependencies
    start_unit_suite
    wait_steps
    ;;
  backend)
    install_root_dependencies
    start_backend_checks
    wait_steps
    ;;
  frontend)
    install_root_dependencies
    install_frontend_dependencies
    start_frontend_checks
    wait_steps
    ;;
  browser)
    # The Docker runner installs Linux dependencies inside the container.
    if [ "${PLAYWRIGHT_IGNORE_SNAPSHOTS:-0}" = "1" ]; then install_frontend_dependencies; fi
    run_browser_suite "$@"
    ;;
esac
