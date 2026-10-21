/**
 * Spotify Playlists Sync Source
 *
 * Tracks the public follower count (the "saves"/likes number) of configured
 * playlists over time, recording one observation per playlist per day into the
 * `spotify_playlist_observations` table.
 *
 * Reuses the Spotify Web API auth from the `spotify` source
 * (run: bun run src/parsers/spotify-api.ts auth).
 *
 * Config (config.toml):
 *   [sync.spotify-playlists]
 *   interval = "12h"
 *   playlists = ["0123456789ABCDEFGHIJKL"]  # IDs, spotify: URIs, or open.spotify.com URLs
 */

import type { Database } from "bun:sqlite";
import type { SyncSource, SyncOptions, SyncResult } from "../types";
import { httpRetry, type HttpRetryConfig } from "../../lib/http-retry";
import { getDb, initDb } from "../../db/schema";
import {
  loadSpotifyConfig,
  SPOTIFY_CONFIG_PATH,
  getValidSpotifyTokens,
  fetchPlaylistFollowers,
  fetchPlaylistCreatedAt,
  extractPlaylistId,
  SpotifyApiError,
  type SpotifyPlaylistFollowers,
  type SpotifyTokens,
} from "../../parsers/spotify-api";
import {
  getAppStateDb,
  getSyncState,
  setSpotifyResource,
} from "../../db/app-state";
import {
  recordPlaylistObservation,
  fillMissingPlaylistName,
  getPlaylistMeta,
  recordPlaylistCreatedAt,
  type PlaylistMeta,
} from "../../db/playlist-follows";

const SOURCE_NAME = "spotify-playlists";

// A playlist's creation date barely changes, but tracking its earliest track
// add means paginating its whole tracklist — too costly to redo every 12h sync.
// Recompute only when unknown or this stale, so a removed-then-readded oldest
// track is eventually reflected without hammering the API.
const CREATED_AT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function createdAtIsStale(meta: PlaylistMeta | null, now: Date): boolean {
  if (!meta) return true;
  return now.getTime() - Date.parse(meta.checked_at) >= CREATED_AT_TTL_MS;
}

interface ParsedPlaylistConfig {
  /** Valid playlist IDs (deduped, original order preserved). */
  ids: string[];
  /** Raw entries that couldn't be parsed into a playlist ID. */
  invalid: string[];
}

/**
 * Parse the `playlists` array from the source config into validated IDs.
 * Accepts IDs, spotify: URIs, and open.spotify.com URLs.
 */
