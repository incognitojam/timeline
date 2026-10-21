/**
 * Service Status API
 *
 * Provides status endpoints for monitoring the Timeline service:
 * - Service health and uptime
 * - Sync scheduler status
 * - Inbox watcher status
 * - Recent sync history
 */

import { mkdir } from "fs/promises";
import { Hono } from "hono";
import { basename, join } from "path";
import { loadConfig, parseInterval, resolveSourcePath } from "../config";
import { getAppStateDb } from "../db/app-state";
import { enqueueJob, listJobs } from "../jobs/store";
import type { TimelineServiceStatus } from "../shared/version";
import { SYNC_SOURCES } from "../sync/sources";
import { loadSyncSourcesConfig } from "../sync/config";
import { getRecentSyncLogs } from "../sync/log";
import type { SyncLogEntry } from "../sync/types";
import { runningVersionInfo } from "../version";
import { getStorageStatus } from "./storage-status";

const registeredSyncSources = new Set(SYNC_SOURCES.map((source) => source.name));

// Service state - set by service.ts on startup
let serviceStartTime: number = Date.now();
let schedulerEnabled: boolean = false;
let watcherEnabled: boolean = false;
let watchedDirectories: string[] = [];

/**
 * Set service state for status API
 * Called by service.ts after components are initialized
 */
export function setServiceComponents(options: {
  startTime?: number;
  schedulerEnabled?: boolean;
  watcherEnabled?: boolean;
  watchedDirectories?: string[];
}): void {
  if (options.startTime) serviceStartTime = options.startTime;
  if (options.schedulerEnabled !== undefined) schedulerEnabled = options.schedulerEnabled;
  if (options.watcherEnabled !== undefined) watcherEnabled = options.watcherEnabled;
  if (options.watchedDirectories) watchedDirectories = options.watchedDirectories;
}

export interface LastSyncRun {
  time: string;
  success: boolean;
  skipped: boolean;
  isRunning: boolean;
  eventsAdded: number;
  eventsUpdated: number;
  error: string | null;
  durationMs: number;
}

export interface SchedulerSourceStatus {
  source: string;
  description: string;
  enabled: boolean;
  isRunning: boolean;
  intervalMs: number;
  lastRun: LastSyncRun | null;
  nextRunAt: string | null;
}

export interface InboxSourceStatus {
  source: string;
  filesProcessed: number;
  totalSize: number;
  totalEvents: number;
  lastProcessed: string | null;
  lastDetectedType: string | null;
}

interface SchedulerStateRow {
  source: string;
  last_run_at: string | null;
  next_run_at: string | null;
  interval_ms: number;
  enabled: number;
}

/**
 * Get service state for status display
 */
export function getServiceState(): {
  startTime: number;
  schedulerEnabled: boolean;
  watcherEnabled: boolean;
  watchedDirectories: string[];
} {
  return {
    startTime: serviceStartTime,
    schedulerEnabled,
    watcherEnabled,
    watchedDirectories,
  };
}

/**
 * Get persisted scheduler rows that still correspond to currently configured
 * sync sources. scheduler_state is durable, so sources removed from config can
 * otherwise linger in status after a migration.
 */
export async function getSchedulerSourceStatuses(): Promise<SchedulerSourceStatus[]> {
  const appDb = getAppStateDb();
  const config = await loadConfig();
  const configuredSources = loadSyncSourcesConfig(
    appDb,
    registeredSyncSources,
  );
  const configuredSourceNames = Object.keys(configuredSources).sort();

  if (configuredSourceNames.length === 0) return [];

  const states = appDb
    .prepare("SELECT * FROM scheduler_state ORDER BY source")
    .all() as SchedulerStateRow[];
  const statesBySource = new Map(states.map((state) => [state.source, state]));

  return configuredSourceNames.map((source) => {
    const sourceConfig = configuredSources[source];
    const state = statesBySource.get(source);
    const intervalMs = state?.interval_ms ??
      (sourceConfig.interval
        ? parseInterval(sourceConfig.interval)
        : parseInterval(config.scheduler.default_interval));
    const syncSource = SYNC_SOURCES.find((candidate) => candidate.name === source);
    const enabled = sourceConfig.enabled !== false;

    return {
      source,
      description: syncSource?.description ?? "Unknown source",
      enabled,
      isRunning: false,
      intervalMs,
      lastRun: getLastSyncForSource(source),
      nextRunAt: enabled && state?.next_run_at ? state.next_run_at + "Z" : null,
    };
  });
}

/**
 * Get the last sync run for a source from the sync log
 */
