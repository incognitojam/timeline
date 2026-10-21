#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

bun_version="$(bun -p 'require("./package.json").packageManager.split("@")[1]')"
playwright_version="$(bun -e 'const lock = Bun.JSONC.parse(await Bun.file("web/bun.lock").text()); console.log(lock.packages["@playwright/test"][0].split("@").at(-1))')"
image="timeline-browser:$playwright_version-bun$bun_version"
runtime_mounts=()

if [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] && [ "$(bun --version)" = "$bun_version" ]; then
  # Hosted Linux already has the locked Bun binary; avoid pulling a second image.
  image="mcr.microsoft.com/playwright:v$playwright_version-noble"
  runtime_mounts+=(--mount "type=bind,source=$(command -v bun),target=/usr/local/bin/bun,readonly")
else
  docker build --platform linux/amd64 --tag "$image" \
    --build-arg "BUN_VERSION=$bun_version" \
    --build-arg "PLAYWRIGHT_VERSION=$playwright_version" \
    --file scripts/browser.Dockerfile scripts
fi

# Keep host dependencies out of Linux, and write reports/baselines as the caller.
exec docker run --rm --init --ipc=host --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp --env CI="${CI:-}" \
  --env PLAYWRIGHT_CHART_SWEEP \
  --mount "type=bind,source=$PWD,target=/workspace" \
  --tmpfs /workspace/node_modules \
  --tmpfs "/workspace/web/node_modules:exec,uid=$(id -u),gid=$(id -g)" \
  ${runtime_mounts[@]+"${runtime_mounts[@]}"} \
  --workdir /workspace/web "$image" \
  bash -c 'bun install --frozen-lockfile && exec bun run test:e2e "$@"' -- "$@"
