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
import { PLATFORMS } from "../../platforms";
import { collectSyncSources } from "../../platforms/registry";
import { githubSyncSource } from "./github";
import { googlePlacesSyncSource } from "./google-places";
import { inboxRcloneSyncSource } from "./inbox-rclone";
import { mediaEvictSyncSource } from "./media-evict";
import { opencodeSyncSource } from "./opencode";
import { remoteAgentsSyncSource } from "./remote-agents";
import { renderSweepSyncSource } from "./render-sweep";
import { t3codeSyncSource } from "./t3code";
import { thumbhashSyncSource } from "./thumbhash";
import { wakatimeSyncSource } from "./wakatime";

/**
 * All available sync sources.
 * Platforms contribute theirs through `PLATFORMS`; add the rest here. Either
 * way they're automatically available to the scheduler service.
 */
export const SYNC_SOURCES: SyncSource[] = collectSyncSources(PLATFORMS, [
  wakatimeSyncSource,
  githubSyncSource,
  claudeCodeSyncSource,
  ampSyncSource,
  opencodeSyncSource,
  conductorSyncSource,
  t3codeSyncSource,
  codexSyncSource,
  remoteAgentsSyncSource, // Pull and import agent logs from other machines
  googlePlacesSyncSource, // Resolve place names before thumbhash/backup
  inboxRcloneSyncSource, // Pull files from cloud remotes into inbox dirs
  thumbhashSyncSource, // Process new images before backup
  attachmentDescriptionsSyncSource, // Describe new images after storage
  renderSweepSyncSource, // Refresh stored text after a renderer version bump
  embeddingsSyncSource, // Embed events the syncs above added
  mediaEvictSyncSource, // Trim the local media cache to its bound (opt-in via [sync.media-evict])
  backupAppStateSyncSource, // Back up app-state.db before timeline.db
  backupSyncSource, // Keep local backups last - run after data syncs
  backupOffsiteSyncSource, // Offsite (R2) backup last - after local snapshots exist
]);

// Re-export individual sources for direct imports if needed
export {
  backupAppStateSyncSource,
  backupOffsiteSyncSource,
  googlePlacesSyncSource,
  inboxRcloneSyncSource,
  mediaEvictSyncSource,
  wakatimeSyncSource,
  githubSyncSource,
  claudeCodeSyncSource,
  ampSyncSource,
  opencodeSyncSource,
  renderSweepSyncSource,
  embeddingsSyncSource,
  conductorSyncSource,
  t3codeSyncSource,
  codexSyncSource,
  remoteAgentsSyncSource,
  thumbhashSyncSource,
  attachmentDescriptionsSyncSource,
  backupSyncSource,
};
