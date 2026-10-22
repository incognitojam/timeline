# shellcheck shell=bash
# Sourced from the repository root by setup.sh, test.sh, and test-browser.sh.
# package.json's packageManager pins Bun; mise.toml pins the other tools and
# reads the Bun pin from package.json.

toolchain_hint() {
  cat >&2 <<'EOF'
Install the pinned toolchain with mise (https://mise.jdx.dev/getting-started.html):
  mise install
then activate mise in your shell, or prefix commands with `mise exec --`.
EOF
}

pinned_bun_version() {
  bun -p 'require("./package.json").packageManager?.match(/^bun@([^+]+)/)?.[1] ?? ""'
}

require_pinned_bun() {
  local expected actual
  if ! command -v bun >/dev/null 2>&1; then
    echo "Bun is not on PATH." >&2
    toolchain_hint
    return 1
  fi
  expected="$(pinned_bun_version)"
  if [ -z "$expected" ]; then
    echo "package.json packageManager must pin an exact bun@<version>." >&2
    return 1
  fi
  actual="$(bun --version)"
  if [ "$actual" != "$expected" ]; then
    echo "Timeline requires Bun $expected (package.json packageManager), but $(command -v bun) is Bun $actual." >&2
    toolchain_hint
    return 1
  fi
}

require_tools() {
  local tool missing=()
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if [ "${#missing[@]}" -ne 0 ]; then
    echo "Missing required tools: ${missing[*]}" >&2
    toolchain_hint
    return 1
  fi
}
