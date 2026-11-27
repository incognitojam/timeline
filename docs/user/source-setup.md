# Data sources

| Source | Data | Import |
|--------|------|--------|
| Facebook | Messages, posts | File export |
| Instagram | Messages | File export |
| Discord | DMs, group chats, servers | API sync |
| Skype | Messages | File export |
| LinkedIn | Messages, connections | File export |
| Google Chat | Messages | Takeout |
| Google Messages | SMS, MMS, RCS | Live sync |
| SMS/Calls | Texts, call logs (stored as source `phone`) | SMS Backup & Restore app |
| Reddit | Posts, comments, messages | File export |
| Spotify | Listening history | File export + API sync |
| Spotify Friends | Friends' activity | API sync (unofficial) |
| Trakt | Watch history | API sync |
| YouTube | Watch history, likes, searches | Takeout |
| Steam | Games, playtime, achievements | API sync |
| Google Search | Searches and visited results | Takeout |
| Chrome | Browsing history | Takeout |
| Google Play Store | App installs | Takeout |
| Google Calendar | Events | Takeout |
| Google Keep | Notes | Takeout |
| Google Location | Place visits, transit (both stored as source `google-location`) | Takeout / Timeline.json |
| Swarm | Check-ins | API sync |
| Google Fit | Activity | Takeout |
| Fitbit | Sleep, readiness, stress, HRV | Takeout |
| Google Health | Sleep, HRV, heart rate, SpO2, activity, weight | API sync |
| Thriva | Blood test biomarkers | API sync |
| Monzo | Transactions | API sync |
| Amex | Transactions | CSV export |
| GitHub | Issues, PRs, comments, reviews, stars, forks | API sync / export |
| WakaTime | Coding sessions | API sync / export |
| Claude, ChatGPT | Chat history | File export |
| Claude Code, Codex, OpenCode, Conductor, T3 Code | Agent sessions | Local files |
| Remote agents | Claude Code and Codex sessions from another machine | SSH pull |
| Amp | Agent sessions | API sync |
| Minecraft | Chat, joins, advancements | Server logs |
| MacBook screen recall | OCR'd screen captures | Timeline.app |

File exports are imported by dropping them into an inbox directory configured under `[inbox.sources.*]` in `config.toml` (see [`deploy/macos/config.toml.example`](../../deploy/macos/config.toml.example)), or by running a parser directly from a checkout: `bun run src/platforms/<platform>/parser.ts`. API and local-file sources sync on the schedule set on the web app's **Sync** page. The sections below cover sources that need credentials or extra setup.

### Upload from a tailnet device

Enable the inbox watcher, configure `[inbox].archive_path`, and give the source an existing dedicated local directory, a fixed account and a token-eligible parser that uses that account. Use a local source outside every other configured source directory and a fresh filename for each export. Restart the service after changing inbox configuration. Create a token on the service host and store its one-time output on the uploading device:

```sh
timeline-service upload-token create --label test-phone --source calls --tailnet-login phone@example.com
timeline-service upload-token list
timeline-service upload-token revoke test-phone
```

Repeat `--source` for additional sources. Before revocation, use the token in the Authorization header (here `TIMELINE_URL` is the host’s tailnet HTTPS URL):

```sh
curl --fail -H "Authorization: Bearer ${UPLOAD_TOKEN}" "${TIMELINE_URL}/api/upload/whoami"
curl --fail -H "Authorization: Bearer ${UPLOAD_TOKEN}" -F source=calls -F file=@calls.xml "${TIMELINE_URL}/api/inbox/upload"
```

Uploads must match the source’s filename patterns. Each request is limited to 5 MiB and each token to 120 requests per hour. The service trusts the pinned login header only from loopback, where Tailscale Serve is the expected proxy. Public Funnel requests and tagged devices have no identity header and are refused. A local process holding a token can forge the header, which is accepted because the service host is trusted with the databases.

## Credentials and settings

Most API source credentials live in `~/.config/timeline/`. Exceptions: WakaTime uses `~/.wakatime.cfg`, Trakt supports env vars. All OAuth2 sources use redirect URI `http://127.0.0.1:8742/callback`.

