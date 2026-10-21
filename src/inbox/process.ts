/**
 * Inbox File Processor
 *
 * Scans inbox folders for new files and routes them to appropriate parsers.
 */

import { Database } from "bun:sqlite";
import type { InboxConfig, InboxSourceConfig } from "./config";
import { resolveSourcePath, getEnabledSources, getArchivePath } from "./config";
import {
  getTrackerDb,
  findUnprocessedFiles,
  markFileProcessed,
  getSourceStats,
} from "./tracker";
import { getDb, initDb } from "../db/schema";
import { getAppStateDb } from "../db/app-state";
import { startSyncLog, completeSyncLog } from "../sync/log";
import { basename, dirname, join } from "path";
import { mkdir, rename } from "fs/promises";
import { spawn } from "child_process";

export interface ProcessOptions {
  dryRun?: boolean;
  verbose?: boolean;
  only?: string[];
  signal?: AbortSignal;
  /** Link sync_log rows produced by this run back to the queue job that triggered it. */
  jobId?: number | null;
}

export interface ProcessResult {
  source: string;
  filesProcessed: number;
  filesSkipped: number;
  eventsAdded: number;
  errors: string[];
}

/**
 * Parser context - additional information passed to parsers
 */
export interface ParserContext {
  /** rclone remote name for sources that use rclone (e.g., "gdrive") */
  rcloneRemote?: string;
  signal?: AbortSignal;
}

/**
 * Parser result - can be just a count or include detected type
 */
export interface ParserResult {
  eventsAdded: number;
  eventsUpdated?: number;
  detectedType?: string;
}

/**
 * Parser registry - maps parser names to import functions
 * sourceAccount may be null for parsers that auto-detect (e.g., google-takeout)
 * Returns either a count or a ParserResult object
 */
type ParserFunction = (
  db: Database,
  filePath: string,
  sourceAccount: string | null,
  context?: ParserContext
) => Promise<number | ParserResult>;

const PARSERS: Record<string, () => Promise<ParserFunction>> = {
  "sms-backup-restore": async () => {
    const module = await import("../parsers/sms-backup-restore");
    return module.processSmsFile;
  },
  "google-takeout": async () => {
    const { processGoogleTakeoutZip } = await import("./zip-handlers");
    // Wrap to pass context as options
    return (db, filePath, sourceAccount, context) =>
      processGoogleTakeoutZip(db, filePath, sourceAccount, {
        rcloneRemote: context?.rcloneRemote,
      });
  },
  "google-timeline": async () => {
    const { importTimelineData } = await import("../parsers/google-timeline");
    return (db, filePath, sourceAccount) => {
      if (!sourceAccount) {
        throw new Error("google-timeline parser requires a source account");
      }
      return importTimelineData(db, filePath, sourceAccount);
    };
  },
  "claude": async () => {
    const { importClaudeExport } = await import("../parsers/claude");
    return (db, filePath, sourceAccount) => {
      if (!sourceAccount) {
        throw new Error("claude parser requires a source account");
      }
      return importClaudeExport(db, filePath, sourceAccount);
    };
  },
  "amex": async () => {
    const { importAmexData } = await import("../parsers/amex");
    return (db, filePath, sourceAccount) => {
      if (!sourceAccount) {
        throw new Error("amex parser requires a source account");
      }
      return importAmexData(db, filePath, sourceAccount);
    };
  },
  "auto-detect": async () => {
    const { processAutoDetectZip } = await import("./zip-handlers");
    return processAutoDetectZip;
  },
};

/**
 * Get parser function for a source
 */
async function getParser(parserName: string): Promise<ParserFunction | null> {
  const loader = PARSERS[parserName];
  if (!loader) {
    return null;
  }
  return await loader();
}

/**
 * Process a single source's inbox folder
 */
