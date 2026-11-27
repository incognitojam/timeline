# Running Timeline on macOS (launchd)

Run the Timeline service as a background process on your Mac, managed by the
Timeline menu bar app through a per-user launchd **LaunchAgent**. It runs
the service packaged inside `Timeline.app` (API + scheduler + inbox watcher),
supervised by the OS so it starts at login and restarts on crash.

## Prerequisites

- The repository's pinned Bun on your `PATH` to build the app; see
  [Toolchain](../operations/development.md#toolchain). The installed service
  carries its own copy of that runtime.
- The pinned Go compiler (`mise install go`) to build the bundled Google Messages sidecar. Build with `mise exec -- tools/timeline-app/build.sh` from the repository root if mise is not activated. Go is not needed to run an installed app.
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
from the web UI's Sync page. Sources with no saved settings, such as ones added
by an update, are listed under **Not set up** there; turning one on from its
page saves its settings and moves it to the main list. `config.toml` `[sync.*]`
sections left behind are ignored and logged as a warning until removed.

## Secrets

API tokens and any env overrides go in `~/.config/timeline/env`. Timeline entry
points load this file before service modules open configuration or databases:

```sh
# ~/.config/timeline/env
AUTH_PASSWORD=choose-a-password
# Optional, the older way to allow MCP clients; see mcp.md for managed tokens.
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

### Local media cache limit

Set `[media].cache_limit_gib` in `config.toml` and enable the `media-evict` sync source to bound local media storage; eviction requires R2 to be enabled. Leaving the limit unset keeps the cache unbounded.

Eviction starts only when the cache exceeds the limit, then removes the oldest locally cached media confirmed durable in R2 until usage reaches 90% of the limit. For example, a 25 GiB limit targets 22.5 GiB after crossing 25 GiB. Whole blobs are removed, so the cache may finish below that target. If there are not enough durable blobs, eviction keeps the remaining local copies and reports the shortfall.

This leaves headroom for new media instead of evicting a small batch on every sync. Compared with trimming only to the limit, this moves up to an additional 10% of the configured capacity's oldest media offsite (plus the final whole blob). This is extra offsite media, not a cap on the total stored in R2; opening evicted media restores it on demand. Under-limit scheduled runs use a quick size estimate between full inventories, with full reconciliation on the first run after six hours even if the estimate stays below the limit.

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

## Remote access (tailnet only)

Timeline can serve the local service to your own tailnet at a stable
`https://<node>.ts.net` URL via [Tailscale Serve](https://tailscale.com/kb/1312/serve).
Only devices on your tailnet can reach it, unless you turn on
[public access](#public-access) for a limited time.
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
browser that opens, and the menu switches to "Remote Access: tailnet only" with
a **Copy URL** button and a **Remote Access** submenu that shows the node's DNS
name. The app never re-runs
login on its own (that would regenerate the node key and orphan a pending
authorization); login is always a button click.

- **State directory:** `~/.local/share/timeline/tailscale/` — daemon state,
  socket (`tailscaled.sock`). **Login and serve config persist here**, so a
  daemon restart needs no re-login; the agent just keeps `tailscaled` alive
  (`KeepAlive`).
- **Socket:** every `tailscale` CLI call for this node must pass
  `--socket=~/.local/share/timeline/tailscale/tailscaled.sock`, or the CLI talks
  to the GUI Tailscale.app instead.
- **Serve config:** while the node is running, the app checks its serve config
  regularly and on wake. It serves HTTPS on port 443 as a reverse proxy to
  the service port from your `config.toml` `[server]` block (default `3001`),
  which is the form that adds Tailscale's identity headers, such as
  `Tailscale-User-Login`. If it finds Funnel on for any port, including a config
  left by an older version of the app, it runs `tailscale serve reset` and serves
  to the tailnet again, unless public access is on. Serve config you add to
  this node by hand is removed whenever Funnel is found on or `tailscaled`
  starts. If the app can't confirm the node is tailnet only, the
  menu says so instead of showing the address; turn Remote Access off if that
  persists.
- **Logs:** `~/Library/Logs/timeline/tailscale.log` (and `.error.log`).

**Firewall prompt:** with the macOS firewall on, the first connection from
another device can make macOS ask whether `tailscaled` may accept incoming
network connections. Choose **Allow**: it lets tailnet devices connect directly
to this node instead of through Tailscale's relays, which are
[slower](https://tailscale.com/kb/1257/connection-types). Homebrew's
`tailscaled` is ad-hoc signed, which identifies only that exact build, so the
prompt may appear again after `brew upgrade tailscale`.

**Turn off:** choose **Turn Off Remote Access** in the menu (in the
**Remote Access** submenu once the node is running). This unregisters
the agent (stopping `tailscaled`) but keeps the state directory, so re-enabling
via **Set Up Remote Access…** needs no re-login. The off state is
recorded in `~/.local/share/timeline/tailscale.disabled`.

**Manual takeover:** if you set `tailscaled` up by hand and it's still running
from a shell session, quit that process before the agent can bind the socket —
two daemons can't share it.

### Public access

To let a client outside your tailnet, such as a Claude.ai custom connector,
reach the service's [MCP endpoint](mcp.md#remote-http), choose **Make Public on
the Internet** in the **Remote Access** submenu and a duration: 5 minutes,
1 hour or 1 day. Public requests reach only MCP, with the limits described
there. The app turns on [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)
at the same address, the menu shows "Remote Access: public until" the time it
ends, and the menu bar icon becomes a globe. It goes back to tailnet only when
that time comes, when you choose **Stop Public Access**, when you turn Remote
Access off, when you quit Timeline, and whenever `tailscaled` starts, such as
after the Mac restarts. Each `tailscaled` start resets the node's serve config,
so after a restart the service is not reachable even from the tailnet until
Timeline is running again; enable **Launch at Login** (under **Settings**) to
keep Remote Access available.

The end time is kept in `~/.local/share/timeline/tailscale-public-access`.
Each time the app checks the node, including at launch and on wake, it turns
Funnel off unless that file allows public access at that moment: missing,
unreadable, ended, longer than a day, or starting later than the clock now
reads (the clock moved back) all mean tailnet only. While the app turns Funnel
on, the menu shows "Remote Access: making public…". If Funnel can't be turned
on, the node stays tailnet only, an alert says why, and the menu keeps saying
why until you try again or turn Remote Access off. The app gives
`tailscale funnel` 10 seconds, so it stops waiting for you to allow Funnel after
that.

If the alert and the menu say Funnel is not allowed for this device, the
tailnet policy file doesn't give it the `funnel` node attribute (or HTTPS
certificates are off for the tailnet). There is no Funnel switch on the
device's Machines page. When Tailscale printed a link for allowing it, the
alert and the menu offer **Enable Funnel in Tailscale…**. To do it yourself, an Owner,
Admin or Network admin opens **Access controls** in the
[admin console](https://console.tailscale.com/admin/acls) and adds a `nodeAttrs`
entry, either with **Add Funnel to policy** in its Funnel section or by hand:

```jsonc
"nodeAttrs": [
  {
    "target": ["autogroup:member"],
    "attr": ["funnel"],
  },
],
```

`autogroup:member` lets every member's devices use Funnel; narrow `target` to a
user such as `alice@example.com` or a tag to limit it. Then choose a duration
again. See [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) for the
other requirements.

If Timeline is force-quit or crashes while the service is public and
`tailscaled` keeps running, or is quit within a second or two of choosing
**Make Public on the Internet**, Funnel can stay on until Timeline next runs or
`tailscaled` restarts, or until you turn it off with
`tailscale --socket=~/.local/share/timeline/tailscale/tailscaled.sock serve reset`.

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
choose **Restart Service** (in the menu while the service is down, otherwise
under **Settings**) or relaunch the app after removing the hold. A bare
`launchctl bootout` without the hold self-heals within about 30s by design.
Do not manually `launchctl bootstrap` the bundled plist from the app bundle:
SMAppService-managed plists with `AssociatedBundleIdentifiers` must be submitted
through SMAppService, and manual bootstrap fails with EIO.

## Rebuilding the people index

`event_people` lists, for each event, the people it is filed under. A build
that changes which people that is, such as the one that files a group message
under its sender only, applies the change to new events at once and leaves
rows written under the old rule in place until the table is rebuilt.
`verify-event-people` reports those rows as `REBUILD NEEDED`. The rebuild
derives the table again from `events.people`; it changes no event.

The command blocks below are meant to be pasted whole into a terminal. They
contain no comments, because interactive zsh does not treat `#` as one.

### Before you start

The scripts run from a checkout at the commit of the installed build, shown in
the web app's **Settings → Version & build**. The packaged service does not
carry them, and they write the same trigger definitions as the service: a
checkout at an older commit would put the old triggers back. After installing
a build, never point an older build or checkout at the database.

First set two variables by hand: `DB` to the database's path (`[database].path`
in `~/.config/timeline/config.toml`, by default the path below) and `COMMIT`
to the commit Settings shows, for example `COMMIT=abc1234`. Then, in any
checkout:

```bash
DB="$HOME/.local/share/timeline/timeline.db"
cd ~/src/timeline
git fetch origin
git checkout --detach "${COMMIT:?}"
bun install --frozen-lockfile
```

Every command below uses `"${DB:?}"`, so it stops if `DB` is unset instead of
falling back to a `timeline.db` in the checkout. The scripts load the SQLite
library named by `TIMELINE_SQLITE_LIBRARY_PATH` in `~/.config/timeline/env`,
as the service does, and refuse a SQLite older than they need. They print the
database path, its event count, and the SQLite version with the library it
came from. Check those lines before going further: the `SQLite:` line names
the library `grep TIMELINE_SQLITE_LIBRARY_PATH ~/.config/timeline/env` shows,
or Bun's default library if the env file sets none. Compare the `Events:` line
with the event count on the status page.

**Measured.** A rehearsal on a copy of a database with 3,433,720 events, whose
table went from 45,909,346 rows to 3,397,044, gave the figures the steps below
refer to:

- the check before the rebuild took 888 seconds (about 15 minutes);
- the rebuild and the check after it took 867 seconds (about 14.5 minutes);
- the WAL peaked at 1.07 GB, 316 bytes per new row;
- free space dipped by about 4 GB;
- the database file stayed the same size.

**Space.** The WAL holds every page the rebuild writes, and the index sorts
write temporary files in `TMPDIR` on the same volume; together they made the
measured dip. The file does not grow, because the rebuild reuses the old
table's space inside it. APFS local snapshots can pin overwritten blocks and
take more; list them with `tmutil listlocalsnapshots /`. The scripts report
the WAL's peak but not the temporary files, so to see the true lowest free
space, watch it from a second terminal while a step runs:

```bash
while sleep 5; do df -k "${DB:?}" | tail -n 1; done
```

`timeline.db` stays the same size on disk. The space the old rows used is free
inside the file and reused by later writes; it is not returned to the volume.

### Rehearse on a copy

Rehearse on a copy-on-write clone in the same volume, with the service still
running. The clone shares blocks with the database until it is written, and
the rehearsal writes 2–3 GB into it. The script is run with `TIMELINE_DB_PATH`
set to the copy: that only keeps a checkout's `.no-local-db` marker (left by
`bun run setup` when no local database was prepared) from stopping it with an
unrelated error, since the script opens nothing but the copy.

```bash
df -h "${DB:?}"
mkdir ~/timeline-rehearsal
cp -c "${DB:?}" ~/timeline-rehearsal/timeline.db
TIMELINE_DB_PATH="$HOME/timeline-rehearsal/timeline.db" bun run src/scripts/rehearse-event-people-rebuild.ts "$HOME/timeline-rehearsal/timeline.db" | tee ~/rehearsal-report.txt
rm -r ~/timeline-rehearsal
```

The clone omits the live WAL, so it can lack the last few MB of writes, and a
clone taken while the service checkpoints can be torn. If the rehearsal stops
on drift, make a fresh copy and rehearse once more before investigating.

The script finds the live database the way the service does, from the env
file and the config it names. It refuses a copy in that database's directory,
a copy whose database, `-wal` or `-shm` is the same file as one of the live
database's (by device and inode, through symlinks), and a copy with a
symlinked `-wal` or `-shm`. It cannot recognise the same file reached through
another mount, such as a network share of the data volume, so make the copy
with `cp -c` as shown.

It stops without changing the copy if the copy has no events or has drift.
Otherwise it installs this build's triggers, rebuilds, verifies and truncates
the WAL, printing one JSON line per step with counts, sizes and timings only,
never names or content. It ends with a summary and exits non-zero if anything
fails. The rehearsal passes when every line of the summary says `PASS`:

- the copy has events, and member rows from before the rule for the rebuild to
  drop;
- no drift before the rebuild, and every check clean after it, with no member
  rows from before the rule left;
- the WAL's peak within 400 bytes per new row;
- the WAL's peak plus 900 bytes per new row for writes outside the WAL (the
  index sorts' temporary files and the copy's copy-on-write) within the 10 GB
  free-space floor below.