export function getLastSyncForSource(source: string): LastSyncRun | null {
  const appDb = getAppStateDb();
  const entry = appDb
    .prepare(
      `SELECT * FROM sync_log
       WHERE source = ?
       ORDER BY started_at DESC
       LIMIT 1`
    )
    .get(source) as SyncLogEntry | null;

  if (!entry) return null;

  return {
    time: entry.started_at + "Z",
    success: entry.success === 1,
    skipped: entry.skipped === 1,
    isRunning: entry.finished_at === null,
    eventsAdded: entry.events_added,
    eventsUpdated: entry.events_updated,
    error: entry.error,
    durationMs: entry.duration_ms ?? 0,
  };
}

/**
 * Get inbox source statistics from processed_files table
 */
export function getInboxStats(): InboxSourceStatus[] {
  const appDb = getAppStateDb();
  const stats = appDb
    .prepare(
      `SELECT
         source,
         COUNT(*) as file_count,
         (SELECT file_size FROM processed_files p2
          WHERE p2.source = processed_files.source
          ORDER BY processed_at DESC LIMIT 1) as total_size,
         COALESCE(SUM(events_added), 0) as total_events,
         MAX(processed_at) as last_processed
       FROM processed_files
       GROUP BY source
       ORDER BY source`
    )
    .all() as {
    source: string;
    file_count: number;
    total_size: number;
    total_events: number;
    last_processed: string | null;
  }[];

  // Get the most recent detected_type for each source
  const lastTypes = appDb
    .prepare(
      `SELECT source, detected_type
       FROM processed_files
       WHERE (source, processed_at) IN (
         SELECT source, MAX(processed_at)
         FROM processed_files
         GROUP BY source
       )`
    )
    .all() as { source: string; detected_type: string | null }[];

  const typeMap = new Map(lastTypes.map((t) => [t.source, t.detected_type]));

  return stats.map((s) => ({
    source: s.source,
    filesProcessed: s.file_count,
    totalSize: s.total_size || 0,
    totalEvents: s.total_events,
    lastProcessed: s.last_processed,
    lastDetectedType: typeMap.get(s.source) ?? null,
  }));
}

/**
 * Format interval in milliseconds to human-readable string
 */
export function formatInterval(ms: number): string {
  if (ms >= 24 * 60 * 60 * 1000) {
    return `${ms / (24 * 60 * 60 * 1000)}d`;
  }
  if (ms >= 60 * 60 * 1000) {
    return `${ms / (60 * 60 * 1000)}h`;
  }
  if (ms >= 60 * 1000) {
    return `${ms / (60 * 1000)}m`;
  }
  return `${ms / 1000}s`;
}