Sync schedules and per-source settings live in `app-state.db` and, where the
source exposes editable fields, are managed from the web app's **Sync** page.
The `[sync.*]` TOML examples below are only for bootstrapping a new installation:
the service imports them when `sync_sources` is empty, then ignores any remaining
TOML source sections. Remove those sections after checking the imported settings.

## Discord Setup

Discord syncs messages directly via the Discord API (user token). DMs and group chats are discovered automatically; guild channels require explicit configuration.

1. Get your Discord user token (from browser DevTools or Discord client)
2. Set the `DISCORD_TOKEN` environment variable in `~/.config/timeline/env`
3. Before the first service startup, bootstrap guild settings in `config.toml`.
   Discord's nested guild settings are not exposed by the generic Sync settings
   editor:
   ```toml
   [sync.discord]
   interval = "30m"

   [sync.discord.guilds.GUILD_ID]
   name = "Friend Server"
   mode = "full"          # sync all messages

   [sync.discord.guilds.GUILD_ID_2]
   name = "Large Community"
   mode = "sparse"        # only your messages + context
   ```
4. Bootstrap sync state from existing data (optional, for migration):
   ```bash
   bun run src/platforms/discord/scripts/bootstrap-state.ts
   ```
5. Generate guild config from discord-chat DB (optional, for migration):
   ```bash
   bun run src/platforms/discord/scripts/generate-config.ts
   ```

**Guild modes:**
- `full` - Fetches all messages in all channels and threads. Best for small friend servers.
- `sparse` - Only fetches your messages + surrounding context. Best for large community servers.
- `skip_discovery = true` - Skip thread discovery for guilds where you don't care about threads.

**Data synced:**
- DM and group messages (auto-discovered)
- Guild text channels and threads (configured guilds only)
- Attachments downloaded with fresh CDN URLs
- Reactions with user info
- Incremental sync via per-channel snowflake cursors

**DM pass (`discord-dms`):** Off until you open **Discord DMs** on the Sync page, turn on automatic sync and save. Every 2 minutes by default (edit its interval there), it lists your DMs and fetches only the DMs and group DMs with messages past their cursor, so a quiet pass is one request. It runs beside other syncs rather than queuing behind them, but waits for the current one to finish before storing what it fetched. It starts after the first full Discord sync, skips its turn while a full Discord sync runs, and after an error or a rate limit waits twice its interval, doubling up to 30 minutes. Everything else, including servers, hidden DMs and reaction updates, stays with the full sync. Quiet passes show as one deferred row an hour in the sync history.

**Account name:** Auto-detected from the Discord API on first sync (uses your Discord username). No manual configuration needed.

**Sync state:** Stored under `discord-api` key in app-state.db. Tracks channel cursors, known DM channels (including hidden/closed ones), sparse guild cursors, and thread discovery progress.

## Amp Setup

Amp syncs threads from the Amp server via the same authenticated API surface used by the Amp CLI. It no longer depends on local thread files.

1. Get an Amp API key from a logged-in development machine. The CLI stores it in `~/.local/share/amp/secrets.json` under the `apiKey@https://ampcode.com/` key.
2. Put the key on the Timeline machine, either as `AMP_API_KEY` in the service environment or in a copied secrets file readable by the `timeline` user.
3. Open **Sync → Amp** in the web app, set **Import mode** to `api`, optionally
   set a stable account name or secrets-file path, choose an interval, and enable
   the source.

**Data synced:**
- User and assistant messages
- Tool calls/results, thinking blocks, image and compaction-summary blocks in `raw_data`
- Workspace/project metadata when present

**Incremental sync:** The source lists thread summaries, fetches changed threads, and stores thread fingerprints in `app-state.db` under the `amp` sync state key.

## Remote agents Setup