Both per-row figures sit a little above the measured ones.

The `DECIDE` line points at the figures the decision rests on, in the `after`
step: `eventsNoLongerHiddenBySource`, the events per source that hiding a
contact will no longer hide, and `identitiesNowWithoutEvents`.

### Rebuild

The first two steps run with the service up; if either stops you, nothing has
changed and nothing is held.

1. **Free space.** `df -h "${DB:?}"` must show at least 10 GB available. Stop
   if less is free.

2. **Backup.** On the web app's Sync page, open the `backup` source and run it.
   It writes `timeline-<date>T<time>.db` to the directory set as its
   destination in that source's settings, normally on the NAS, and keeps only
   the most recent copies, so this one will be pruned by later runs. Set
   `BACKUP_DIR` to that destination and `KEEP_DIR` to a directory outside it
   with room for a copy as large as `timeline.db`, for example a folder beside
   it on the NAS. When the run has succeeded, keep the newest copy and check
   it opens and counts the events the status page shows (this reads the whole
   file, so it takes a while on a NAS):

   ```bash
   BACKUP="${BACKUP_DIR:?}/$(ls -t "${BACKUP_DIR:?}" | grep -E '^timeline-.+[.]db$' | head -n 1)"
   cp "${BACKUP:?}" "${KEEP_DIR:?}/"
   BACKUP="${KEEP_DIR:?}/$(basename "${BACKUP:?}")"
   BACKUP="${BACKUP:?}" bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.env.BACKUP, { readonly: true }); console.log(db.query("PRAGMA quick_check").get(), db.query("SELECT COUNT(*) AS events FROM events").get())'
   ```

   Stop unless it prints `quick_check: "ok"` and the expected event count.
   Keep `BACKUP` set for the restore below.

