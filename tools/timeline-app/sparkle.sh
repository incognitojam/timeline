#!/usr/bin/env bash
# Sourced by build and appcast generation so both use the same verified tools.
SPARKLE_VERSION=2.10.1
SPARKLE_SHA256=1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27
SPARKLE_ROOT="$REPO_ROOT/tools/timeline-app/.cache/sparkle-$SPARKLE_VERSION"
if [ ! -f "$SPARKLE_ROOT/.verified" ]; then
  mkdir -p "$SPARKLE_ROOT"
  curl --fail --location --silent --show-error \
    "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz" \
    --output "$SPARKLE_ROOT/archive.tar.xz"
  printf '%s  %s\n' "$SPARKLE_SHA256" "$SPARKLE_ROOT/archive.tar.xz" | shasum -a 256 --check
  tar -xf "$SPARKLE_ROOT/archive.tar.xz" -C "$SPARKLE_ROOT"
  touch "$SPARKLE_ROOT/.verified"
fi
