/**
 * App-State Database Backup Sync Source
 *
 * Creates consistent backups of app-state.db (chats, messages, summaries)
 * on a shorter cadence than the main timeline.db backup.
 */

import { existsSync, mkdirSync } from "node:fs";
import type { SyncSource, SyncOptions, SyncResult } from "../types";
import { getTimelineDbPath, getAppStateDbPath } from "../../db/paths";
import {
  type BackupConfig,
  backupDatabase,
  DEFAULT_BACKUP_KEEP_COUNT,
} from "./backup";

const APP_STATE_DB_PATH = getAppStateDbPath(getTimelineDbPath());

export const backupAppStateSyncSource: SyncSource = {
  name: "backup-app-state",
  description: "Backup app-state database to NAS",
  enabled: true,
  configSchema: [
    {
      key: "destination",
      type: "string",
      format: "path",
      label: "Backup directory",
      description: "Directory backups are written to",
      required: true,
    },
    {
      key: "keep_count",
      type: "number",
      label: "Backups to retain",
      description: "Number of completed backups to keep",
      integer: true,
      min: 1,
      default: DEFAULT_BACKUP_KEEP_COUNT,
    },
  ],

  async canSync(config?: Record<string, unknown>): Promise<string | null> {
    const backupConfig = config as BackupConfig | undefined;

    if (!backupConfig?.destination) {
      return "Backup destination not configured. Set sync.backup-app-state.destination in config.";
    }

    const destDir = backupConfig.destination;
    if (!existsSync(destDir)) {
      try {
        mkdirSync(destDir, { recursive: true });
      } catch {
        return `Cannot create backup directory: ${destDir}`;
      }
    }

    if (!existsSync(APP_STATE_DB_PATH)) {
      return `Database not found: ${APP_STATE_DB_PATH}`;
    }

    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const sourceConfig = options.config.sources["backup-app-state"] as BackupConfig | undefined;

    if (!sourceConfig?.destination) {
      return {
        source: "backup-app-state",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Backup destination not configured",
        durationMs: Date.now() - startTime,
      };
    }

    const result = await backupDatabase({
      dbPath: APP_STATE_DB_PATH,
      destination: sourceConfig.destination,
      prefix: "app-state",
      keepCount: sourceConfig.keep_count ?? DEFAULT_BACKUP_KEEP_COUNT,
      verbose: options.verbose,
    });

    return {
      source: "backup-app-state",
      success: result.success,
      eventsAdded: 0,
      eventsUpdated: 0,
      error: result.error,
      durationMs: result.durationMs,
      metadata: {
        backupPath: result.backupPath,
        sizeMB: result.sizeMB,
        deleted: result.deleted,
      },
    };
  },
};