export const statusRoutes = new Hono()
  // Main status endpoint - comprehensive service status
  .get("/api/status", async (c) => {
    // Get scheduler status from database (scheduler runs in worker thread)
    const schedulerSources = schedulerEnabled ? await getSchedulerSourceStatuses() : [];

    // Get inbox stats
    const inboxStats = getInboxStats();

    // Active jobs (queued + running) — lets the UI show queue depth at a glance
    // without each card polling, and surfaces backups (scheduler enqueueing
    // faster than the runner drains).
    const queue = listJobs({ status: ["queued", "running"], limit: 200 });

    return c.json({
      service: {
        uptime: Math.floor((Date.now() - serviceStartTime) / 1000),
        startedAt: new Date(serviceStartTime).toISOString(),
        version: runningVersionInfo,
      } satisfies TimelineServiceStatus,
      scheduler: {
        enabled: schedulerEnabled,
        sources: schedulerSources,
      },
      inbox: {
        enabled: watcherEnabled,
        watchedDirs: watchedDirectories,
        sources: inboxStats,
      },
      queue,
    });
  })

  // Sync history endpoint
  .get("/api/status/sync-history", (c) => {
    const query = c.req.query();
    const appDb = getAppStateDb();
    const limit = Math.min(parseInt(query.limit ?? "20"), 100);
    const entries = getRecentSyncLogs(appDb, query.source, limit);
    return c.json({ entries, count: entries.length });
  })

  // Manual sync trigger endpoint — enqueues a `sync` job and returns its id.
  // The runner picks it up; clients poll /api/jobs/:id for completion.
  .post("/api/status/trigger-sync", async (c) => {
    try {
      const body = await c.req.json();
      const source = body.source;

      if (!source || typeof source !== "string") {
        return c.json(
          { success: false, message: "Missing source parameter" },
          400
        );
      }

      if (!registeredSyncSources.has(source)) {
        return c.json({ success: false, message: `Unknown sync source: ${source}` }, 404);
      }

      const outcome = enqueueJob({
        kind: "sync",
        source,
        dedupeKey: `sync:${source}`,
        trigger: "manual",
      });

      return c.json({
        success: true,
        jobId: outcome.jobId,
        deduped: outcome.deduped,
        message: outcome.deduped
          ? `Sync already queued or running (job #${outcome.jobId})`
          : `Sync queued (job #${outcome.jobId})`,
      });
    } catch (error) {
      return c.json(
        {
          success: false,
          message: error instanceof Error ? error.message : "Failed to queue sync",
        },
        500
      );
    }
  })

  // Storage status (ZFS, disk, database)
  .get("/api/status/storage", async (c) => {
    return c.json(await getStorageStatus());
  })

  // GET endpoint for triggering syncs from markdown links — enqueues, redirects.
  .get("/api/status/trigger-sync", async (c) => {
    const source = c.req.query("source");
    if (source) {
      if (!registeredSyncSources.has(source)) {
        return c.json({ success: false, message: `Unknown sync source: ${source}` }, 404);
      }
      try {
        enqueueJob({
          kind: "sync",
          source,
          dedupeKey: `sync:${source}`,
          trigger: "manual",
        });
      } catch (error) {
        console.error("trigger-sync (GET) enqueue failed:", error);
      }
    }
    return c.redirect("/status");
  })

  // Configured inbox sources for upload UI
  .get("/api/status/inbox-sources", async (c) => {
    const config = await loadConfig();
    const sources = Object.entries(config.inbox.sources).map(([name, src]) => ({
      name,
      parser: src.parser,
      account: src.account ?? null,
      patterns: src.patterns ?? ["*"],
      enabled: src.enabled !== false,
    }));
    return c.json({
      basePath: config.inbox.base_path,
      archivePath: config.inbox.archive_path ?? null,
      sources,
    });
  })

  // File upload to inbox
  .post("/api/inbox/upload", async (c) => {
    if (!watcherEnabled) {
      return c.json({ success: false, message: "Inbox watcher is not enabled — uploaded files would not be processed" }, 400);
    }

    const body = await c.req.parseBody();
    const file = body.file;
    const sourceName = body.source;

    if (!file || !(file instanceof File)) {
      return c.json({ success: false, message: "No file provided" }, 400);
    }

    if (!sourceName || typeof sourceName !== "string") {
      return c.json({ success: false, message: "Missing source parameter" }, 400);
    }

    // Validate filename
    const filename = file.name;
    if (!filename || filename.includes("..") || filename.startsWith(".")) {
      return c.json({ success: false, message: "Invalid filename" }, 400);
    }

    // 500MB limit
    if (file.size > 500 * 1024 * 1024) {
      return c.json({ success: false, message: "File too large (max 500MB)" }, 400);
    }

    // Look up the inbox source config
    const config = await loadConfig();
    const sourceConfig = config.inbox.sources[sourceName];
    if (!sourceConfig) {
      return c.json({ success: false, message: `Unknown inbox source: ${sourceName}` }, 400);
    }

    if (sourceConfig.enabled === false) {
      return c.json({ success: false, message: `Inbox source "${sourceName}" is disabled` }, 400);
    }

    // Validate filename against source patterns
    const patterns = sourceConfig.patterns ?? ["*"];
    const matchesPattern = patterns.some((pattern) => {
      const regex = new RegExp(
        "^" +
          pattern
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".") +
          "$",
        "i"
      );
      return regex.test(basename(filename));
    });
    if (!matchesPattern) {
      return c.json(
        { success: false, message: `File "${basename(filename)}" does not match accepted patterns: ${patterns.join(", ")}` },
        400
      );
    }

    // Resolve target directory and ensure it exists
    const targetDir = resolveSourcePath(config, sourceConfig);
    await mkdir(targetDir, { recursive: true });

    // Write file, then enqueue an inbox-process job directly so uploads do not
    // depend on a separate fs.watch event.
    const targetPath = join(targetDir, basename(filename));
    await Bun.write(targetPath, file);

    const outcome = enqueueJob({
      kind: "inbox-process",
      source: sourceName as string,
      dedupeKey: `inbox-process:${sourceName}`,
      trigger: "upload",
    });

    return c.json({
      success: true,
      filename: basename(filename),
      jobId: outcome.jobId,
      deduped: outcome.deduped,
      message: outcome.deduped
        ? `File uploaded; processing already queued (job #${outcome.jobId})`
        : `File uploaded; processing queued (job #${outcome.jobId})`,
    });
  });
