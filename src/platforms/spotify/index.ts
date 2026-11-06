import type { PlatformModule } from "../registry";
import { spotifyMeta } from "./meta";
import { spotifySyncSource } from "./sync";
import { spotifyFriendsSyncSource } from "./sync-friends";
import { spotifyPlaylistsSyncSource } from "./sync-playlists";

export const spotifyPlatform: PlatformModule = {
  meta: spotifyMeta,
  syncSources: [spotifySyncSource, spotifyFriendsSyncSource, spotifyPlaylistsSyncSource],
  loadSeeds: async () => [
    (await import("./seed")).spotifySeed,
    (await import("./seed-friends")).spotifyFriendsSeed,
  ],
};
