#!/bin/bash
# Build the sidecar and ship its corresponding source with a service artifact.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export GOTOOLCHAIN=local
expected="$(sed -n 's/^go = "\([^"]*\)"/\1/p' "$ROOT/mise.toml")"
if ! command -v go >/dev/null 2>&1; then
  echo "Go is required to build Timeline.app. Run mise install go and mise exec -- tools/timeline-app/build.sh." >&2
  exit 1
fi
if [ -z "$expected" ] || [ "$(go env GOVERSION)" != "go$expected" ]; then
  echo "Timeline requires Go $expected from mise.toml. Run mise install go and build with mise exec --." >&2
  exit 1
fi
if [ "${1:-}" = --check ]; then exit 0; fi
if [ "$#" -ne 1 ]; then echo "usage: $0 <service-artifact-directory> | --check" >&2; exit 2; fi
artifact="$(cd "$1" && pwd)"
case "$(uname -m)" in
  arm64) export GOARCH=arm64 ;;
  x86_64) export GOARCH=amd64 ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac
export GOOS=darwin CGO_ENABLED=0
cd "$ROOT"
if ! git check-ignore -q .scratch; then
  printf '\n.scratch/\n' >> "$(git rev-parse --git-path info/exclude)"
fi
mkdir -p .scratch
work="$(mktemp -d "$ROOT/.scratch/sidecar-bundle.XXXXXX")"
trap 'rm -rf "$work"' EXIT
source_dir="$work/timeline-gmessages"
mkdir -p "$source_dir" "$artifact/bin" "$artifact/Resources/licenses/timeline-gmessages"
cp tools/timeline-gmessages/*.go tools/timeline-gmessages/go.mod tools/timeline-gmessages/go.sum \
  tools/timeline-gmessages/LICENSE tools/timeline-gmessages/README.md "$source_dir/"
# Vendor only in the build directory. The archive is also the input to the
# compiler, keeping dependency sources and their license notices with the binary.
(cd "$source_dir" && go mod vendor && go build -mod=vendor -trimpath -buildvcs=false -o "$artifact/bin/timeline-gmessages" .)
cat > "$source_dir/BUILDING.txt" <<BUILD
Compiler: Go $expected (https://go.dev/dl/)
GOOS=$GOOS GOARCH=$GOARCH CGO_ENABLED=0 GOTOOLCHAIN=local go build -mod=vendor -trimpath -buildvcs=false -o timeline-gmessages .
No network dependency downloads are needed; vendor/ contains the dependency sources.
Code signing is applied separately by Timeline's app packaging scripts.
BUILD
licenses="$artifact/Resources/licenses/timeline-gmessages"
cp "$source_dir/LICENSE" "$licenses/LICENSE"
tar -czf "$licenses/source.tar.gz" -C "$work" timeline-gmessages
revision="$(git describe --tags --exact-match HEAD 2>/dev/null || git rev-parse HEAD)"
cat > "$licenses/NOTICE.txt" <<NOTICE
timeline-gmessages is distributed under GNU AGPL version 3 or later.
It uses Beeper's libgm (go.mau.fi/mautrix-gmessages).
License: LICENSE. Corresponding source, dependency notices and build instructions: source.tar.gz.
Source for this revision: https://github.com/incognitojam/timeline/tree/$revision/tools/timeline-gmessages
App build and signing scripts: https://github.com/incognitojam/timeline/tree/$revision/tools/timeline-app
Timeline's separate service and app remain under their MIT license.
NOTICE
