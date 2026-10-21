import type { SyncSource, SyncOptions, SyncResult } from "../types";
import { getAppStateDb, getSyncState } from "../../db/app-state";
import { deriveOAuthAuthStatus } from "../../lib/oauth-tokens";
import {
  loadSpotifyConfig,
  type SpotifyTokens,
  SPOTIFY_CONFIG_PATH,
  syncSpotify,
  getStoredAccountName,
} from "../../parsers/spotify-api";

export const spotifySyncSource: SyncSource = {
  name: "spotify",
  description: "Sync Spotify recently played tracks via API",
  enabled: true,

  authStatus() {
    const config = loadSpotifyConfig();
    const tokens = getSyncState<SpotifyTokens>(getAppStateDb(), "spotify");
    return deriveOAuthAuthStatus(config !== null, tokens);
  },

  async canSync(_config?: Record<string, unknown>): Promise<string | null> {
    const config = loadSpotifyConfig();
    if (!config) {
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

    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const accountName = getStoredAccountName();

    try {
      if (options.verbose && accountName) {
        console.log(`[spotify] Starting sync for account: ${accountName}`);
      }

      const stats = await syncSpotify(undefined, {
        verbose: options.verbose,
        headless: true,
      });

      return {
        source: "spotify",
        success: true,
        eventsAdded: stats.imported,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "spotify",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