export function parsePlaylistConfig(
  config?: Record<string, unknown>,
): ParsedPlaylistConfig {
  const raw = config?.playlists;
  if (!Array.isArray(raw)) return { ids: [], invalid: [] };

  const ids: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (typeof entry !== "string") {
      invalid.push(String(entry));
      continue;
    }
    const id = extractPlaylistId(entry);
    if (!id) {
      invalid.push(entry);
      continue;
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return { ids, invalid };
}

export interface PlaylistSyncStats {
  /** Observations recorded (inserted or updated). */
  recorded: number;
  /** Playlists that returned 404/403 (deleted or private). */
  missing: number;
  /** True if a 429 stopped the run early. */
  rateLimited: boolean;
}

interface SyncDeps {
  /** Injected so tests can run without hitting the network. */
  fetchFollowers: (
    playlistId: string,
  ) => Promise<SpotifyPlaylistFollowers | null>;
  /**
   * Earliest track added_at (creation-date proxy), or null if unknown. Omitted
   * in tests that only exercise follower logic, in which case creation dates
   * are left untouched.
   */
  fetchCreatedAt?: (playlistId: string) => Promise<string | null>;
  now?: Date;
  verbose?: boolean;
  /** Override the transient-error retry policy (tests use a zero delay). */
  retry?: Partial<HttpRetryConfig>;
}

/**
 * Core sync logic, decoupled from auth/network so it can be unit tested with an
 * injected fetcher. Records one daily observation per playlist.
 */
export async function syncPlaylistFollowsWithDb(
  db: Database,
  appDb: Database,
  playlistIds: string[],
  deps: SyncDeps,
): Promise<PlaylistSyncStats> {
  const now = deps.now ?? new Date();
  const observedAt = now.toISOString();
  const observedDate = observedAt.slice(0, 10); // YYYY-MM-DD

  const stats: PlaylistSyncStats = {
    recorded: 0,
    missing: 0,
    rateLimited: false,
  };

  for (const playlistId of playlistIds) {
    let data: SpotifyPlaylistFollowers | null;
    try {
      // The default 5xx/network policy fits here: 404/403 surface as `null`,
      // and a 429 stays non-transient so it falls through to the stop-the-run
      // handler below rather than being retried inside the job lease.
      data = await httpRetry(() => deps.fetchFollowers(playlistId), deps.retry);
    } catch (error) {
      if (error instanceof SpotifyApiError && error.status === 429) {
        stats.rateLimited = true;
        if (deps.verbose) {
          const retry = Number.isFinite(error.retryAfter)
            ? ` Retry after ${error.retryAfter}s.`
            : "";
          console.log(`[${SOURCE_NAME}] Rate limited, stopping.${retry}`);
        }
        break;
      }
      throw error;
    }

    if (!data) {
      stats.missing++;
      if (deps.verbose) {
        console.log(`[${SOURCE_NAME}] ${playlistId}: not found (deleted/private)`);
      }
      continue;
    }

    recordPlaylistObservation(db, {
      playlistId,
      observedDate,
      observedAt,
      followerCount: data.followerCount,
      name: data.name,
      origin: "api",
      rawData: data,
    });

    // Backfill the name onto any earlier rows that lack one (e.g. seeded
    // history imported before the name was known).
    fillMissingPlaylistName(db, playlistId, data.name);

    // Cache the playlist name and cover art alongside the main spotify source's
    // resources so listen events (and the /music UI) can resolve them.
    setSpotifyResource(
      appDb,
      `spotify:playlist:${playlistId}`,
      "playlist",
      data.name,
      data.imageUrl,
    );

    stats.recorded++;
    if (deps.verbose) {
      console.log(`[${SOURCE_NAME}] ${data.name}: ${data.followerCount} saves`);
    }

    // Best-effort: capture the playlist's creation date (earliest track add),
    // gated so we don't paginate every tracklist on every sync. A 429 here
    // stops the run like the follower path; the scheduler resumes later.
    const fetchCreatedAt = deps.fetchCreatedAt;
    if (fetchCreatedAt && createdAtIsStale(getPlaylistMeta(db, playlistId), now)) {
      let createdAt: string | null;
      try {
        createdAt = await httpRetry(
          () => fetchCreatedAt(playlistId),
          deps.retry,
        );
      } catch (error) {
        if (error instanceof SpotifyApiError && error.status === 429) {
          stats.rateLimited = true;
          if (deps.verbose) {
            console.log(`[${SOURCE_NAME}] Rate limited (created-at), stopping.`);
          }
          break;
        }
        throw error;
      }
      recordPlaylistCreatedAt(db, {
        playlistId,
        createdAt,
        checkedAt: observedAt,
      });
      if (deps.verbose && createdAt) {
        console.log(`[${SOURCE_NAME}] ${data.name}: created ~${createdAt.slice(0, 10)}`);
      }
    }
  }

  return stats;
}

export const spotifyPlaylistsSyncSource: SyncSource = {
  name: SOURCE_NAME,
  description: "Track follower/save counts for configured Spotify playlists",
  enabled: true,

  async canSync(config?: Record<string, unknown>): Promise<string | null> {
    const spotifyConfig = loadSpotifyConfig();
    if (!spotifyConfig) {
      return (
        "Spotify not configured. Create " +
        `${SPOTIFY_CONFIG_PATH} with client_id (and optional client_secret) ` +
        "or set SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET"
      );
    }

    const appDb = getAppStateDb();
    const tokens = getSyncState<SpotifyTokens>(appDb, "spotify");
    if (!tokens) {
      return "Spotify not authenticated. Run: bun run src/parsers/spotify-api.ts auth";
    }
    if (!tokens.refresh_token) {
      return "Spotify missing refresh token. Run: bun run src/parsers/spotify-api.ts auth";
    }

    const { ids, invalid } = parsePlaylistConfig(config);
    if (invalid.length > 0) {
      return `Invalid playlist reference(s): ${invalid.join(", ")}`;
    }
    if (ids.length === 0) {
      return (
        'No playlists configured. Add playlists = ["<id-or-url>"] under ' +
        "[sync.spotify-playlists] in config.toml"
      );
    }

    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const { ids } = parsePlaylistConfig(options.config.sources[SOURCE_NAME]);

    try {
      const tokens = await getValidSpotifyTokens({ headless: true });
      const db = getDb();
      initDb(db);
      const appDb = getAppStateDb();

      try {
        const stats = await syncPlaylistFollowsWithDb(db, appDb, ids, {
          fetchFollowers: (playlistId) =>
            fetchPlaylistFollowers(tokens, playlistId),
          fetchCreatedAt: (playlistId) =>
            fetchPlaylistCreatedAt(tokens, playlistId),
          verbose: options.verbose,
        });

        return {
          source: SOURCE_NAME,
          success: true,
          // Observations are a gauge time series, not timeline events — keep
          // them out of eventsAdded (which feeds sync logs, status, and event
          // totals). Surface the count in metadata instead.
          eventsAdded: 0,
          eventsUpdated: 0,
          durationMs: Date.now() - startTime,
          metadata: {
            playlists: ids.length,
            recorded: stats.recorded,
            missing: stats.missing,
            rateLimited: stats.rateLimited,
          },
        };
      } finally {
        db.close();
      }
    } catch (error) {
      return {
        source: SOURCE_NAME,
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
