/**
 * Inbox File Watcher
 *
 * Watches inbox directories for new files and automatically processes them.
 * Uses debouncing to wait for files to finish writing before processing.
 */

import { watch, type FSWatcher } from "fs";
import { mkdir, stat } from "fs/promises";
import { join } from "path";
import type { ServiceConfig, InboxSourceConfig } from "../config";
import { resolveSourcePath } from "../config";
import { processSource, type ProcessResult } from "./process";
import type { InboxConfig } from "./config";
import { enqueueJob } from "../jobs/store";
import type { EnqueueOutcome, JobTrigger } from "../jobs/types";

export interface WatcherOptions {
  verbose?: boolean;
  debounceMs?: number;
}

interface PendingFile {
  path: string;
  lastSize: number;
  lastModified: number;
  checkCount: number;
}

export class InboxWatcher {
  private config: ServiceConfig;
  private watchers: Map<string, FSWatcher> = new Map();
  private pendingFiles: Map<string, PendingFile> = new Map();
  private debounceTimers: Map<string, Timer> = new Map();
  private stabilityTimer: Timer | null = null;
  private abortController: AbortController | null = null;
  private isStopping = false;
  private isStarted = false;
  private verbose: boolean;
  private debounceMs: number;

  constructor(config: ServiceConfig, options: WatcherOptions = {}) {
    this.config = config;
    this.verbose = options.verbose ?? false;
    this.debounceMs = options.debounceMs ?? 5000; // 5 seconds default
  }

  /**
   * Start watching all configured inbox directories
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      throw new Error("InboxWatcher already started");
    }

    this.isStopping = false;
    this.abortController = new AbortController();
    this.isStarted = true;

    try {
      // Start watching each enabled source directory
      for (const [sourceName, sourceConfig] of Object.entries(this.config.inbox.sources)) {
        if (sourceConfig.enabled === false) {
          if (this.verbose) {
            console.log(`InboxWatcher: Source "${sourceName}" is disabled, skipping`);
          }
          continue;
        }

        await this.watchSource(sourceName, sourceConfig);
      }

      // Start stability checker
      this.startStabilityChecker();

      if (this.verbose) {
        console.log(`InboxWatcher: Started with ${this.watchers.size} directories`);
      }
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  /**
   * Stop watching all directories
   */
  stop(): void {
    this.isStopping = true;
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort("Inbox watcher stopped");
    }

    for (const [source, watcher] of this.watchers) {
      watcher.close();
      if (this.verbose) {
        console.log(`InboxWatcher: Stopped watching ${source}`);
      }
    }
    this.watchers.clear();

