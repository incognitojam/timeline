/**
 * Offsite Database Backup Sync Source
 *
 * The offsite leg of database backups: a consistent snapshot is staged locally,
 * encrypted client-side, and uploaded to Cloudflare R2 — so a host loss can't
 * take the databases with it. Distinct from the local/NAS [sync.backup*]
 * sources, which are the second on-site copy.
 *
 * Currently backs up app-state.db only: it is small enough to encrypt in memory
 * and is the one DB that CAN'T be rebuilt from raw exports (chats,
 * day_summaries, sync_log, sync cursors). The much larger timeline.db gets a
 * separate dedup-aware path; whole-copy-per-run doesn't scale to it.
 *
 * Opt-in: only runs when [sync.backup-offsite] schedules it AND [backup.r2] is
 * enabled. See createBackupOffsiteStore for the fail-fast secret requirements.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../../config";
import { getTimelineDbPath, getAppStateDbPath } from "../../db/paths";
import { createBackupOffsiteStore } from "../../backup/offsite-store";
import { NETWORK_GUARD_CONFIG_FIELDS } from "../network-guard";
import type { SyncSource, SyncOptions, SyncResult } from "../types";
import { backupDatabase } from "./backup";

const APP_STATE_DB_PATH = getAppStateDbPath(getTimelineDbPath());

/** Offsite snapshots retained per DB when keep_count is unset (~7d at a 6h cadence). */
const DEFAULT_OFFSITE_KEEP = 28;

/** Local staging snapshots to retain. Offsite R2 is the durable copy; staging is transient. */
const STAGING_KEEP = 1;

export const backupOffsiteSyncSource: SyncSource = {
  name: "backup-offsite",
  description: "Encrypt and back up app-state.db offsite to R2",
  enabled: true,
  configSchema: [
    {
      key: "keep_count",
      type: "number",
      label: "Offsite backups to retain",
      description: "Number of uploaded snapshots to keep",
      integer: true,
      min: 1,
      default: DEFAULT_OFFSITE_KEEP,
    },
    ...NETWORK_GUARD_CONFIG_FIELDS,
  ],

  async canSync(sourceConfig?: Record<string, unknown>): Promise<string | null> {
    // Opt-in: require an explicit [sync.backup-offsite] section so a bare
    // `sync --only backup-offsite` never runs unconfigured (the [backup.r2]
    // backend lives elsewhere; the scheduler only schedules configured sources).
    if (!sourceConfig) {
      return "no [sync.backup-offsite] section configured; offsite backup is opt-in";
    }
    const config = await loadConfig();
    if (!config.backup.r2?.enabled) {
      return "[backup.r2] not enabled; set enabled = true to back up offsite";
    }
    if (!existsSync(APP_STATE_DB_PATH)) {
      return `Database not found: ${APP_STATE_DB_PATH}`;
    }
    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();

    try {
      const config = await loadConfig();
      if (!config.backup.r2) {
        throw new Error("[backup.r2] is not configured");
      }
      const keepCount =
        (options.config.sources["backup-offsite"]?.keep_count as number | undefined) ?? DEFAULT_OFFSITE_KEEP;

      // Build the store first so missing secrets fail before we stage anything.
      const store = createBackupOffsiteStore(config.backup.r2);

      // Stage a consistent snapshot to a local dir (never the NAS — the offsite
      // job must not depend on the NAS being online), then encrypt + upload.
      const stagingDir = join(dirname(APP_STATE_DB_PATH), "backups-staging");
      const snapshot = await backupDatabase({
        dbPath: APP_STATE_DB_PATH,
        destination: stagingDir,
        prefix: "app-state",
        keepCount: STAGING_KEEP,
        verbose: options.verbose,
      });
      if (!snapshot.success || !snapshot.backupPath) {
        throw new Error(snapshot.error ?? "failed to stage snapshot");
      }

      const uploaded = await store.upload("app-state", snapshot.backupPath);
      const deleted = await store.prune("app-state", keepCount);

      return {
        source: "backup-offsite",
        success: true,
        eventsAdded: 0,
        eventsUpdated: 0,
        durationMs: Date.now() - startTime,
        metadata: {
          db: "app-state",
          key: uploaded.key,
          sha256: uploaded.sha256,
          sizeBytes: uploaded.size,
          keepCount,
          offsiteDeleted: deleted.length,
        },
      };
    } catch (err) {
      return {
        source: "backup-offsite",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
