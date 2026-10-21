import type { SyncSource, SyncOptions, SyncResult } from "../types";
import {
  loadSpotifyFriendsConfig,
  SPOTIFY_FRIENDS_CONFIG_PATH,
  syncSpotifyFriends,
} from "../../parsers/spotify-friends";

export const spotifyFriendsSyncSource: SyncSource = {
  name: "spotify-friends",
  description: "Sync Spotify friends' listening activity via unofficial API",
  enabled: true,

  async canSync(_config?: Record<string, unknown>): Promise<string | null> {
    const config = loadSpotifyFriendsConfig();
    if (!config) {
      return (
        `Spotify Friends not configured. Create ${SPOTIFY_FRIENDS_CONFIG_PATH} with:\n` +
        '{"sp_dc": "YOUR_SP_DC_COOKIE", "totp_secret": "YOUR_CURRENT_TOTP_SECRET", "totp_version": 1}\n\n' +
        "Get the cookie from open.spotify.com DevTools > Application > Cookies and provide the current web-player TOTP material"
      );
    }

    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();

    try {
      const stats = await syncSpotifyFriends({
        verbose: options.verbose,
      });

      return {
        source: "spotify-friends",
        success: true,
        eventsAdded: stats.imported,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        source: "spotify-friends",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
