# Running Timeline on macOS (launchd)

Run the Timeline service as a background process on your Mac, managed by the
Timeline menu bar app through a per-user launchd **LaunchAgent**. It runs
the service packaged inside `Timeline.app` (API + scheduler + inbox watcher),
supervised by the OS so it starts at login and restarts on crash.

## Prerequisites

- [Bun](https://bun.sh) on your `PATH` to build the app. The installed service
  carries its own pinned Bun runtime.
- A checkout to build from. It does not need to remain after installation.

## Install

```bash
bun install
(cd web && bun install)
cd tools/timeline-app
./build.sh --install
```

This:

1. Builds and installs `~/Applications/Timeline.app`, embedding a LaunchAgent
   plist that points at the service inside the installed bundle.
   Source builds install in `~/Applications/Timeline.app`; signed DMGs also
   support `/Applications/Timeline.app`. Keep only one installed copy; the menu
   warns when both exist.
2. On first launch from `~/Applications`, Timeline registers and starts the
   bundled `dev.incognitojam.timeline-service` agent. If an older plist exists
   at `~/Library/LaunchAgents/dev.incognitojam.timeline-service.plist`, the app
   boots it out if loaded, renames it to
   `dev.incognitojam.timeline-service.plist.migrated`, then registers the
   bundled agent. The `.migrated` file is kept as the rollback safety net.

The API listens per your `config.toml` `[server]` block, defaulting to
`127.0.0.1` (local-only); set `0.0.0.0` or a LAN IP to expose it on your network. The
service runs with `NODE_ENV=production`, so set `AUTH_PASSWORD` in
`~/.config/timeline/env` before relying on it; without that password the API
refuses to start. Check it: `curl -s http://127.0.0.1:3001/api/health`.
For detailed service status, sign in to the web app and open `/status`, or use
`curl -u ':password' http://127.0.0.1:3001/status.md` for authenticated Markdown.
The packaged launcher also adds the standard Apple Silicon and Intel Homebrew
locations to `PATH`, allowing scheduled sources to find tools such as `rclone`
under launchd's minimal environment.

The packaged service requires absolute paths (or `~/...`, which it expands)
for its env file and configured file/database locations.
`build.sh --install` validates these before stopping the installed service, so
an older checkout-relative path cannot silently select a different database or
retarget a sync source. This includes persisted settings such as backup
destinations; the preflight error names the setting that needs an absolute path.

If macOS reports that the service agent requires approval, use the Timeline menu
item that opens System Settings -> General -> Login Items.

If the menu shows `Service agent: session-only registration`, launchd has the
bundled service agent loaded but macOS did not persist the SMAppService
background-item record. This can happen with a self-signed app; the app leaves
the already-loaded bundled job running and will try to reconcile again later.

If you need a starter config, copy
[`deploy/macos/config.toml.example`](../../deploy/macos/config.toml.example) to
`~/.config/timeline/config.toml` before enabling syncs.

## Enable syncing

The macOS template ships with the scheduler and inbox watcher off. To start
pulling data, keep any bootstrap `[sync.*]` examples you want for the one-time
import, keep the `[inbox.sources.*]` sections you need, put credentials in
`~/.config/timeline/env` (see [Secrets](#secrets)), set `scheduler.enabled =
true` (and `inbox.watch_enabled = true` if using inboxes), then restart:
`launchctl kickstart -k gui/$(id -u)/dev.incognitojam.timeline-service`.

After first startup, sync-source settings live in `app-state.db` and are edited
from the web UI. `config.toml` `[sync.*]` sections left behind are ignored and
logged as a warning until removed.

## Secrets

API tokens and any env overrides go in `~/.config/timeline/env`. Timeline entry
points load this file before service modules open configuration or databases:

```sh
# ~/.config/timeline/env
AUTH_PASSWORD=choose-a-password
# Optional: enables MCP HTTP; clients can use /mcp with Bearer auth or /mcp/<token>.
MCP_TOKENS=token-1,token-2
DISCORD_TOKEN=...
# API key for an [llm.providers.*] OpenRouter provider (config.toml). AI features
# also need at least one [llm.providers.*] block — the key alone does nothing.
OPENROUTER_API_KEY=sk-or-...
# Overrides also work here, e.g. TIMELINE_PORT=3002
# Encrypted offsite media (see [media.r2] in config.toml). Generate the key with
# `openssl rand -base64 32` and BACK IT UP to a password manager — without it the
# offsite copy is unrecoverable.
MEDIA_ENCRYPTION_KEY=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
# Encrypted offsite database backups (see [backup.r2] in config.toml and the
# backup-offsite sync source in the web UI). Separate key from the media one for
# blast-radius isolation; same BACK IT UP caveat — without it the offsite
# backups are unrecoverable.
BACKUP_ENCRYPTION_KEY=...
```

For rclone-backed inbox sources, leave `RCLONE_CONFIG` unset to use rclone's
standard `~/.config/rclone/rclone.conf`, or set it here to another Mac-local
path.

The env file is sourced as a shell file by the packaged launcher, preserving
expansions such as `TIMELINE_DB_PATH="$HOME/.local/share/timeline/timeline.db"`.

`config.toml` is read once at service startup, so bootstrap changes — server
binding, database paths, media storage, scheduler globals, inbox settings, LLM
providers — and any edit to the env file need a restart:
`launchctl kickstart -k gui/$(id -u)/dev.incognitojam.timeline-service`.

Sync-source settings are the exception: they live in `app-state.db` (see
[Enable syncing](#enable-syncing)), and enable/disable changes made from the web
UI reach the scheduler worker over a lightweight `sync-config-changed` nudge with
no restart or file reload involved.

## Operate

```bash
# Normal service output
tail -f ~/Library/Logs/timeline/service.log

# Warnings and errors
tail -f ~/Library/Logs/timeline/service.error.log

# Status / whether it's running
launchctl print gui/$(id -u)/dev.incognitojam.timeline-service

# Restart the packaged service
launchctl kickstart -k gui/$(id -u)/dev.incognitojam.timeline-service

# Stop the currently loaded agent (config and data are left in place)
launchctl bootout gui/$(id -u)/dev.incognitojam.timeline-service
```

To remove the app-owned service agent, quit Timeline and disable or remove
Timeline in System Settings -> General -> Login Items. `launchctl bootout` stops
the currently loaded job but does not change the Login Items registration.

## Remote access (Tailscale Funnel)

Timeline can expose the local service publicly at a stable
`https://<node>.ts.net` URL via [Tailscale Funnel](https://tailscale.com/kb/1223/funnel).
The menu bar app owns a second LaunchAgent
(`dev.incognitojam.timeline-tailscale`) that runs a **userspace** `tailscaled`
just for this — no root, no TUN device, no system extension, separate from any
GUI Tailscale.app you may run.

**Prerequisite:** `brew install tailscale` (provides `/opt/homebrew/bin/tailscaled`
and `/opt/homebrew/bin/tailscale`). Until it's installed the menu shows
"Remote Access: Tailscale not installed".

**Opt in:** Remote Access is off until you choose **Set Up Remote Access…** in
the menu. That creates the state directory and registers the agent, then the
menu offers **Log In to Tailscale…** — click it, authorize the node in the
browser that opens, and the menu switches to showing the node's DNS name with a
**Copy Public URL** button. The app never re-runs login on its own (that would
regenerate the node key and orphan a pending authorization); login is always a
button click.

- **State directory:** `~/.local/share/timeline/tailscale/` — daemon state,
  socket (`tailscaled.sock`). **Login and funnel config persist here**, so a
  daemon restart needs no re-login or re-funnel; the agent just keeps
  `tailscaled` alive (`KeepAlive`).
- **Socket:** every `tailscale` CLI call for this node must pass
  `--socket=~/.local/share/timeline/tailscale/tailscaled.sock`, or the CLI talks
  to the GUI Tailscale.app instead.
- **Funnel port:** the app funnels the service port from your `config.toml`
  `[server]` block (default `3001`); it applies the funnel idempotently once the
  node is Running.
- **Logs:** `~/Library/Logs/timeline/tailscale.log` (and `.error.log`).

**Turn off:** choose **Turn Off Remote Access** in the menu. This unregisters
the agent (stopping `tailscaled`) but keeps the state directory, so re-enabling
via **Set Up Remote Access…** needs no re-login or re-funnel. The off state is
recorded in `~/.local/share/timeline/tailscale.disabled`.

**Manual takeover:** if you set `tailscaled` up by hand and it's still running
from a shell session, quit that process before the agent can bind the socket —
two daemons can't share it.

## Stopping the service for maintenance

Create the maintenance hold before booting out the app-managed agent:

```bash
touch ~/.local/share/timeline/service.hold
launchctl bootout gui/$(id -u)/dev.incognitojam.timeline-service
```

While `service.hold` exists, the menu bar app does not migrate, register,
self-heal, or kickstart the service agent. The health line may still show
`Service: not responding`, which is expected while the service is stopped. When
maintenance is done, remove the hold:

```bash
rm ~/.local/share/timeline/service.hold
```

Timeline restores the service within the next 30s poll, or immediately if you
choose **Restart Service** or relaunch the app after removing the hold. A bare
`launchctl bootout` without the hold self-heals within about 30s by design.
Do not manually `launchctl bootstrap` the bundled plist from the app bundle:
SMAppService-managed plists with `AssociatedBundleIdentifiers` must be submitted
through SMAppService, and manual bootstrap fails with EIO.

## Updating

Updates replace `Timeline.app`; the running service never pulls or builds a git
checkout. For signed downloads, follow [macOS distribution](../operations/macos-distribution.md).
For a source installation, rebuild and install from an updated checkout:

```bash
git pull
bun install --frozen-lockfile
(cd web && bun install --frozen-lockfile)
(cd tools/timeline-app && ./build.sh --install)
```

The product version comes from the root `package.json` and is advanced through
the release process documented in [releases.md](../operations/releases.md). Local builds use
`CFBundleVersion` from `tools/timeline-app/Info.plist`; packaging CI can set the
monotonic numeric `TIMELINE_BUILD_NUMBER` override. Development rebuilds remain
distinguishable by the source commit shown in the web app's **Settings → Version & build**.

The installer creates the maintenance hold, stops the service before replacing
the bundle, retains `~/Applications/Timeline.app.previous`, clears the hold,
and launches the new app. The web app's **Settings** page reports the running
release, build, and source commit without contacting a git remote.

## Troubleshooting

If a newly installed bundle cannot start, stop the service under a maintenance
hold, restore the previous app, then relaunch it:

```bash
touch ~/.local/share/timeline/service.hold
launchctl bootout gui/$(id -u)/dev.incognitojam.timeline-service 2>/dev/null || true
osascript -e 'tell application id "com.incognitojam.timeline" to quit'
mv ~/Applications/Timeline.app ~/Applications/Timeline.app.failed
mv ~/Applications/Timeline.app.previous ~/Applications/Timeline.app
rm ~/.local/share/timeline/service.hold
open ~/Applications/Timeline.app
```

If you need to roll back after the app migrates an older user LaunchAgent, the
renamed `.migrated` plist is the safety net. Quit Timeline, disable or remove
Timeline in System Settings -> General -> Login Items, then restore and load the
old plist:

```bash
launchctl bootout gui/$(id -u)/dev.incognitojam.timeline-service 2>/dev/null || true
mv ~/Library/LaunchAgents/dev.incognitojam.timeline-service.plist.migrated \
  ~/Library/LaunchAgents/dev.incognitojam.timeline-service.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.incognitojam.timeline-service.plist
```