The **Remote agents** source pulls Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`) logs from another machine over SSH and imports them with the same parsers as the local sources. It uses rsync on both machines and bubblewrap (`bwrap`) on the remote one, which must be Linux.

1. On the remote machine, install the forced-command wrapper: `install -m 755 tools/timeline-export/timeline-export ~/.local/bin/timeline-export`.
2. In the web app, open **Sync → Remote Agents**, set **SSH target** (`user@host`), an **Account** such as `alice@host`, and save. The account is your usual identity plus the machine name, so its sessions stay distinct from the Timeline host's own (`alice`). Use one account per machine and keep it: it is part of each event's identity, so changing it imports everything again under the new name.
3. Under **SSH connection**, choose **Generate key**. Timeline keeps the private key in `remote-agents/` next to `timeline.db` and shows only the line to append to the remote machine's `~/.ssh/authorized_keys`. That line restricts the key to `timeline-export`, which answers a probe and serves read-only rsync of the allow-listed targets from a sandbox that can see only the target directory.
4. Choose **Test connection**, check the host key fingerprint against the remote machine (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), then **Trust host and test**. Timeline pins the key in its own `known_hosts` and lists the targets the host can serve. If the remote machine's host key later changes, for example after a reinstall, runs fail until you confirm the new fingerprint the same way.
5. Enable the source and choose an interval.

Each run probes the host first. A sleeping or offline host is recorded as a deferred run until the last successful pull is older than **Max staleness (hours)** (24 by default); after that, and for any other problem such as a missing or refused key, an untrusted host key, or a missing target directory, the run fails. Mirrors live under `remote-agents/mirror/<host>/` and follow deletions on the remote machine; events already imported stay in the database.

## Monzo Setup

Monzo uses OAuth2 (not file exports) and requires special setup:

1. Create an app at https://developers.monzo.com/ with redirect URI `http://127.0.0.1:8742/callback`
2. Run
   `~/Applications/Timeline.app/Contents/Resources/timeline-service/bin/timeline-service monzo auth`
   on the host (or `bun run src/platforms/monzo/parser.ts auth` from a development
   checkout) — enter client ID/secret when prompted, approve in browser + Monzo app
3. **Within 5 minutes**, run sync to get full transaction history (after 5 mins, only last 90 days)

Monzo Flex accounts appear as `uk_monzo_flex` type but individual Flex backing loans have restricted API access.

## Thriva Setup

Thriva uses password authentication to access blood test biomarker results.

1. Create credentials file `~/.config/timeline/thriva.json`:
   ```json
   { "email": "alice@example.com", "password": "your-password" }
   ```
2. Run `bun run src/platforms/thriva/parser.ts` to sync biomarker results
3. Token (JWT) is cached for ~24 hours, auto-refreshes on next sync

Account name is derived automatically from email (e.g., `alice@example.com` → `alice`).

Each biomarker result is stored as a separate event with:
- Title: `Vitamin D: 80 nmol/L ++` (with level indicators: `++` optimal, empty for normal, `!` abnormal, `!!` highly abnormal)
- Tags: biomarker ID, category (e.g., vitamins, lipids, liver), level

Orders are stored as `thriva:order` events with order total and date.

**MCP Tools** (live API queries, not stored data):
- `get_thriva_status` - Subscription status, next scheduled test date
- `get_thriva_orders` - Recent order history

## Google Health Setup

Google Health replaces the Fitbit Web API sync for current health metrics. Existing Fitbit history remains readable, and Fitbit Google Takeout imports still work. VO2 max is not available from Google Health.

1. Enable the Google Health API and create an OAuth client at https://console.cloud.google.com/apis/library/health.googleapis.com with redirect URI `http://127.0.0.1:8742/callback`.
2. Save the client credentials to `~/.config/timeline/google-health.json`:
   ```json
   { "client_id": "YOUR_ID", "client_secret": "YOUR_SECRET" }
   ```
3. Run `TIMELINE_DB_PATH=~/.local/share/timeline/timeline.db bun run src/platforms/google/health/parser.ts auth` to authorize access, then enable Google Health on the Sync page. Point to the service database so the token is stored in its `app-state.db`, rather than the checkout's.

## Trakt Setup

Trakt uses OAuth2 to sync watch history (movies and TV episodes).

1. Create an app at https://trakt.tv/oauth/applications
   - Redirect URI: `http://127.0.0.1:8742/callback`