export async function processSource(
  config: InboxConfig,
  sourceName: string,
  sourceConfig: InboxSourceConfig,
  options: ProcessOptions
): Promise<ProcessResult> {
  const result: ProcessResult = {
    source: sourceName,
    filesProcessed: 0,
    filesSkipped: 0,
    eventsAdded: 0,
    errors: [],
  };

  const sourcePath = resolveSourcePath(config, sourceConfig);

  if (options.signal?.aborted) {
    if (options.verbose) {
      console.log(`  Inbox processing aborted before starting ${sourceName}`);
    }
    return result;
  }

  // Check if directory exists
  const dir = Bun.file(sourcePath);
  try {
    // Bun.file doesn't work for directories, use stat
    const { stat } = await import("fs/promises");
    const stats = await stat(sourcePath);
    if (!stats.isDirectory()) {
      result.errors.push(`${sourcePath} is not a directory`);
      return result;
    }
  } catch {
    if (options.verbose) {
      console.log(`  Directory does not exist: ${sourcePath}`);
    }
    return result;
  }

  // Get parser
  const parser = await getParser(sourceConfig.parser);
  if (!parser) {
    result.errors.push(`Unknown parser: ${sourceConfig.parser}`);
    return result;
  }

  // Get tracker DB (app-state.db)
  const trackerDb = getTrackerDb();

  // Find unprocessed files
  const patterns = sourceConfig.patterns || ["*"];
  const unprocessed = await findUnprocessedFiles(trackerDb, sourceName, sourcePath, patterns);

  if (options.verbose) {
    console.log(`  Found ${unprocessed.length} unprocessed file(s)`);
  }

  if (unprocessed.length === 0) {
    return result;
  }

  if (options.dryRun) {
    for (const file of unprocessed) {
      console.log(`  [DRY RUN] Would process: ${basename(file.path)}`);
    }
    result.filesSkipped = unprocessed.length;
    return result;
  }

  // Initialize timeline DB
  const timelineDb = getDb();
  initDb(timelineDb);

  // Account may be null for parsers that auto-detect (e.g., google-takeout)
  // Parsers that require an account will error with a clear message
  const accountName = sourceConfig.account ?? null;

  // Build parser context with rclone remote info if available
  const parserContext: ParserContext = {};
  if (sourceConfig.type === "rclone" && sourceConfig.remote) {
    // Extract remote name from "remotename:path" format
    const colonIndex = sourceConfig.remote.indexOf(":");
    if (colonIndex > 0) {
      parserContext.rcloneRemote = sourceConfig.remote.substring(0, colonIndex);
    }
  }
  if (options.signal) {
    parserContext.signal = options.signal;
  }

  // Get app state db for sync logging
  const appStateDb = getAppStateDb();

  // Process each file
  for (const file of unprocessed) {
    if (options.signal?.aborted) {
      if (options.verbose) {
        console.log(`  Inbox processing aborted while scanning ${sourceName}`);
      }
      break;
    }

    const startTime = Date.now();
    let logId: number | null = null;

    // Create sync_log entry before parsing so "Running" state is visible in the UI
    logId = startSyncLog(appStateDb, sourceConfig.parser, options.jobId ?? null);

    try {
      if (options.verbose) {
        console.log(`  Processing: ${basename(file.path)}`);
      }

      const parserResult = await parser(timelineDb, file.path, accountName, parserContext);

      // Handle both number and ParserResult return types
      const eventsAdded = typeof parserResult === "number" ? parserResult : parserResult.eventsAdded;
      const eventsUpdated = typeof parserResult === "number" ? 0 : (parserResult.eventsUpdated ?? 0);
      const detectedType = typeof parserResult === "number" ? sourceConfig.parser : (parserResult.detectedType ?? sourceConfig.parser);

      result.eventsAdded += eventsAdded;
      result.filesProcessed++;

      // Mark as processed with detected type and events count
      markFileProcessed(
        trackerDb,
        sourceName,
        file.path,
        file.hash,
        file.size,
        `inbox-${sourceName}-${Date.now()}`,
        detectedType,
        eventsAdded
      );

      completeSyncLog(appStateDb, logId, {
        source: detectedType,
        success: true,
        eventsAdded,
        eventsUpdated,
        durationMs: Date.now() - startTime,
      });

      // Archive if configured
      const archivePath = getArchivePath(config, sourceName, basename(file.path));
      if (archivePath) {
        if (options.signal?.aborted) {
          if (options.verbose) {
            console.log(`  Inbox processing aborted before archiving ${basename(file.path)}`);
          }
          break;
        }

        await mkdir(dirname(archivePath), { recursive: true });
        await rename(file.path, archivePath);
        if (options.verbose) {
          console.log(`  Archived to: ${archivePath}`);
        }

        // Delete from remote after successful archive (for rclone sources)
        if (sourceConfig.type === "rclone" && sourceConfig.remote) {
          const remotePath = `${sourceConfig.remote}/${basename(file.path)}`;
          const deleted = await deleteFromRemote(
            remotePath,
            options.verbose ?? false,
            options.signal
          );
          if (deleted) {
            if (options.verbose) {
              console.log(`  Deleted from remote: ${remotePath}`);
            }
          } else {
            // Log warning but don't fail - file is safely archived
            console.warn(`  Warning: Failed to delete from remote: ${remotePath}`);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${basename(file.path)}: ${message}`);
      if (options.verbose) {
        console.error(`  Error processing ${basename(file.path)}:`, error);
      }

      completeSyncLog(appStateDb, logId, {
        source: sourceConfig.parser,
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: message,
        durationMs: Date.now() - startTime,
      });
    }
  }

  return result;
}

/**
 * Process all enabled sources
 */
export async function processAll(
  config: InboxConfig,
  options: ProcessOptions
): Promise<ProcessResult[]> {
  const results: ProcessResult[] = [];
  const sources = getEnabledSources(config);

  // Filter by --only if specified
  const only = options.only;
  const filtered = only
    ? sources.filter(([name]) => only.includes(name))
    : sources;

  if (filtered.length === 0) {
    console.log("No sources to process");
    return results;
  }

  for (const [name, sourceConfig] of filtered) {
    if (options.signal?.aborted) {
      if (options.verbose) {
        console.log("Inbox processing aborted before completing all sources");
      }
      break;
    }

    if (options.verbose) {
      console.log(`\nProcessing source: ${name}`);
    }

    const result = await processSource(config, name, sourceConfig, options);
    results.push(result);

    // Print result
    if (result.filesProcessed > 0 || result.errors.length > 0) {
      const status = result.errors.length > 0 ? "\x1b[33m!\x1b[0m" : "\x1b[32m✓\x1b[0m";
      console.log(
        `${status} ${name}: ${result.filesProcessed} file(s), +${result.eventsAdded} events`
      );
    } else if (options.verbose) {
      console.log(`  No new files`);
    }

    for (const error of result.errors) {
      console.error(`  \x1b[31m✗\x1b[0m ${error}`);
    }
  }

  return results;
}

/**
 * Show status of all sources
 */
export async function showStatus(config: InboxConfig): Promise<void> {
  console.log("Inbox Sources Status");
  console.log("=".repeat(50));

  const sources = getEnabledSources(config);

  // Get tracker DB (app-state.db)
  const trackerDb = getTrackerDb();

  for (const [name, sourceConfig] of sources) {
    const sourcePath = resolveSourcePath(config, sourceConfig);
    const enabled = sourceConfig.enabled !== false ? "enabled" : "disabled";

    console.log(`\n${name} (${enabled})`);
    console.log(`  Parser: ${sourceConfig.parser}`);
    console.log(`  Path: ${sourcePath}`);

    if (sourceConfig.type === "rclone" && sourceConfig.remote) {
      console.log(`  Remote: ${sourceConfig.remote}`);
    }

    // Check if directory exists
    try {
      const { stat } = await import("fs/promises");
      await stat(sourcePath);
      console.log(`  Status: \x1b[32m✓\x1b[0m Directory exists`);
    } catch {
      console.log(`  Status: \x1b[33m!\x1b[0m Directory not found`);
    }

    // Show processing stats
    const stats = getSourceStats(trackerDb, name);
    if (stats.totalFiles > 0) {
      const sizeStr = formatBytes(stats.totalSize);
      const lastStr = stats.lastProcessed
        ? new Date(stats.lastProcessed + "Z").toLocaleString()
        : "never";
      console.log(`  Processed: ${stats.totalFiles} file(s) (${sizeStr})`);
      console.log(`  Last: ${lastStr}`);
    }
  }
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

/**
 * Delete a file from rclone remote after successful processing
 */
async function deleteFromRemote(
  remotePath: string,
  verbose: boolean,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }

  return new Promise((resolve) => {
    const proc = spawn("rclone", ["deletefile", remotePath], {
      stdio: verbose ? "inherit" : "pipe",
    });

    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}
