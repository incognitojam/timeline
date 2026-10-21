#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Prefix every line written to capture.log with an ISO timestamp.
# launchd captures both streams into the same file, so we merge here too.
exec > >(while IFS= read -r line; do printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$line"; done) 2>&1

OUT_ROOT="$HOME/.local/share/timeline/recall"
PAUSE_FLAG="$HOME/.local/share/timeline/recall.pause"
EXCLUDE_FILE="$HOME/.config/timeline/recall-exclude.txt"
BIN="${TIMELINE_RECALL_BIN:-$HOME/.local/share/timeline-recall/timeline-recall}"

# Pause flag honoured
[ -f "$PAUSE_FLAG" ] && exit 0

# Skip when no display is awake. IODisplayWrangler is Intel-only;
# IOMobileFramebufferShim is the Apple Silicon equivalent. Either class
# appearing with USEABLE in pmset means at least one display is on.
# `grep -q` would exit early on first match and SIGPIPE pmset's large output —
# with pipefail on, that fails the pipeline. Drop -q + redirect to keep grep
# reading until pmset is done.
if ! pmset -g powerstate 2>/dev/null | grep -E '(IODisplayWrangler|IOMobileFramebufferShim).*USEABLE' >/dev/null; then
    exit 0
fi

# Frontmost app + exclude check
APP="$(osascript -e 'tell application "System Events" to name of first application process whose frontmost is true' 2>/dev/null || echo unknown)"
if [ -f "$EXCLUDE_FILE" ] && grep -Fxq "$APP" "$EXCLUDE_FILE"; then
    exit 0
fi

DATE="$(date '+%Y-%m-%d')"
STAMP="$(date '+%H%M%S')"
DIR="$OUT_ROOT/$DATE"
mkdir -p "$DIR"

# Binary writes one <STAMP>-NN.png + <STAMP>-NN.json per on-screen window into a
# scratch dir. Capture is done inside the binary (not via `screencapture`) so the
# Screen Recording permission attribution lines up with a named binary that can
# be added to System Settings → Privacy & Security. The binary self-determines
# the frontmost app (via NSWorkspace) to flag which window had focus, and reads
# the exclude file to skip excluded apps per window (even when not frontmost).
WORK="$(mktemp -d -t recall)"
trap 'rm -rf "$WORK"' EXIT

"$BIN" "$WORK" "$STAMP" "$EXCLUDE_FILE"

# Convert each PNG -> WebP and publish complete pairs atomically. The JSON is
# renamed into place before its WebP, so the parser (which keys off .webp) never
# sees a WebP without its sidecar.
shopt -s nullglob
for png in "$WORK/$STAMP"-*.png; do
    stem="$(basename "${png%.png}")"
    [ -f "$WORK/$stem.json" ] || continue
    cwebp -quiet -q 80 -mt "$png" -o "$WORK/$stem.webp" || continue
    cp "$WORK/$stem.json" "$DIR/.$stem.json.tmp" || continue
    mv "$DIR/.$stem.json.tmp" "$DIR/$stem.json"
    cp "$WORK/$stem.webp" "$DIR/.$stem.webp.tmp" || continue
    mv "$DIR/.$stem.webp.tmp" "$DIR/$stem.webp"
done

# Backstop: prune any captures that never made it off the Mac, plus empty date
# dirs left after rsync --remove-source-files clears the files inside.
find "$OUT_ROOT" -type f \( -name '*.webp' -o -name '*.json' \) -mtime +90 -delete 2>/dev/null || true
find "$OUT_ROOT" -mindepth 1 -type d -empty -delete 2>/dev/null || true
