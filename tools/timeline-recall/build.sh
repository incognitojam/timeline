#!/bin/bash
# Build the timeline-recall binary.
# Output: ./timeline-recall (in this directory)
set -euo pipefail
cd "$(dirname "$0")"

IDENTITY="Timeline Recall Signing"

swiftc -target "$(uname -m)-apple-macos14.0" -O -parse-as-library main.swift ../timeline-app/RecallCapture.swift -o timeline-recall

# Sign with a stable identity so the Screen Recording (TCC) grant survives
# rebuilds. An ad-hoc signature is keyed by the cdhash, which changes on every
# recompile and voids the grant. Hard-fail (rather than fall back to ad-hoc) if
# the identity is missing — a silent ad-hoc fallback would reintroduce the exact
# re-grant friction this signing step removes.
if ! security find-identity -p codesigning | grep -qF "$IDENTITY"; then
  echo "error: code-signing identity '$IDENTITY' not found." >&2
  echo "Run ./create-signing-identity.sh once to create it, then rebuild." >&2
  exit 1
fi

codesign --force --identifier com.incognitojam.timeline-recall \
  --sign "$IDENTITY" timeline-recall

echo "Built and signed $(pwd)/timeline-recall"
