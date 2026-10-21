#!/bin/bash
# Run the recall capture probe from an interactive terminal (so it runs inside
# the Aqua GUI session). Output is teed to /tmp/recall-probe-out.txt.
#
# Usage: bash tools/timeline-recall/run-probe.sh
set -uo pipefail
cd "$(dirname "$0")"

BIN="$PWD/timeline-recall-probe"
OUT="/tmp/recall-probe-out.txt"
EXISTING="$HOME/Developer/timeline-recall/timeline-recall"

if [ ! -x "$BIN" ]; then
  echo "Building probe…"
  swiftc -O probe.swift -o timeline-recall-probe
fi

{
  echo "### baseline: existing known-good timeline-recall binary ###"
  if [ -x "$EXISTING" ]; then
    # stdout is OCR text of your screen — discard it; we only care if capture works.
    if "$EXISTING" /tmp/recall-baseline.png >/dev/null 2>/tmp/recall-baseline.err; then
      echo "baseline OK ($(stat -f%z /tmp/recall-baseline.png 2>/dev/null) bytes captured)"
    else
      echo "baseline FAILED rc=$? : $(cat /tmp/recall-baseline.err)"
    fi
    rm -f /tmp/recall-baseline.png
  else
    echo "(existing binary not found at $EXISTING — skipping baseline)"
  fi

  echo
  echo "### windows (whole-display first, then per-window sizing) ###"
  "$BIN" windows

  echo
  echo "### dedup (every window every 3s for ~60s — use the machine normally) ###"
  "$BIN" dedup 20 3
} 2>&1 | tee "$OUT"

echo
echo "Wrote $OUT"
