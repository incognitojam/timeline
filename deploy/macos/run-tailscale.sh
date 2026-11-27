#!/usr/bin/env bash
set -euo pipefail

# Wrapper that launchd runs to start a userspace tailscaled for Timeline's
# "Remote Access" feature. tailscaled serves the local Timeline service to the
# tailnet via Tailscale Serve. Login persists in the state directory, so
# supervision only needs to keep this process alive — no re-login on restart;
# the serve config is reset at each start (see below) and the app re-applies it.
#
# Userspace networking means no root, no TUN device, and no system extension:
# HTTPS certs and Serve work fine over the userspace socket. Every `tailscale`
# CLI call for this node must dial the socket below (--socket=…), or it talks to
# the GUI Tailscale.app instead.

# Must match the path hardcoded in the app (tools/timeline-app/RemoteAccess.swift),
# which drives login/serve over the socket in this directory.
STATE_DIR="$HOME/.local/share/timeline/tailscale"
TAILSCALED="${TIMELINE_TAILSCALED:-/opt/homebrew/bin/tailscaled}"
TAILSCALE="${TIMELINE_TAILSCALE:-/opt/homebrew/bin/tailscale}"

# Fail fast (no silent fallback): if the Homebrew binary is missing the whole
# feature is inoperable, so refuse to start with a clear log line rather than
# letting launchd respawn a phantom.
for binary in "$TAILSCALED" "$TAILSCALE"; do
  if [ ! -x "$binary" ]; then
    echo "run-tailscale: $binary not found; install with 'brew install tailscale'" >&2
    exit 1
  fi
done

# The state directory is created by the app's Set Up Remote Access action — it
# is the opt-in marker. Never create it here: a missing statedir means the user
# has not opted in (or has deleted it), so refuse to start.
if [ ! -d "$STATE_DIR" ]; then
  echo "run-tailscale: state directory $STATE_DIR does not exist; use Set Up Remote Access in the Timeline menu bar app" >&2
  exit 1
fi

# Public access (Funnel) is enforced by the app, which may not be running when
# tailscaled starts, so it ends whenever tailscaled starts: drop the app's
# record, and any record an update quit paused, and reset the persisted serve
# config; the app serves to the tailnet again on its next check. tailscaled loads the serve config, and accepts a
# reset, only once it has a netmap, so retry until the reset succeeds.
rm -f "$HOME/.local/share/timeline/tailscale-public-access" \
  "$HOME/.local/share/timeline/tailscale-public-access.paused"
(
  until "$TAILSCALE" --socket="$STATE_DIR/tailscaled.sock" serve reset 2>/dev/null; do
    sleep 1
  done
  echo "run-tailscale: serve config reset at tailscaled start" >&2
) &

exec "$TAILSCALED" \
  --tun=userspace-networking \
  --statedir="$STATE_DIR" \
  --socket="$STATE_DIR/tailscaled.sock" \
  --port=0
