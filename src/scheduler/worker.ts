#!/usr/bin/env bun
/**
 * Scheduler Worker Thread
 *
 * Runs in a separate Bun Worker thread to keep the API event loop responsive.
 * The worker:
 * - Runs the sync scheduler (decides when to enqueue sync jobs)
 * - Runs the inbox file watcher (enqueues inbox-process jobs on stable files)
 * - Runs the job runner (claims queued jobs and dispatches them)
 *
 * All "do this now" requests from the API are durable rows in `app-state.db`
 * (`jobs` table). The worker no longer receives `trigger-sync` /
 * `process-inbox` postMessages; postMessage is only for lifecycle and
 * lightweight config-change nudges.
 *
 * Architecture:
 * ```
 * Main Process (API)              Worker Thread
 * ├── API Server                  ├── Sync Scheduler  (enqueues sync jobs)
 * └── App State DB (read/write)   ├── Inbox Watcher   (enqueues inbox-process jobs)
 *                                 ├── Job Runner      (claims + executes jobs)
 *                                 └── Timeline DB     (write only)
 * ```
 */

import { parentPort } from "worker_threads";
import type { ServiceConfig } from "../config";
import { Scheduler } from "./index";
import { InboxWatcher } from "../inbox/watcher";
import { JobRunner, type JobHandler } from "../jobs/runner";
import type { Job, JobKind } from "../jobs/types";
import { syncJobResult } from "./job-result";
import { attachmentDescriptionsSyncSource } from "../sync/sources/attachment-descriptions";
import { lowerThreadToBackground } from "../lib/background-priority";

interface WorkerMessage {
  type:
    | "status"
    | "init"
    | "sync-config-changed"
    | "shutdown";
  details?: Record<string, unknown>;
  config?: ServiceConfig;
  options?: { verbose?: boolean; stopTimeoutMs?: number };
}

let scheduler: Scheduler | null = null;
let watcher: InboxWatcher | null = null;
let runner: JobRunner | null = null;
let isShuttingDown = false;
const STOP_TIMEOUT_MS = 30_000;

function sendMessage(message: WorkerMessage): void {
  if (parentPort) {
    parentPort.postMessage(message);
  }
}

function buildHandlers(
  currentScheduler: Scheduler | null,
  currentWatcher: InboxWatcher | null
): Partial<Record<JobKind, JobHandler>> {
  return {
    sync: async (job, signal, localWork) => {
      if (!currentScheduler) {
        throw new Error("Scheduler not initialized");
      }
      if (!job.source) {
        throw new Error("sync job is missing `source`");
      }
      const result = await currentScheduler.runNow(job.source, job.id, signal, job.trigger, localWork);
      if (!result.success) {
        throw new Error(result.error || "Sync failed");
      }
      return syncJobResult(result);
    },
    "inbox-process": async (job: Job, signal: AbortSignal) => {
      if (!currentWatcher) {
        throw new Error("Inbox watcher not initialized");
      }
      if (!job.source) {
        throw new Error("inbox-process job is missing `source`");
      }
      const result = await currentWatcher.runProcessJob(job.source, {
        signal,
        jobId: job.id,
      });

      // Hard failure only when nothing made it through. Per-file errors when
      // some files succeeded are surfaced in the job result, not by failing
      // the whole job — otherwise successfully-processed files in the same
      // batch become invisible in the UI.
      if (result.filesProcessed === 0 && result.errors.length > 0) {
        throw new Error(result.errors.join("; "));
      }
      return {
        source: result.source,
        filesProcessed: result.filesProcessed,
        filesSkipped: result.filesSkipped,
        eventsAdded: result.eventsAdded,
        errors: result.errors,
      };
    },
  };
}

async function startComponents(config: ServiceConfig, verbose: boolean): Promise<void> {
  try {
    if (config.scheduler.enabled) {
      scheduler = new Scheduler(config, { verbose });
      await scheduler.start();
      console.log("[Worker] Scheduler started");
    }

    if (config.inbox.watch_enabled) {
      watcher = new InboxWatcher(config, { verbose });
      await watcher.start();
      console.log("[Worker] Inbox watcher started");
    }

    // Start the job runner whenever we have anything that produces or consumes jobs.
    if (scheduler || watcher) {
      runner = new JobRunner({
        verbose,
        handlers: buildHandlers(scheduler, watcher),
        overlapSyncSource: attachmentDescriptionsSyncSource.name,
      });
      runner.start();
      console.log("[Worker] Job runner started");
    }
  } catch (error) {
    await stopComponents(STOP_TIMEOUT_MS);
    throw error;
  }
}

async function stopComponents(stopTimeoutMs: number): Promise<{ schedulerOk: boolean }> {
  if (runner) {
    await runner.stop(stopTimeoutMs).catch((error) => {
      console.error("[Worker] Job runner stop error:", error);
    });
    runner = null;
  }

  let schedulerOk = true;
  if (scheduler) {
    try {
      schedulerOk = await scheduler.stopAndWait({ abort: true, timeoutMs: stopTimeoutMs });
    } catch (error) {
      console.error("[Worker] Scheduler stop error:", error);
      schedulerOk = false;
    }
    if (schedulerOk) {
      scheduler = null;
      console.log("[Worker] Scheduler stopped");
    }
  }

  if (watcher) {
    watcher.stop();
    watcher = null;
    console.log("[Worker] Inbox watcher stopped");
  }

  return { schedulerOk };
}

async function initializeWorker(config: ServiceConfig, options: { verbose?: boolean } = {}): Promise<void> {
  console.log("[Worker] Initializing scheduler worker");

  try {
    // Syncs and imports run on the efficiency cores, leaving the API thread at normal priority.
    lowerThreadToBackground();
    await startComponents(config, options.verbose ?? false);
    sendMessage({ type: "status", details: { status: "ready" } });
  } catch (error) {
    console.error("[Worker] Initialization error:", error);
    sendMessage({
      type: "status",
      details: {
        status: "init-error",
        error: `Worker initialization failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    });
  }
}

if (parentPort) {
  parentPort.on("message", async (message: WorkerMessage) => {
    console.log("[Worker] Received message:", message.type);

    switch (message.type) {
      case "init": {
        if (message.config) {
          await initializeWorker(message.config, message.options);
        }
        break;
      }

      case "sync-config-changed": {
        if (!scheduler) break;
        try {
          await scheduler.reloadSyncConfig();
          sendMessage({ type: "status", details: { status: "sync-config-changed" } });
        } catch (error) {
          console.error("[Worker] Sync config apply error:", error);
          sendMessage({
            type: "status",
            details: {
              status: "sync-config-error",
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        break;
      }

      case "shutdown": {
        await shutdown("worker shutdown request");
        process.exit(0);
        break;
      }
    }
  });

  parentPort.on("error", (error) => {
    console.error("[Worker] Parent port error:", error);
  });

  parentPort.on("exit", () => {
    console.log("[Worker] Parent port closed, exiting");
    process.exit(1);
  });
}

async function shutdown(reason: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[Worker] Shutting down (${reason})`);

  await stopComponents(STOP_TIMEOUT_MS);

  sendMessage({ type: "status", details: { status: "shutdown" } });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));

export const workerTestHooks = {
  buildHandlers,
  startComponents,
  stopComponents,
  getComponentState: () => ({
    schedulerRunning: Boolean(scheduler),
    watcherRunning: Boolean(watcher),
    runnerRunning: Boolean(runner),
  }),
};
process.on("SIGINT", () => shutdown("SIGINT"));

console.log("[Worker] Ready, waiting for init message from main thread");