3. **Hold the service** as in [Stopping the service for
   maintenance](#stopping-the-service-for-maintenance), and confirm it is down:

   ```bash
   touch ~/.local/share/timeline/service.hold
   launchctl bootout gui/$(id -u)/dev.incognitojam.timeline-service
   curl -s http://127.0.0.1:3001/api/health || echo "stopped"
   ```

   From here, releasing the hold means `rm ~/.local/share/timeline/service.hold`;
   the service answers again within about 30 seconds.

4. **Verify and rebuild.** One command checks the table, stops if it finds
   drift, and otherwise rebuilds it and checks the result:

   ```bash
   TIMELINE_DB_PATH="${DB:?}" bun run src/scripts/verify-event-people.ts --force-rebuild --verbose
   echo "exit $?"
   ```

   It prints the `Database:`, `Events:` and `SQLite:` lines first; check them,
   and stop it with Ctrl-C if one is wrong. Then it checks the table inside one
   read transaction, which is why the service is held, and shows four `PASS`
   lines and a `REBUILD NEEDED` line counting the old rows. If the check finds
   drift, it prints samples of it (`--verbose` costs nothing otherwise) and
   `NOT REBUILDING`, and exits 1 before changing the table. Otherwise it prints
   `Rebuilding in one transaction...` and rebuilds, printing nothing more until
   `Rebuild committed: … Verifying...`: most of that stretch is SQLite reading
   every page of the old table to free it, so a long silence is expected. Then
   it checks the new, much smaller table.

   The check and the rebuild take the measured times above, so the service is
   held for about 30 minutes in all.

   - **Exit 0, `REBUILD COMMITTED AND VERIFIED`:** continue.
   - **Exit 1, `NOT REBUILDING`:** the check found drift the rule change does
     not explain, and the table has not changed. Release the hold, read the
     samples printed above it (which check failed, and for which events), and
     find the cause before anything else. Repairing real drift is
     `--rebuild`'s job once it is understood: it checks again and rebuilds the
     whole table, under the hold, as in this step.
   - **Exit 1 otherwise:** it stopped before the rebuild began, so the table
     has not changed: the database is missing or has no events, its SQLite is
     too old, or an error came first. Release the hold, check `DB`, and report
     any error. This build's schema may already be installed, which the
     service does at start anyway.
   - **Exit 2, `REBUILD FAILED AND ROLLED BACK`:** the old table is intact; a
     full disk ends here too. Truncate the WAL (step 5), release the hold
     (step 6), and report the error.
   - **Exit 3, `REBUILD COMMITTED, BUT VERIFYING IT …`:** the new table is in
     place but not shown clean. Keep the hold, so nothing writes to it, and
     check it again:

     ```bash
     TIMELINE_DB_PATH="${DB:?}" bun run src/scripts/verify-event-people.ts
     ```

     If it passes with no `REBUILD NEEDED` line, continue. If not, either
     rebuild again (`--rebuild` rather than `--force-rebuild` if it reports
     drift) or restore the backup (below), then release the hold.
   - **Stopped (Ctrl-C, a power loss, exit 130, or no exit line):** go by the
     last line it printed. Before `Rebuilding in one transaction...`, nothing
     has changed: release the hold. After it but before `Rebuild committed`,
     the rebuild never committed and the old table is intact: as exit 2. After
     `Rebuild committed`, the new table is in place, unverified: as exit 3. If
     you can't tell, keep the hold and run the check above without flags: a
     `REBUILD NEEDED` line means the old table is intact (as exit 2), and none
     means the new table is in place (as exit 3).

5. **Truncate the WAL**, after any rebuild that started, whether it committed
   or rolled back; otherwise the WAL keeps its peak size:

   ```bash
   DB="${DB:?}" bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.env.DB); console.log(db.query("PRAGMA wal_checkpoint(TRUNCATE)").get())'
   ls -l "${DB:?}-wal"
   ```

   Expect `busy: 0`, and a WAL of 0 bytes or no such file: SQLite removes it
   when the last connection closes.

6. **Release the hold.** The service takes up to about 30 seconds to answer:

   ```bash
   rm ~/.local/share/timeline/service.hold
   sleep 30
   curl -s http://127.0.0.1:3001/api/health
   ```

Afterwards, check `/status` is healthy and `service.error.log` is quiet, and
open a contact who belongs to large group chats: their counts drop to the
messages they sent, their Conversations list shows the groups they wrote in,
and the unlinked-people list loses group members who never wrote.

### The way back

The rebuild changes only derived rows. A failed rebuild has already rolled
back, and a committed one that looks wrong can be derived again by a corrected
build's `--force-rebuild`, or `--rebuild` if its check finds drift. Rebuilding
under the old rule in place needs WAL space as large as the old table, so it
may not fit. To return to the state
before the rebuild, or if `PRAGMA quick_check` ever fails, restore the copy
kept in step 2. Events synced after the backup was taken and before the hold
are lost, and later syncs may not fetch them again, because the sync state in
`app-state.db` has already moved past them.

First confirm the kept copy is there, with `BACKUP` set as in step 2:

```bash
ls -l "${BACKUP:?}"
```

Go on only if it lists the file. Then hold the service:

```bash
touch ~/.local/share/timeline/service.hold
launchctl bootout gui/$(id -u)/dev.incognitojam.timeline-service
```

Move the current database aside (to `~/timeline-before-restore`, or to the
NAS if the volume lacks room for both), copy the backup in and release the
hold. Each command runs only if the one before it succeeded, so a failure
leaves the service held and the moved files where they are; `mkdir` fails if
`~/timeline-before-restore` is left over from an earlier restore.

```bash
mkdir ~/timeline-before-restore &&
  mv "${DB:?}" ~/timeline-before-restore/ &&
  { if test -e "${DB:?}-wal"; then mv "${DB:?}-wal" ~/timeline-before-restore/; fi; } &&
  { if test -e "${DB:?}-shm"; then mv "${DB:?}-shm" ~/timeline-before-restore/; fi; } &&
  cp "${BACKUP:?}" "${DB:?}" &&
  rm ~/.local/share/timeline/service.hold &&
  echo "restored and released"
```

If it printed `restored and released`, the service answers within about 30
seconds:

```bash
curl -s http://127.0.0.1:3001/api/health
```

Keep `~/timeline-before-restore` until the restored service checks out, then
remove it.

## Updating

Every installed build checks for updates automatically and offers **Check for Updates…** in the menu's **Settings** submenu. Installation asks for confirmation unless you opt into automatic downloads. **Install Update and Relaunch…** resumes a staged update. Any normal quit while an update is staged first holds and stops the service. Quitting from the menu while the ready-to-install window is open, or after choosing **Install on Quit** when offered, leaves the service stopped until Timeline is opened again; opening the app recovers its update hold. A manual maintenance hold refuses the update and stays in place.

Updates replace `Timeline.app`; the running service never pulls or builds a git
checkout. For signed downloads, follow [macOS distribution](../operations/macos-distribution.md).
For a source installation, rebuild and install from an updated checkout:

```bash
git pull
bun install --frozen-lockfile
(cd web && bun install --frozen-lockfile)
(cd tools/timeline-app && ./build.sh --install)
```

Google Messages updates with the app. Its pairing state stays in `~/.local/share/timeline-gmessages`; an old standalone executable there is left untouched. With no binary override, sync automatically uses the bundled copy. If **Sidecar binary** has an explicit old path, choose **Use default** and save in the sync dashboard. No re-pair is needed; see [Google Messages setup](source-setup.md#google-messages-setup).

The product version comes from the root `package.json` and is advanced through
the release process documented in [releases.md](../operations/releases.md). Local app and
service builds use the same build-number script as packaging CI; use a full-history
checkout and see [build numbering](../operations/releases.md) for the override.
A branch ahead of `main` can out-number the next
release, delaying update offers until a release has a higher build number.
Development rebuilds remain distinguishable by the source commit shown in the web
app's **Settings → Version & build**.

The installer creates the maintenance hold, stops the service before replacing
the bundle, retains `~/Applications/Timeline.app.previous`, clears the hold,
and launches the new app. The web app's **Settings** page reports the running
release, build, and source commit without contacting a git remote.

Sparkle replaces the whole app while preserving configuration, databases, media, and capture preferences. If automatic downloads are opted in, Timeline installs and relaunches as soon as the update is ready. If relaunch fails, the service remains held until Timeline is opened again. Sparkle does not retain `Timeline.app.previous` and does not offer downgrades: rollback requires manually installing an older DMG under the maintenance-hold procedure, then reopening Timeline to recover its update hold. Moving from a self-signed source build to Developer ID may require approving Screen Recording and Login Items again.

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
