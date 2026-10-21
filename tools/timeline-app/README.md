# Timeline menu bar app

A small macOS menu bar app for the Timeline project. It controls and monitors
the Timeline service and screen **recall** capture from the menu bar.

## What it does

The app owns and surfaces the Timeline service and recall capture jobs:

- `./build.sh` embeds the service runtime, web frontend, Bun, native runtime
  libraries, the Tailscale launcher, and rendered LaunchAgent plists in
  `Timeline.app`. The LaunchAgents use bundle-relative program paths;
  the source checkout is not used at runtime. `./build.sh --install` replaces
  `~/Applications/Timeline.app` while the service is held and stopped, keeps
  the previous bundle at `~/Applications/Timeline.app.previous`, and relaunches
  the app.
- When launched from `~/Applications/Timeline.app` or `/Applications/Timeline.app`, the app registers the
  bundled agents with `SMAppService.agent(plistName:)`. Build-directory launches
  do not register anything and show `Service agent: run installed app to manage`.
- Install one copy in an Applications folder. `./build.sh --install` continues
  to use `~/Applications/Timeline.app`; DMG installs can use `/Applications`.
- If SMAppService reports the agent as enabled but launchd no longer has the job
  loaded, the app reloads the registration by unregistering and registering the
  bundled agent again. A maintenance hold file at
  `~/.local/share/timeline/service.hold` disables migration, registration,
  self-heal, and Restart Service kickstarts while it exists.
- If launchd has the bundled agent loaded but macOS did not persist the
  SMAppService background-item record, the app shows
  `Service agent: session-only registration`. This can happen with a self-signed
  app; the already-loaded bundled service is left alone.
- If the legacy plist exists at
  `~/Library/LaunchAgents/dev.incognitojam.timeline-service.plist`, the app boots
  out the old job if loaded, renames the plist to `<name>.plist.migrated`, then
  registers the bundled agent. The `.migrated` file is kept as the rollback
  safety net, and migration is skipped once that legacy file is gone.
- If macOS requires approval for the background item, the menu shows an item
  that opens System Settings -> General -> Login Items.
- **Service: running / not responding** is checked with `GET /api/health` on the
  configured service URL every 30s, and again after wake or app activation. The
  menu shows the service release version, or its source commit for a checkout.
  Detailed build information is in the web app's **Settings → Version & build**.
- **Open Timeline** opens the service base URL in the default browser.
- **Restart Service** runs
  `launchctl kickstart -k gui/<uid>/dev.incognitojam.timeline-service` unless
  the maintenance hold is active, then re-checks health every few seconds until
  it comes back or the restart window expires. If kickstart fails, the app
  requests the same guarded service-agent reconcile used by the background poll.
- Updates are app replacements rather than mutations of a live checkout. Update a development installation by
  pulling/building in any checkout and running `./build.sh --install` again.
  The web Settings page reports the running release/build/commit but does not offer
  a git-based update check.
- The service URL is read once at launch from `[server]` in
  `~/.config/timeline/config.toml`, or `$TIMELINE_CONFIG` when set. Missing
  config, host, port, or an invalid endpoint falls back to
  `http://127.0.0.1:3001`; wildcard bind hosts `0.0.0.0` and `::` are opened
  as `127.0.0.1`.

Recall runs inside Timeline.app; **quitting the app stops recording**. Enable
**Launch at Login** to resume after signing in. Setup and migration are described
in [Recall setup](../../docs/recall-setup.md).

- **Record Screen** requests Screen Recording permission for Timeline and toggles
  the existing pause flag. The menu opens the permission settings when needed.
- Capture and OCR run off the UI thread. Pausing or sleeping cancels the active
  tick, and ticks never overlap.
- The menu icon and last-capture age reflect capture health. Permission, migration,
  and capture failures appear in the menu.
- The app unregisters the previous Recall job before recording. An inert bundled
  Recall plist remains solely to let `SMAppService` unregister that identity; it
  has no schedule and its launcher does nothing.

## Build & run

```bash
cd tools/timeline-app
./build.sh --install
```

Use the **Launch at Login** menu toggle to keep it running across reboots. If
macOS requires approval, the menu shows an item that opens System Settings →
General → Login Items.

For a build-only local bundle, run `./build.sh` without `--install`; it still
writes `Timeline.app` in this directory.
Set `TIMELINE_CODESIGN_IDENTITY=-` to force ad-hoc signing for build-only CI.
The product version comes from the repository root `package.json`. Local builds
use `CFBundleVersion` from `Info.plist`; packaging CI can set the monotonic
numeric `TIMELINE_BUILD_NUMBER` override. Local builds sign the app and its agent launcher. Distribution packaging also
re-signs the embedded runtime and native libraries.

## Verifying

After a build, `./smoke.sh` validates the plists/signature, copies the app to a
temporary directory, and boots the copied packaged service with a minimal
`PATH` and no checkout-relative working directory.

The smoke checks exercise Recall publication, cancellation, retention, and legacy
agent retirement with synthetic data, without requesting screen access. When
`cwebp` is installed they also exercise real WebP encoding.

The recall health logic lives in `RecallLog.swift`, and the service config
parser lives in `TimelineServiceConfig.swift`. Both are kept free of
SwiftUI/AppKit so they can be exercised directly with small Swift drivers
against synthetic input (the config parser also needs the Foundation-only
`Subprocess.swift` for `writeError`).

## Signed DMG releases

See [macOS distribution](../../docs/macos-distribution.md) for CI signing secrets,
notarization, installation, and the remaining external-tool requirements.