2. Save credentials to `~/.config/timeline/trakt.json`:
   ```json
   { "client_id": "...", "client_secret": "..." }
   ```
   Alternatively, set `TRAKT_CLIENT_ID` and `TRAKT_CLIENT_SECRET` environment variables.
3. Run `bun run src/platforms/trakt/parser-api.ts auth` - opens browser for OAuth
4. Token auto-refreshes

**Data synced:**
- Movies and TV episodes watched
- Watch history with timestamps

## Swarm (Foursquare) Setup

Swarm uses OAuth2 to sync your Foursquare check-ins as location visits.

1. Create an app in the [Foursquare developer console](https://foursquare.com/developers/apps).
   - Redirect URI: `http://127.0.0.1:8742/callback`
2. Save credentials to `~/.config/timeline/swarm.json`:
   ```json
   { "client_id": "...", "client_secret": "..." }
   ```
3. Run `bun run src/platforms/swarm/parser.ts auth` and complete the OAuth prompt.

**Data synced:**
- Check-ins as `location:visit` events, including venue, coordinates, categories, and optional comments

## Spotify Setup

Spotify uses OAuth2 to sync recently played tracks via the Web API. This supplements manual data exports with live tracking.

1. Create an app at https://developer.spotify.com/dashboard
   - Add redirect URI: `http://127.0.0.1:8742/callback`
2. Create `~/.config/timeline/spotify.json`:
   ```json
   {
     "client_id": "your-client-id",
     "client_secret": "your-client-secret"
   }
   ```
   Note: `client_secret` is optional if using PKCE-only flow.
3. Run `bun run src/platforms/spotify/parser-api.ts auth` - opens browser for OAuth
4. Token auto-refreshes (1-hour access token, long-lived refresh token)

**Data synced:**
- Recently played tracks (up to 50 most recent)
- Track name, artist, album, playback context (playlist/album)

**Limitations (API vs Export):**
- API returns only 50 most recent tracks (no pagination further back)
- No podcasts or audiobooks (music tracks only)
- No playback duration (`ms_played`) or platform info
- No shuffle/skipped/offline status

**Sync strategy:**
Poll frequently (every 30-60 min) to capture plays before they roll off the 50-track limit. Manual exports continue to provide complete history and richer metadata. When an export arrives, it **updates** API-sourced events with full metadata (the export parser uses `ON CONFLICT DO UPDATE`).

**Account detection:**
Account name is auto-detected from your Spotify profile on first sync. No manual configuration needed.

## Spotify Playlist Tracking

Tracks the public follower count (the "saves"/likes number shown in the Spotify UI, i.e. `followers.total`) of specific playlists over time. Reuses the Spotify auth above — no extra credentials. Readings are stored as a daily time series in the `spotify_playlist_observations` table (not the `events` table, since a follower count is a gauge sampled over time rather than a discrete event).

1. Authenticate Spotify (see Spotify Setup above).
2. Before the first service startup, bootstrap the source in `config.toml`,
   listing playlists by ID, `spotify:` URI, or `open.spotify.com` URL. Playlist
   settings are not currently exposed by the generic Sync settings editor:

   ```toml
   [sync.spotify-playlists]
   interval = "12h"
   playlists = ["0123456789ABCDEFGHIJKL"]
   ```

3. (Optional) Backfill history from a manually-kept log. Spotify's API only exposes the *current* count, so historical data must be seeded:

   ```bash
   bun run src/platforms/spotify/scripts/seed-playlist-follows.ts \
     --playlist 0123456789ABCDEFGHIJKL \
     --csv <path-or-google-sheet-url> \
     [--name "Playlist Name"] [--date-col Date] [--count-col Likes] [--dry-run]
   ```

   The CSV needs a date column and a count column. A Google Sheets `/edit` URL is rewritten to a CSV export automatically. Seeded rows are marked `origin = 'seed'`; synced rows are `origin = 'api'`.

Query the series with SQL/MCP, e.g. `SELECT observed_date, follower_count FROM spotify_playlist_observations WHERE playlist_id = '...' ORDER BY observed_date`.

## Spotify Friends Setup

Syncs friends' listening activity using Spotify's unofficial internal API (the listening-activity feed behind the web player's "Listening activity" panel), then looks up track, playlist and profile details through other internal routes.

**Caveats:**
- **Unofficial API** - May break without notice. Spotify's token response states that use of this endpoint isn't permitted under its Developer Terms and Developer Policy; enabling this source is your decision, on your own account.
- **Cookie expires** - Need to re-extract `sp_dc` yearly
- **TOTP rotates** - The web player's TOTP secret and version are not committed;
  update the local config when Spotify changes them
- **Point-in-time** - Only shows what friends are currently/recently playing
- **No history** - Can't backfill past activity

1. Log into https://open.spotify.com
2. Open DevTools (F12) → Application → Cookies → open.spotify.com
3. Copy the value of the `sp_dc` cookie
4. Obtain the current encoded TOTP secret and numeric version used by the
   Spotify web player's token request.
5. Create `~/.config/timeline/spotify-friends.json`:
   ```json
   {
     "sp_dc": "YOUR_SP_DC_COOKIE",
     "totp_secret": "YOUR_CURRENT_TOTP_SECRET",
     "totp_version": 1
   }
   ```
6. Run `bun run src/platforms/spotify/parser-friends.ts status` to verify
7. Run `bun run src/platforms/spotify/parser-friends.ts` to sync

**Data stored:**
- Event type: `listen:track:friend`
- `source`: `spotify-friends`
- `source_account`: Friend's Spotify username (from URI)
- `people`: `spotify:<username>` (from URI)
- `tags`: `album:<name>`, `artist:<name>`, plus `playlist:<name>`/`album:<name>`/`artist:<name>`/`context:<name>` from playback context
- `raw_data`: The feed entry as returned (`listeningActivity`) with the looked-up `user` and `track` details. Listens stored before the feed change have the older buddylist shape, without `listeningActivity` or `track.durationMs`

## Google Places Setup

Google Places resolves Place IDs (from Google Timeline exports) to human-readable names.

1. Enable the **Places API (New)** in [Google Cloud Console](https://console.cloud.google.com/apis/library/places.googleapis.com)
2. Create an API key at https://console.cloud.google.com/apis/credentials
3. Restrict the key to "Places API (New)" only
4. Set the `GOOGLE_PLACES_API_KEY` environment variable in `~/.config/timeline/env`

**Cost**: ~$0.017/request (Basic fields). Google provides $200/month free credit. Resolved places are cached in the `places` table — each Place ID is only fetched once.

**Data resolved**: Place name, formatted address, latitude/longitude.

**Standalone usage**:
```bash
bun run src/platforms/google/places/resolve.ts --dry-run     # Preview unresolved count
bun run src/platforms/google/places/resolve.ts --verbose      # Resolve all, showing each
bun run src/platforms/google/places/resolve.ts --limit 50     # Resolve first 50 only
```

## GitHub Setup

GitHub uses a Personal Access Token (PAT) to access activity via the API. This syncs issues, PRs, comments, and reviews.

1. Create a PAT at https://github.com/settings/tokens
   - Classic token with `repo` scope, or fine-grained with repository access
2. Save credentials to `~/.config/timeline/github.json`:
   ```json
   {
     "token": "ghp_...",
     "username": "your-username",
     "token_expires": "2025-12-31"
   }
   ```
3. Run `bun run src/platforms/github/parser-api.ts` to sync

**Data synced:**
- Issues you created
- Pull requests you created
- Issue comments
- PR reviews and review comments
- Commit comments

The `token_expires` field is optional but recommended for tracking PAT expiration.

Exports and API sync name pull requests differently: GitHub export files write `github:pull_request`, while API sync writes `github:pr`. Filter on both to see all of them.

## WakaTime Setup

WakaTime/Wakapi uses the standard config file at `~/.wakatime.cfg` to access coding activity.

1. Ensure your editor plugins are configured and sending heartbeats
2. For WakaTime.com: Get API key from https://wakatime.com/settings/api-key
3. For Wakapi (self-hosted): Get API key from your Wakapi settings
4. Your `~/.wakatime.cfg` should contain:
   ```ini
   [settings]
   api_url = https://api.wakatime.com/api/v1  # or your Wakapi URL
   api_key = waka_...
   ```
5. Run `bun run src/platforms/wakatime/parser-api.ts` to sync

**Data synced:**
- Coding sessions with project, language, and editor info
- Aggregated from heartbeats into meaningful sessions
- Deduplicates with file-based WakaTime export data

## Steam Setup

Steam uses a simple API key (no OAuth) to access gaming activity.

1. Get your API key from https://steamcommunity.com/dev/apikey
   - Requires a Steam account with a purchase (any game)
   - Domain name can be anything (e.g., `localhost`)
2. Find your Steam ID at https://steamid.io/ (the 17-digit `steamID64`)
3. Run `bun run src/platforms/steam/parser.ts auth` — enter API key and Steam ID when prompted
4. Run `bun run src/platforms/steam/parser.ts` to sync

**Data synced:**
- Game library with playtime (`steam:game:added`)
- Play sessions reconstructed from playtime deltas (`steam:session`)
- Achievement unlock timestamps (`steam:achievement`)

**Session reconstruction:**
Steam does not store session-level play history — only cumulative playtime totals. Sessions are reconstructed by polling every 15 minutes and tracking playtime deltas between syncs. The more frequently the sync runs, the more accurate session boundaries are.

**Achievement backfill:**
First-time sync gradually checks achievements across all games (up to 50 unchecked games per sync cycle). Recently played games are always checked first. Full backfill typically completes in 5-10 sync cycles.

**Rate limits:** The Steam Web API has a generous limit of 100,000 requests/day. A typical sync cycle uses 1 call for the game library plus 2 calls per recently played game (achievements + schema).

## Google Messages Setup

Live SMS, MMS and RCS text sync from the Google Messages app on your phone, using the same device-pairing protocol as Google Messages for Web (via Beeper's `libgm`). Events land under the `google-messages` source as `sms:*`, `mms:*` and `rcs:*` with `phone` identities, keyed per conversation the same way as the SMS Backup & Restore `phone` source. The backfill covers everything the phone still holds, which is the same retention the XML backups captured, so this source supersedes the XML import; until `phone` rows are removed or sources are unified per contact, the overlap period appears under both. MMS and RCS attachments (photos, GIFs, audio, files) are downloaded with their messages into media storage. Where the phone unlocks only the smaller copy Google stores beside the original, that copy is stored instead, and the attachment's `raw_data` keeps the original's dimensions next to a `thumbnail` status so the degraded ones stay identifiable. A part with no key for either copy is recorded as unrecoverable.

**Requirements**: the phone must be online (everything is proxied through it), and Google-account cookies are needed to pair — QR pairing no longer exists.

1. Install or update Timeline.app. It includes the matching sidecar; no Go installation or separate binary copy is needed for app users. For development or Linux, follow the [standalone build instructions](../../tools/timeline-gmessages/README.md#build).
2. Create `~/.local/share/timeline-gmessages`, save `cookies.txt` there using the [cookie extraction instructions](../../tools/timeline-gmessages/README.md#1-extract-account-cookies), then pair from that state directory:
   ```bash
   mkdir -p ~/.local/share/timeline-gmessages
   cd ~/.local/share/timeline-gmessages
   ~/Applications/Timeline.app/Contents/Resources/timeline-service/bin/timeline-gmessages pair
   ```
   Use `/Applications/Timeline.app/...` instead if you installed there. This writes `session.json`; the sync source only needs that file, not the cookies.
3. In the sync dashboard, enable **google-messages** and set **Account label** (stored as `source_account`, e.g. a phone nickname). Leave **Sidecar binary** on **Use default** to track app updates. The state directory remains `~/.local/share/timeline-gmessages`.

The packaged default is the sidecar beside the app's Bun runtime, resolved relative to the running bundle. Outside the app (`bun run dev`, `sync:once`, Linux), the explicit default remains `~/.local/share/timeline-gmessages/timeline-gmessages`; there is no fallback from a missing bundled binary. A configured binary override always wins, including an override pointing at the old default. Select **Use default** and save to remove that override. Defaults are not persisted as overrides, so existing installations with no override switch automatically. Updating the app leaves the old standalone executable and all pairing state untouched; the old executable is simply unused when the bundled default is selected.

Your own messages carry your phone number as their identity (`phone:+44…`, one per SIM), so link those identities to your contact like any other. The first run backfills everything the phone still holds (typically 30–40 minutes for several thousand messages); each conversation's cursor is saved as soon as it completes, so an interrupted run resumes where it stopped, and later runs only page conversations with new activity, listing every conversation once a day and only the most recently active ones otherwise. A conversation that fails to page (network drop) is reported and retried next run without losing the others' progress. If the session is revoked, the run fails with a re-pair instruction — delete `session.json` and pair again. App updates replace the sidecar together with the service; standalone installations must rebuild it when upgrading the source.

Attachments arrive with the messages that carry them, so a source that was synced before media import existed holds text only for that period. To backfill, clear the source's cursors and let the next run re-page every conversation (messages already indexed are skipped; their attachments are stored):
```bash
sqlite3 ~/.local/share/timeline/app-state.db "DELETE FROM sync_state WHERE source = 'google-messages'"
```

Conversations show each message's reactions and who added them. A sidecar built before reactions named people still works: its reactions show without names, and a count of one per emoji, until it's rebuilt and the message is fetched again. Custom reactions from Google Messages show as an icon, because their images exist only on the phone. A sync notices a changed reaction only when it re-fetches the message, which each daily full listing does for messages up to 14 days older than the conversation's last sync. A reaction added to an older message, or to a conversation idle for longer than that, is missed. Clearing the cursors as above re-fetches everything, which also fills in reactors on rows imported from an older sidecar.

## Call recordings Setup

Imports calls recorded on Android with Cube ACR. Each recording is one `call-recordings` event with no transcript; its audio is stored in Timeline's media store, so it is backed up to R2 and evicted like other media.

Cube's Google Drive backup puts the `.amr` files in a Drive folder. Add an rclone inbox source for that folder with `parser = "cube-acr"` (example in [`deploy/macos/config.toml.example`](../../deploy/macos/config.toml.example)) and enable **inbox-rclone** on the Sync page; a `type = "local"` source you copy files into works too.

Timeline reads everything else from the file name, `<app>_YYYYMMDD-HHMMSS_<contact>.amr`, for example `phone_20260315-181753_07700900123.amr`. `<app>` is `phone`, `whatsapp`, `gmeet` or `facebook`; the time is the phone's local time, read in the Timeline host's time zone. The `_<contact>` part may be missing, and may itself contain underscores and spaces. The length comes from the AMR frames. A file whose name doesn't have that shape, or that isn't a whole AMR file, is reported as an error on every run and left in the inbox; nothing is guessed. A file whose audio is already imported, under any name, is skipped; different audio under a name already imported is reported and left in the inbox.

Browsers can't play AMR, so on macOS each recording is also converted to AAC (`.m4a`) with the built-in `afconvert`, and the card plays that copy. The AMR original is kept as well. Where conversion fails, and on Linux, which has no `afconvert`, the recording is still imported and its card says why it can't be played.

Who a call was with comes from Timeline, never from the recorder. When a phone or WhatsApp recording's contact text is a phone number (dialling characters only, at least seven digits; Cube writes an international number's `+` as `_`, as in `phone_20260311-115151__447700900123.amr`), normalised as the call log's numbers are, the recording uses the same `phone:+44…` identity as the call log and messages. Otherwise the recording is imported only when its time overlaps exactly one call event from another Timeline source, such as a call-log row or a Facebook call, and takes that call's people and title. The contact text stays in raw data as a hint. Until then the file waits in the inbox, unmarked and unarchived, and each run of the source's inbox job tries it again and counts it as `filesWaiting`. That job runs when a new file arrives and, for an rclone source, after every inbox-rclone pull. WhatsApp and Meet calls have no call events in Timeline, so their recordings wait until the name carries a number.

The inbox-rclone pull for a `cube-acr` source uses `rclone copy` rather than `sync`, so a waiting file stays in the inbox if Cube removes it from Drive. With `archive_path` set, an imported file is moved to the archive and deleted from the Drive folder, as for every rclone inbox source; without it, imported files stay in the inbox and are skipped by hash.

A `type = "local"` `cube-acr` source can also take recordings uploaded with a token (see [Upload from a tailnet device](#upload-from-a-tailnet-device)). Re-sending a file that is still waiting is accepted without rewriting it, and different audio under the name of a waiting or archived file is refused as `filename_in_use`, so a waiting recording is never replaced. Each accepted upload queues a sweep of the source, which retries files still waiting, as does any new file the watcher sees; a local source has no periodic rclone sweep. The 5 MiB request limit caps an upload at about 54 minutes of narrowband AMR at its highest bitrate, less for wideband.

## MacBook screen recall

Periodic Apple Vision OCR'd screen captures imported as `screen:capture` events. See [recall-setup.md](recall-setup.md).

## Claude category exports

Supply the same account name used for previous imports; the export's account UUID
is retained as metadata, not used as the database account key. Inbox sources pass
`account` from their source configuration to the parser.

```sh
TIMELINE_DB_PATH=/path/to/timeline.db bun run src/platforms/claude/parser.ts /path/to/export-folder account-name --dry-run
TIMELINE_DB_PATH=/path/to/timeline.db bun run src/platforms/claude/parser.ts /path/to/export-folder account-name
```

The input may also be a single ZIP. Category parts are processed in filename order;
a manifest is optional, but listed files must be present when one is supplied.
Download links are never fetched. Browser download suffixes are accepted; unknown
ZIPs, duplicate parts and gaps are rejected. Unsupported memory and project ZIPs stay unprocessed in the inbox until a
version supporting them is installed. Other unsupported categories are explicitly
skipped. Legacy combined exports
remain supported. A complete validation pass precedes any writes. Dry runs open
the database read-only. The CLI uses `TIMELINE_DB_PATH` when supplied, otherwise
resolves the service database from its environment file and configuration. It
refuses to create a missing database, prints the absolute path and event count,
and loads the same SQLite library configured for the service. If Claude history exists
under another account, and the export overlaps that account or the supplied
account has no history, real imports require `--allow-new-account` to confirm
that this is a separate account.

Messages retain the identity `conversation UUID:message UUID` within the supplied
account. New branch messages are added alongside their parents. Conversation
non-empty renames update display titles while retaining the original raw export; existing
message content and raw data change only with `--refresh-raw-data`, which archives
the previous raw data in `event_versions` before replacing it. Raw blocks are
stored twice only when normalization changes their representation; redundant text
is omitted when it equals the normalized event content. Empty messages are
skipped and empty conversations counted separately. Previews report renames and
messages already stored under other accounts.

Memory category ZIPs import each file by its account-relative path and each project
memory by project UUID. The legacy conversation memory keeps `memory:0`, matching
the previous importer. Memory edits update the existing event and archive its prior
raw data in `event_versions`; unchanged imports add no versions. File timestamps
come from `updated_at`. Undated project and conversation memories have a null
timestamp on first import; the existing legacy memory keeps its original date.
Empty memory content is skipped and counted, never used to blank an existing record.

Project ZIPs import project descriptions, instructions and full documents as
`claude:project` events, identified by project UUID within the account. Edits archive
prior raw data before updating the record. Project and memory records share
`project:<UUID>` tags. Conversation links use those tags only when the confirmed
structured memory-path segments match exactly one known exported project; the
`project-link:inferred-memory-path` tag distinguishes these from declared links.
No project field is declared by the conversation export. Plain text mentions are
ignored. Import order does not matter: project imports reconcile links from
stored messages and memories, without changing their raw data or unrelated tags.
Previews count links and tag changes for already-stored conversations and memories;
they exclude records the import has yet to create. Ambiguous and absent matches
remain unlinked.
