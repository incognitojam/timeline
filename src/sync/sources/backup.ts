/**
 * Database Backup Sync Source (timeline.db)
 *
 * Creates consistent backups of timeline.db to a configured destination.
 * See backup-app-state.ts for app-state.db backups.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync, readSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { SyncSource, SyncOptions, SyncResult } from "../types";
import type { SyncSourceConfig } from "../config";
import { getTimelineDbPath } from "../../db/paths";

const TIMELINE_DB_PATH = getTimelineDbPath();

export interface BackupConfig extends SyncSourceConfig {
  destination: string;
  keep_count?: number;
}

export const DEFAULT_BACKUP_KEEP_COUNT = 24;

function getBackupFilename(prefix: string): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${prefix}-${timestamp}.db`;
}

function cleanupOldBackups(backupDir: string, prefix: string, keepCount: number): number {
  if (!existsSync(backupDir)) return 0;

  const backups = readdirSync(backupDir)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".db") && !f.endsWith("-journal"))
    .map((f) => ({
      name: f,
      path: join(backupDir, f),
      mtime: statSync(join(backupDir, f)).mtime.getTime(),
    }))
    .sort((a, b) => b.mtime - a.mtime); // Newest first

  let deleted = 0;
  for (let i = keepCount; i < backups.length; i++) {
    try {
      unlinkSync(backups[i].path);
      // Also try to delete any associated journal file
      try {
        unlinkSync(backups[i].path + "-journal");
      } catch {
        // Ignore if no journal
      }
      deleted++;
    } catch {
      // Ignore deletion errors
    }
  }

  return deleted;
}

const SQLITE_HEADER = "SQLite format 3\0";

/** Verify a backup file has a valid SQLite header. */
function verifySqliteHeader(path: string): void {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(16);
    readSync(fd, buf, 0, 16, 0);
    if (buf.toString("ascii") !== SQLITE_HEADER) {
      throw new Error(`Backup file is not a valid SQLite database: ${path}`);
    }
  } finally {
    closeSync(fd);
  }
}

export interface BackupResult {
  success: boolean;
  error?: string;
  backupPath?: string;
  sizeMB?: number;
  deleted?: number;
  durationMs: number;
}

/**
 * Back up a single SQLite database via VACUUM INTO.
 * Shared by both the timeline and app-state backup sources.
 */
export async function backupDatabase(opts: {
  dbPath: string;
  destination: string;
  prefix: string;
  keepCount: number;
  verbose?: boolean;
}): Promise<BackupResult> {
  const startTime = Date.now();

  try {
    if (!existsSync(opts.dbPath)) {
      throw new Error(`Database not found: ${opts.dbPath}`);
    }

    if (!existsSync(opts.destination)) {
      mkdirSync(opts.destination, { recursive: true });
    }

    const backupPath = join(opts.destination, getBackupFilename(opts.prefix));
    if (opts.verbose) console.log(`Backing up to: ${backupPath}`);

    const db = new Database(opts.dbPath);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.exec(`VACUUM INTO '${backupPath}'`);
    } finally {
      db.close();
    }
    verifySqliteHeader(backupPath);

    const sizeMB = Math.round(statSync(backupPath).size / 1024 / 1024);
    if (opts.verbose) console.log(`Backup complete: ${sizeMB} MB`);

    const deleted = cleanupOldBackups(opts.destination, opts.prefix, opts.keepCount);
    if (opts.verbose && deleted > 0) {
      console.log(`Cleaned up ${deleted} old backup(s)`);
    }

    return { success: true, backupPath, sizeMB, deleted, durationMs: Date.now() - startTime };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}

export const backupSyncSource: SyncSource = {
  name: "backup",
  description: "Backup timeline database to NAS",
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
      return "Backup destination not configured. Set sync.backup.destination in config.";
    }

    const destDir = backupConfig.destination;
    if (!existsSync(destDir)) {
      try {
        mkdirSync(destDir, { recursive: true });
      } catch {
        return `Cannot create backup directory: ${destDir}`;
      }
    }

    if (!existsSync(TIMELINE_DB_PATH)) {
      return `Database not found: ${TIMELINE_DB_PATH}`;
    }

    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const sourceConfig = options.config.sources["backup"] as BackupConfig | undefined;

    if (!sourceConfig?.destination) {
      return {
        source: "backup",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Backup destination not configured",
        durationMs: Date.now() - startTime,
      };
    }

    const result = await backupDatabase({
      dbPath: TIMELINE_DB_PATH,
      destination: sourceConfig.destination,
      prefix: "timeline",
      keepCount: sourceConfig.keep_count ?? DEFAULT_BACKUP_KEEP_COUNT,
      verbose: options.verbose,
    });

    return {
      source: "backup",
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

// CLI entry point for manual execution
if (import.meta.main) {
  const args = process.argv.slice(2);
  const destination = args[0];
  const keepCount = parseInt(args[1] || String(DEFAULT_BACKUP_KEEP_COUNT), 10);

  if (!destination) {
    console.error("Usage: bun run src/sync/sources/backup.ts <destination> [keepCount]");
    console.error("Example: bun run src/sync/sources/backup.ts ~/timeline-backups 24");
    process.exit(1);
  }

  console.log(`Starting timeline backup to ${destination} (keeping ${keepCount} backups)...`);
  const result = await backupDatabase({
    dbPath: TIMELINE_DB_PATH,
    destination,
    prefix: "timeline",
    keepCount,
    verbose: true,
  });

  if (result.success) {
    console.log(`\nBackup successful: ${result.sizeMB} MB in ${(result.durationMs / 1000).toFixed(1)}s`);
    if (result.deleted) {
      console.log(`Cleaned up ${result.deleted} old backup(s)`);
    }
  } else {
    console.error(`\nBackup failed: ${result.error}`);
    process.exit(1);
  }
}
