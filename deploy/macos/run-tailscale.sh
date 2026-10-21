#!/usr/bin/env bash
set -euo pipefail

# Wrapper that launchd runs to start a userspace tailscaled for Timeline's
# "Remote Access" feature. tailscaled exposes the local Timeline service
# publicly via Tailscale Funnel; login and funnel config persist in the state
# directory, so supervision only needs to keep this process alive — no re-login
# or re-funnel on restart.
#
# Userspace networking means no root, no TUN device, and no system extension:
# HTTPS certs and Funnel work fine over the userspace socket. Every `tailscale`
# CLI call for this node must dial the socket below (--socket=…), or it talks to
# the GUI Tailscale.app instead.

# Must match the path hardcoded in the app (tools/timeline-app/RemoteAccess.swift),
# which drives login/funnel over the socket in this directory.
STATE_DIR="$HOME/.local/share/timeline/tailscale"
TAILSCALED="${TIMELINE_TAILSCALED:-/opt/homebrew/bin/tailscaled}"

# Fail fast (no silent fallback): if the Homebrew binary is missing the whole
# feature is inoperable, so refuse to start with a clear log line rather than
# letting launchd respawn a phantom.
if [ ! -x "$TAILSCALED" ]; then
  echo "run-tailscale: tailscaled not found at $TAILSCALED; install with 'brew install tailscale'" >&2
  exit 1
fi

# The state directory is created by the app's Set Up Remote Access action — it
# is the opt-in marker. Never create it here: a missing statedir means the user
# has not opted in (or has deleted it), so refuse to start.
if [ ! -d "$STATE_DIR" ]; then
  echo "run-tailscale: state directory $STATE_DIR does not exist; use Set Up Remote Access in the Timeline menu bar app" >&2
  exit 1
fi

exec "$TAILSCALED" \
  --tun=userspace-networking \
  --statedir="$STATE_DIR" \
  --socket="$STATE_DIR/tailscaled.sock" \
  --port=0
