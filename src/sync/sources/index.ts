/**
 * Sync Sources Registry
 *
 * Single source of truth for all sync sources.
 * Used by both the CLI sync orchestrator and the scheduler.
 */

import type { SyncSource } from "../types";
import { ampSyncSource } from "./amp";
import { attachmentDescriptionsSyncSource } from "./attachment-descriptions";
import { backupSyncSource } from "./backup";
import { backupAppStateSyncSource } from "./backup-app-state";
import { backupOffsiteSyncSource } from "./backup-offsite";
import { claudeCodeSyncSource } from "./claude-code";
import { codexSyncSource } from "./codex";
import { conductorSyncSource } from "./conductor";
import { embeddingsSyncSource } from "./embeddings";
import { discordSyncSource } from "../../platforms/discord/sync";
import { googleMessagesSyncSource } from "../../platforms/google-messages/sync";
import { githubSyncSource } from "./github";
import { googleHealthSyncSource } from "./google-health";
import { googlePlacesSyncSource } from "./google-places";
import { inboxRcloneSyncSource } from "./inbox-rclone";
import { mediaEvictSyncSource } from "./media-evict";
import { monzoSyncSource } from "./monzo";
import { opencodeSyncSource } from "./opencode";
import { recallSyncSource } from "./recall";
import { renderSweepSyncSource } from "./render-sweep";
import { spotifySyncSource } from "./spotify";
import { spotifyFriendsSyncSource } from "./spotify-friends";
import { spotifyPlaylistsSyncSource } from "./spotify-playlists";
import { steamSyncSource } from "./steam";
import { swarmSyncSource } from "./swarm";
import { t3codeSyncSource } from "./t3code";
import { thrivaSyncSource } from "./thriva";
import { thumbhashSyncSource } from "./thumbhash";
import { traktSyncSource } from "./trakt";
import { wakatimeSyncSource } from "./wakatime";

/**
 * All available sync sources.
 * Add new sources here - they'll automatically be available to the
 * scheduler service.
 */
export const SYNC_SOURCES: SyncSource[] = [
  discordSyncSource,
  googleMessagesSyncSource,
  monzoSyncSource,
  traktSyncSource,
  swarmSyncSource,
  wakatimeSyncSource,
  githubSyncSource,
  claudeCodeSyncSource,
  ampSyncSource,
  thrivaSyncSource,
  googleHealthSyncSource,
  opencodeSyncSource,
  spotifySyncSource,
  spotifyFriendsSyncSource,
  spotifyPlaylistsSyncSource,
  conductorSyncSource,
  t3codeSyncSource,
  codexSyncSource,
  steamSyncSource,
  googlePlacesSyncSource, // Resolve place names before thumbhash/backup
  inboxRcloneSyncSource, // Pull files from cloud remotes into inbox dirs
  recallSyncSource, // Import MacBook screen captures (before thumbhash so new images get hashed)
  thumbhashSyncSource, // Process new images before backup
  attachmentDescriptionsSyncSource, // Describe new images after storage
  renderSweepSyncSource, // Refresh stored text after a renderer version bump
  embeddingsSyncSource, // Embed events the syncs above added
  mediaEvictSyncSource, // Trim the local media cache to its bound (opt-in via [sync.media-evict])
  backupAppStateSyncSource, // Back up app-state.db before timeline.db
  backupSyncSource, // Keep local backups last - run after data syncs
  backupOffsiteSyncSource, // Offsite (R2) backup last - after local snapshots exist
];

// Re-export individual sources for direct imports if needed
export {
  backupAppStateSyncSource,
  backupOffsiteSyncSource,
  discordSyncSource,
  googleMessagesSyncSource,
  googlePlacesSyncSource,
  inboxRcloneSyncSource,
  mediaEvictSyncSource,
  monzoSyncSource,
  traktSyncSource,
  wakatimeSyncSource,
  githubSyncSource,
  claudeCodeSyncSource,
  ampSyncSource,
  thrivaSyncSource,
  googleHealthSyncSource,
  opencodeSyncSource,
  recallSyncSource,
  renderSweepSyncSource,
  embeddingsSyncSource,
  spotifySyncSource,
  spotifyFriendsSyncSource,
  spotifyPlaylistsSyncSource,
  conductorSyncSource,
  t3codeSyncSource,
  codexSyncSource,
  steamSyncSource,
  swarmSyncSource,
  thumbhashSyncSource,
  attachmentDescriptionsSyncSource,
  backupSyncSource,
};
