/**
 * Timeline Service - Runtime
 *
 * Runs the complete Timeline service including:
 * - API server (Hono)
 * - Sync scheduler
 * - Inbox file watcher
 */

import { Worker } from "worker_threads";
import { assertApiAuthConfigured } from "./api/auth";
import { setSyncConfigChangedNotifier } from "./api/service-control";
import { setServiceComponents } from "./api/status";
import type { ServiceConfig } from "./config";
import { normalizeStoredPackagedSyncPaths } from "./config/packaged-sync-paths";
import { getAppStateDb } from "./db/app-state";
import { failAllRunningJobs, reclaimExpiredLeases } from "./jobs/store";
import { buildMediaStore } from "./media/storage";
import { getPackagedResourceRoot, getSchedulerWorkerPath } from "./runtime-paths";
import { gracefullyStopWorker } from "./scheduler/worker-control";
import { importTomlSyncSourcesIfEmpty } from "./sync/config";
import { cleanupOrphanedSyncLogs } from "./sync/log";
import { SYNC_SOURCES } from "./sync/sources";

export async function runService(
  config: ServiceConfig,
  options: { verbose: boolean },
): Promise<void> {
  const { verbose } = options;
  assertApiAuthConfigured();

  // Fail fast if media storage is misconfigured — e.g. R2 enabled but a secret
  // is missing or the encryption key fails its self-test. Building the store
  // runs those checks now, rather than starting "healthy" and only erroring on
  // the first attachment. No-op for the default local-only backend.
  await buildMediaStore(config.media);

  if (verbose) {
    console.log("Config loaded:");
    console.log(`  Database: ${config.database.path}`);
    console.log(`  Server: ${config.server.host}:${config.server.port}`);
  }

  // Clean up any orphaned sync log entries from previous runs
  const appDb = getAppStateDb();
  importTomlSyncSourcesIfEmpty(
    appDb,
    config,
    console,
    new Set(SYNC_SOURCES.map((source) => source.name)),
  );
  if (getPackagedResourceRoot()) {
    const normalizedCount = normalizeStoredPackagedSyncPaths(appDb, SYNC_SOURCES);
    if (normalizedCount > 0) {
      console.log(`Normalized path settings for ${normalizedCount} sync source(s)`);
    }
  }

  const orphanedCount = cleanupOrphanedSyncLogs(appDb);
  if (orphanedCount > 0) {
    console.log(`Cleaned up ${orphanedCount} orphaned sync log entries`);
  }

  // Mark any jobs left in `running` from a previous run as failed.
  // Single-worker assumption: nothing else holds leases at startup.
  const orphanedJobCount = failAllRunningJobs(appDb);
  if (orphanedJobCount > 0) {
    console.log(`Marked ${orphanedJobCount} stale running job(s) as failed`);
  }
  // Also reclaim any leases that simply expired (defensive — no-op normally).
  // No worker is live at startup, so reclaim everything (exclude nothing).
  reclaimExpiredLeases(null, appDb);

  // Track components for shutdown
  let worker: Worker | null = null;
  let isShuttingDown = false;

  const startTime = Date.now();
  const RELOAD_TIMEOUT_MS = 30_000;
  const workerStates = new WeakMap<Worker, { exited: boolean }>();

  const getInboxDirectories = (cfg: ServiceConfig): string[] =>
    Object.values(cfg.inbox.sources || {}).map((s) => `${cfg.inbox.base_path}/${s.local}`);

  let restartAttempt = 0;
  const RESTART_BACKOFF_BASE_MS = 1_000;
  const RESTART_BACKOFF_MAX_MS = 30_000;

  const startWorker = (cfg: ServiceConfig): Worker => {
    const workerScript = getSchedulerWorkerPath();
    const newWorker = new Worker(workerScript);
    const state = { exited: false };
    workerStates.set(newWorker, state);

    // Handle messages from worker (for logging + restart-attempt reset on ready)
    newWorker.on("message", (message) => {
      if (message?.type === "status" && message?.details?.status === "ready") {
        restartAttempt = 0;
      }
      if (verbose) {
        console.log(`Worker message: ${message.type}`, message.details || "");
      }
    });

    newWorker.on("error", (error) => {
      console.error("Worker error:", error);
    });

    newWorker.on("exit", (code) => {
      state.exited = true;
      if (code !== 0 && !isShuttingDown) {
        console.error(`Worker exited with code ${code}`);
      }
      if (worker === newWorker) {
        worker = null;
      }

      // Auto-restart on unexpected exit (skip during shutdown).
      if (!isShuttingDown && code !== 0) {
        const backoffMs = Math.min(
          RESTART_BACKOFF_BASE_MS * 2 ** restartAttempt,
          RESTART_BACKOFF_MAX_MS
        );
        restartAttempt++;
        console.log(`Restarting worker in ${backoffMs}ms (attempt ${restartAttempt})...`);
        setTimeout(() => {
          if (isShuttingDown || worker) return;
          try {
            worker = startWorker(config);
            void waitForWorkerStatus(worker, "ready", RELOAD_TIMEOUT_MS, () => {
              if (worker) sendWorkerInit(worker, config);
            }).catch((error) => {
              console.error("Worker restart failed to become ready:", error);
            });
          } catch (error) {
            console.error("Failed to start worker during restart:", error);
          }
        }, backoffMs);
      }
    });

    return newWorker;
  };

  const sendWorkerInit = (targetWorker: Worker, cfg: ServiceConfig): void => {
    targetWorker.postMessage({
      type: "init",
      config: cfg,
      options: { verbose },
    });
  };

  const waitForWorkerStatus = (
    currentWorker: Worker,
    expectedStatus: string,
    timeoutMs: number,
    sendMessage?: () => void
  ): Promise<void> => {
    if (workerStates.get(currentWorker)?.exited) {
      return Promise.reject(new Error(`Worker already exited while waiting for ${expectedStatus}`));
    }

    return new Promise((resolve, reject) => {
      const onMessage = (message: { type?: string; details?: { status?: string; error?: string } }) => {
        if (message?.type !== "status") return;
        const status = message.details?.status;
        if (status === expectedStatus) {
          cleanup();
          resolve();
          return;
        }
        if (status === "init-error") {
          cleanup();
          reject(new Error(message.details?.error || `Worker failed while waiting for ${expectedStatus}`));
        }
      };

      const onExit = (code: number) => {
        cleanup();
        reject(new Error(`Worker exited with code ${code} while waiting for ${expectedStatus}`));
      };

      const onError = (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for worker status "${expectedStatus}"`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        currentWorker.off("message", onMessage);
        currentWorker.off("exit", onExit);
        currentWorker.off("error", onError);
      };

      currentWorker.on("message", onMessage);
      currentWorker.once("exit", onExit);
      currentWorker.once("error", onError);

      if (sendMessage) {
        try {
          sendMessage();
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  };

  const stopWorker = async (context: string): Promise<void> => {
    const currentWorker = worker;
    if (!currentWorker) return;
    try {
      // Hand off to the worker's own graceful shutdown (runner.stop() requeues
      // the in-flight job; scheduler/watcher stop) and wait for it to exit
      // before terminating. A bare terminate() here races out that cleanup.
      const { forced } = await gracefullyStopWorker(currentWorker, RELOAD_TIMEOUT_MS);
      if (forced) {
        console.warn(
          `Scheduler worker did not exit within ${RELOAD_TIMEOUT_MS}ms; forced terminate${
            context ? ` (${context})` : ""
          }`
        );
      }
      console.log(`Scheduler worker stopped${context ? ` (${context})` : ""}`);
      if (worker === currentWorker) {
        worker = null;
      }
    } catch (error) {
      console.error("Error stopping worker:", error);
      throw error;
    }
  };

  // Start scheduler worker (handles sync scheduler + inbox watcher)
  if (config.scheduler.enabled || config.inbox.watch_enabled) {
    try {
      worker = startWorker(config);
      await waitForWorkerStatus(worker, "ready", RELOAD_TIMEOUT_MS, () => {
        if (worker) sendWorkerInit(worker, config);
      });
      console.log("Scheduler worker started");
    } catch (error) {
      console.error("Failed to start scheduler worker:", error);
      await stopWorker("startup failure");
      throw error;
    }
  } else {
    console.log("Scheduler and inbox watcher are disabled; worker not started");
  }

  // Start API server (import dynamically to respect env vars set above)
  // We need to set env vars before importing the API module
  process.env.TIMELINE_HOST = process.env.TIMELINE_HOST || config.server.host;
  process.env.TIMELINE_PORT = String(process.env.TIMELINE_PORT || config.server.port);
  process.env.TIMELINE_DB_PATH = process.env.TIMELINE_DB_PATH || config.database.path;

  // Set service state for status API
  const inboxDirs = getInboxDirectories(config);
  setServiceComponents({
    startTime,
    schedulerEnabled: config.scheduler.enabled,
    watcherEnabled: config.inbox.watch_enabled,
    watchedDirectories: inboxDirs,
  });

  setSyncConfigChangedNotifier(() => {
    if (worker) {
      worker.postMessage({ type: "sync-config-changed" });
    }
  });

  // Import API module - this starts the server (also triggers initProviders)
  const { shutdownApi } = await import("./api/index");

  console.log("\nTimeline service is running");
  console.log(`API: http://${config.server.host}:${config.server.port}`);
  console.log("Press Ctrl+C to stop\n");

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\nReceived ${signal}, shutting down...`);

    try {
      await shutdownApi();
    } catch (error) {
      console.error("Failed to stop API during shutdown:", error);
    }

    try {
      await stopWorker("");
    } catch (error) {
      console.error("Failed to stop scheduler worker during shutdown:", error);
    }

    console.log("Shutdown complete");
    process.exit(0);
  };

  // Register signal handlers
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Keep process running
  await new Promise(() => {});
}
