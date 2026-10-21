# Source Setup

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
   bun run src/scripts/bootstrap-discord-state.ts
   ```
5. Generate guild config from discord-chat DB (optional, for migration):
   ```bash
   bun run src/scripts/generate-discord-config.ts
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

## Monzo Setup

Monzo uses OAuth2 (not file exports) and requires special setup:

1. Create an app at https://developers.monzo.com/ with redirect URI `http://127.0.0.1:8742/callback`
2. Run
   `~/Applications/Timeline.app/Contents/Resources/timeline-service/bin/timeline-service monzo auth`
   on the host (or `bun run src/parsers/monzo.ts auth` from a development
   checkout) — enter client ID/secret when prompted, approve in browser + Monzo app
3. **Within 5 minutes**, run sync to get full transaction history (after 5 mins, only last 90 days)

Monzo Flex accounts appear as `uk_monzo_flex` type but individual Flex backing loans have restricted API access.

## Thriva Setup

Thriva uses password authentication to access blood test biomarker results.

1. Create credentials file `~/.config/timeline/thriva.json`:
   ```json
   { "email": "alice@example.com", "password": "your-password" }
   ```
2. Run `bun run src/parsers/thriva.ts` to sync biomarker results
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
3. Run `TIMELINE_DB_PATH=~/.local/share/timeline/timeline.db bun run src/parsers/google-health-api.ts auth` to authorize access, then enable Google Health on the Sync page. Point to the service database so the token is stored in its `app-state.db`, rather than the checkout's.

## Trakt Setup

Trakt uses OAuth2 to sync watch history (movies and TV episodes).

1. Create an app at https://trakt.tv/oauth/applications
   - Redirect URI: `http://127.0.0.1:8742/callback`
2. Save credentials to `~/.config/timeline/trakt.json`:
   ```json
   { "client_id": "...", "client_secret": "..." }
   ```
   Alternatively, set `TRAKT_CLIENT_ID` and `TRAKT_CLIENT_SECRET` environment variables.
3. Run `bun run src/parsers/trakt-api.ts auth` - opens browser for OAuth
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
3. Run `bun run src/parsers/swarm-api.ts auth` and complete the OAuth prompt.

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
3. Run `bun run src/parsers/spotify-api.ts auth` - opens browser for OAuth
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
   bun run src/scripts/seed-playlist-follows.ts \
     --playlist 0123456789ABCDEFGHIJKL \
     --csv <path-or-google-sheet-url> \
     [--name "Playlist Name"] [--date-col Date] [--count-col Likes] [--dry-run]
   ```

   The CSV needs a date column and a count column. A Google Sheets `/edit` URL is rewritten to a CSV export automatically. Seeded rows are marked `origin = 'seed'`; synced rows are `origin = 'api'`.

Query the series with SQL/MCP, e.g. `SELECT observed_date, follower_count FROM spotify_playlist_observations WHERE playlist_id = '...' ORDER BY observed_date`.

## Spotify Friends Setup

Syncs friends' listening activity using Spotify's unofficial internal API (the same endpoint the desktop client uses for "Friend Activity" sidebar).

**Caveats:**
- **Unofficial API** - May break without notice
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
6. Run `bun run src/parsers/spotify-friends.ts status` to verify
7. Run `bun run src/parsers/spotify-friends.ts` to sync

**Data stored:**
- Event type: `listen:track:friend`
- `source`: `spotify-friends`
- `source_account`: Friend's Spotify username (from URI)
- `people`: `spotify:<username>` (from URI)
- `tags`: `album:<name>`, `artist:<name>`, plus `playlist:<name>`/`album:<name>`/`artist:<name>`/`context:<name>` from playback context
- `raw_data`: Full API response (includes track/album/artist URIs for enrichment)

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
bun run src/scripts/resolve-places.ts --dry-run     # Preview unresolved count
bun run src/scripts/resolve-places.ts --verbose      # Resolve all, showing each
bun run src/scripts/resolve-places.ts --limit 50     # Resolve first 50 only
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
3. Run `bun run src/parsers/github-api.ts` to sync

**Data synced:**
- Issues you created
- Pull requests you created
- Issue comments
- PR reviews and review comments
- Commit comments

The `token_expires` field is optional but recommended for tracking PAT expiration.

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
5. Run `bun run src/parsers/wakatime-api.ts` to sync

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
3. Run `bun run src/parsers/steam-api.ts auth` — enter API key and Steam ID when prompted
4. Run `bun run src/parsers/steam-api.ts` to sync

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

1. Build and install the sidecar:
   ```bash
   cd tools/timeline-gmessages && go build -o timeline-gmessages .
   mkdir -p ~/.local/share/timeline-gmessages && cp timeline-gmessages ~/.local/share/timeline-gmessages/
   ```
2. Pair from the state directory, following [tools/timeline-gmessages/README.md](../../tools/timeline-gmessages/README.md) for cookie extraction:
   ```bash
   cd ~/.local/share/timeline-gmessages && ./timeline-gmessages pair
   ```
   This writes `session.json`; the sync source only needs that file, not the cookies.
3. In the sync dashboard, enable **google-messages** and set **Account label** (stored as `source_account`, e.g. your name). The binary and state-directory paths default to `~/.local/share/timeline-gmessages`.

Your own messages carry your phone number as their identity (`phone:+44…`, one per SIM), so link those identities to your contact like any other. The first run backfills everything the phone still holds (typically 30–40 minutes for several thousand messages); each conversation's cursor is saved as soon as it completes, so an interrupted run resumes where it stopped, and later runs only page conversations with new activity. A conversation that fails to page (network drop) is reported and retried next run without losing the others' progress. If the session is revoked, the run fails with a re-pair instruction — delete `session.json` and pair again.

Attachments arrive with the messages that carry them, so a source that was synced before media import existed holds text only for that period. To backfill, clear the source's cursors and let the next run re-page every conversation (messages already indexed are skipped; their attachments are stored):
```bash
sqlite3 ~/.local/share/timeline/app-state.db "DELETE FROM sync_state WHERE source = 'google-messages'"
```

## MacBook screen recall

Periodic Apple Vision OCR'd screen captures imported as `screen:capture` events. See [recall-setup.md](recall-setup.md).
