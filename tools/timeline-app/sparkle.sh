#!/usr/bin/env bash
# Sourced by build and appcast generation so both use the same verified tools.
SPARKLE_VERSION=2.10.0
SPARKLE_SHA256=c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c
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