    // Clear all timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.stabilityTimer) {
      clearInterval(this.stabilityTimer);
      this.stabilityTimer = null;
    }

    this.pendingFiles.clear();
    this.isStarted = false;
  }

  /**
   * Get list of watched directories
   */
  getWatchedDirectories(): string[] {
    return Array.from(this.watchers.keys());
  }

  /**
   * Enqueue an inbox-process job for the given source.
   *
   * Used by the upload endpoint and by the fs.watch stability checker.
   * Dedupe key ensures multiple uploads/events collapse into a single job —
   * `processSource` sweeps all unprocessed files for the source on each run.
   */
  enqueueProcess(sourceName: string, trigger: JobTrigger = "inbox-watcher"): EnqueueOutcome {
    const sourceConfig = this.config.inbox.sources[sourceName];
    if (!sourceConfig) {
      throw new Error(`Unknown inbox source: ${sourceName}`);
    }
    return enqueueJob({
      kind: "inbox-process",
      source: sourceName,
      dedupeKey: `inbox-process:${sourceName}`,
      trigger,
    });
  }

  /**
   * Execute an inbox-process job in-process.
   *
   * Called by the job runner when claiming an `inbox-process` job — NOT by the
   * API or the stability checker. Sweeps all unprocessed files for the source.
   */
  async runProcessJob(
    sourceName: string,
    options: { signal?: AbortSignal; jobId?: number | null } = {}
  ): Promise<ProcessResult> {
    const sourceConfig = this.config.inbox.sources[sourceName];
    if (!sourceConfig) {
      throw new Error(`Unknown inbox source: ${sourceName}`);
    }

    const inboxConfig: InboxConfig = {
      sources: { [sourceName]: sourceConfig },
      inbox_path: this.config.inbox.base_path,
      archive_path: this.config.inbox.archive_path,
    };

    const signal = options.signal ?? this.abortController?.signal;

    const result = await processSource(inboxConfig, sourceName, sourceConfig, {
      verbose: this.verbose,
      signal,
      jobId: options.jobId ?? null,
    });

    if (result.filesProcessed > 0) {
      console.log(
        `InboxWatcher: ${sourceName}: ${result.filesProcessed} file(s), +${result.eventsAdded} events`
      );
    }

    for (const error of result.errors) {
      console.error(`InboxWatcher: ${sourceName}: ${error}`);
    }

    return result;
  }

  // Private methods

  /**
   * Watch a single source, creating its directory first if needed.
   */
  private async watchSource(sourceName: string, sourceConfig: InboxSourceConfig): Promise<void> {
    // Resolve the source path using the full service config
    const sourcePath = resolveSourcePath(this.config, sourceConfig);

    // Ensure directory exists (create if needed so uploads always land in a watched path)
    const stats = await stat(sourcePath).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });

    if (stats) {
      if (!stats.isDirectory()) {
        throw new Error(`Inbox source "${sourceName}" path is not a directory: ${sourcePath}`);
      }
    } else {
      // Directory doesn't exist — create it so the watcher and upload endpoint agree.
      await mkdir(sourcePath, { recursive: true });
      if (this.verbose) {
        console.log(`InboxWatcher: Created ${sourcePath} for ${sourceName}`);
      }
    }

    // Start watching
    try {
      // Bail if we were torn down while the directory check above was awaiting:
      // stop() may have cleared this.watchers, and installing now would leak an
      // FSWatcher that never gets close()d (keeping the event loop alive). There
      // is no await between this check and watchers.set() below.
      if (this.isStopping || this.abortController?.signal.aborted) {
        return;
      }

      const watcher = watch(sourcePath, { persistent: true }, (eventType, filename) => {
        if (filename) {
          this.onFileEvent(sourceName, sourceConfig, sourcePath, filename, eventType);
        }
      });

      watcher.on("error", (error) => {
        console.error(`InboxWatcher: Error watching ${sourceName}:`, error);
      });

      this.watchers.set(sourceName, watcher);

      if (this.verbose) {
        console.log(`InboxWatcher: Watching ${sourcePath} for ${sourceName}`);
      }
    } catch (error) {
      throw new Error(
        `Failed to watch inbox source "${sourceName}" at ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private onFileEvent(
    sourceName: string,
    sourceConfig: InboxSourceConfig,
    sourcePath: string,
    filename: string,
    eventType: string
  ): void {
    if (this.isStopping || this.abortController?.signal.aborted) {
      return;
    }

    // Ignore events for hidden files and temp files
    if (filename.startsWith(".") || filename.endsWith(".tmp") || filename.endsWith(".part")) {
      return;
    }

    // Check if file matches patterns
    const patterns = sourceConfig.patterns || ["*"];
    if (!this.matchesPatterns(filename, patterns)) {
      return;
    }

    const filePath = join(sourcePath, filename);
    const key = `${sourceName}:${filePath}`;

    if (this.verbose) {
      console.log(`InboxWatcher: ${eventType} event for ${filename} in ${sourceName}`);
    }

    // Add to pending files for stability checking
    this.pendingFiles.set(key, {
      path: filePath,
      lastSize: 0,
      lastModified: Date.now(),
      checkCount: 0,
    });
  }

  private matchesPatterns(filename: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      // Simple glob matching (supports * and ?)
      const regex = new RegExp(
        "^" +
          pattern
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".") +
          "$",
        "i"
      );
      if (regex.test(filename)) {
        return true;
      }
    }
    return false;
  }

  private startStabilityChecker(): void {
    // Check file stability every second
    this.stabilityTimer = setInterval(() => {
      this.checkFileStability();
    }, 1000);
  }

  private async checkFileStability(): Promise<void> {
    const now = Date.now();
    const stableFiles: string[] = [];

    for (const [key, pending] of this.pendingFiles) {
      if (this.isStopping || this.abortController?.signal.aborted) {
        return;
      }

      try {
        const stats = await stat(pending.path);

        // Check if file size has stabilized
        if (stats.size === pending.lastSize) {
          pending.checkCount++;

          // File is stable after 3 consecutive checks (3 seconds)
          if (pending.checkCount >= 3) {
            stableFiles.push(key);
          }
        } else {
          // Size changed, reset counter
          pending.lastSize = stats.size;
          pending.lastModified = now;
          pending.checkCount = 0;
        }
      } catch {
        // File no longer exists, remove from pending
        this.pendingFiles.delete(key);
      }
    }

    // Enqueue one inbox-process job per source that has stable files.
    // Dedupe collapses multiple stable files for the same source into a single job;
    // processSource sweeps all unprocessed files in the directory anyway.
    const sourcesToEnqueue = new Set<string>();
    for (const key of stableFiles) {
      if (this.isStopping || this.abortController?.signal.aborted) {
        return;
      }
      this.pendingFiles.delete(key);
      const [sourceName] = key.split(":");
      sourcesToEnqueue.add(sourceName);
    }

    for (const sourceName of sourcesToEnqueue) {
      try {
        const outcome = this.enqueueProcess(sourceName, "inbox-watcher");
        if (this.verbose) {
          console.log(
            `InboxWatcher: enqueued ${sourceName} (job #${outcome.jobId}${outcome.deduped ? ", deduped" : ""})`
          );
        }
      } catch (error) {
        console.error(`InboxWatcher: Failed to enqueue ${sourceName}:`, error);
      }
    }
  }
}

/**
 * Create an inbox watcher instance from config
 */
export function createInboxWatcher(
  config: ServiceConfig,
  options?: WatcherOptions
): InboxWatcher {
  return new InboxWatcher(config, options);
}
