/**
 * Sync Scheduler
 *
 * Manages scheduled sync operations with per-source intervals,
 * staggered startup, and persistent state.
 */

import type { Database } from "bun:sqlite";
import type { ServiceConfig, SyncSourceConfig } from "../config";
import { formatInterval, isValidTimeoutDelay, loadConfig, parseInterval } from "../config";
import { getAppStateDb, getBlockedNetworks } from "../db/app-state";
import type { LocalWorkGate } from "../jobs/local-work";
import { getDb } from "../db/schema";
import { enqueueJob } from "../jobs/store";
import type { JobTrigger } from "../jobs/types";
import { getVisionAvailability, type VisionAvailability } from "../llm";
import { isSyncSourceEnabled, listSyncSourceRows, loadSyncConfig, loadSyncSourcesConfig } from "../sync/config";
import {
  completeSyncLog,
  formatSyncResult,
  recordSkippedSync,
  startSyncLog,
} from "../sync/log";
import {
  checkNetworkGuard,
  meteredFromStatus,
  parseNetworkGuardConfig,
} from "../sync/network-guard";
import { detectPowerStatus, evaluatePowerGuard, parsePowerGuardConfig } from "../sync/power-guard";
import { SYNC_SOURCES } from "../sync/sources";
import { attachmentDescriptionModelRefs } from "../sync/sources/attachment-descriptions";
import type { SyncOptions, SyncResult, SyncSource } from "../sync/types";

export interface ScheduledTask {
  source: string;
  description: string;
  intervalMs: number;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  isRunning: boolean;
  enabled: boolean;
}

export interface SchedulerState {
  source: string;
  last_run_at: string | null;
  next_run_at: string | null;
  interval_ms: number;
  enabled: number;
}

/**
 * A pre-run guard for a source. Returns a skip {@link SyncResult} to defer the
 * run (the scheduler records it as a `skipped` sync_log row), or null to
 * proceed. The default checks the network, power, and vision guards; future
 * guards compose here. Injectable so the skip path can be tested without real network
 * detection or on-disk config.
 */
export type SyncGuardCheck = (input: {
  source: string;
  sourceConfig: Record<string, unknown> | undefined;
  /** Instance-wide blocked Wi-Fi networks, for sources with `skip_blocked_networks`. */
  blockedNetworks: string[];
}) => Promise<SyncResult | null>;

/**
 * What an individual guard returns when it defers a run. Guards carry only the
 * reason and their own metadata; {@link toSkipResult} owns the SyncResult/skip
 * invariants so each guard need not restate them.
 */
interface GuardSkip {
  /** Which guard deferred (recorded under `metadata.guard`). */
  guard: string;
  reason: string;
  /** Guard-specific metadata merged into the skip record. */
  detail?: Record<string, unknown>;
}

async function networkGuard(
  sourceConfig: Record<string, unknown> | undefined,
  blockedNetworks: string[]
): Promise<GuardSkip | null> {
  const guardConfig = parseNetworkGuardConfig(sourceConfig, blockedNetworks);
  if (!guardConfig) return null;

  const { decision, status } = await checkNetworkGuard(guardConfig);
  if (!decision.skip) return null;

  return {
    guard: "network",
    reason: decision.reason,
    detail: {
      network: {
        ssid: status.ssid ?? null,
        isExpensive: status.isExpensive ?? null,
        isConstrained: status.isConstrained ?? null,
        metered: meteredFromStatus(status) ?? null,
      },
    },
  };
}

async function powerGuard(sourceConfig: Record<string, unknown> | undefined): Promise<GuardSkip | null> {
  if (!parsePowerGuardConfig(sourceConfig)) return null;
  const status = await detectPowerStatus();
  const decision = evaluatePowerGuard(status);
  if (!decision.skip) return null;
  return { guard: "power", reason: decision.reason, detail: { power: status } };
}

export function visionGuardDecision(
  source: string,
  sourceConfig: Record<string, unknown> | undefined,
  availabilities: Array<"unavailable" | "not-vision" | "available" | "unknown">,
): GuardSkip | null {
  const models = attachmentDescriptionModelRefs(sourceConfig);
  if (
    source !== "attachment-descriptions" ||
    !models ||
    availabilities.length !== models.length ||
    !availabilities.every((availability) => availability === "unavailable")
  ) {
    return null;
  }
  return {
    guard: "vision",
    reason: `Vision providers for ${models.join(", ")} are unavailable`,
    detail: { vision: { availability: "unavailable" } },
  };
}

async function visionGuard(source: string, sourceConfig: Record<string, unknown> | undefined): Promise<GuardSkip | null> {
  const models = attachmentDescriptionModelRefs(sourceConfig);
  if (source !== "attachment-descriptions" || !models) return null;
  const config = await loadConfig();
  const availabilities: VisionAvailability[] = [];
  for (const model of models) {
    const availability = await getVisionAvailability(config.llm, model);
    availabilities.push(availability);
    if (availability !== "unavailable") break;
  }
  return visionGuardDecision(
    source,
    sourceConfig,
    availabilities,
  );
}

function toSkipResult(source: string, skip: GuardSkip, durationMs: number): SyncResult {
  return {
    source,
    success: true,
    skipped: true,
    eventsAdded: 0,
    eventsUpdated: 0,
    durationMs,
    metadata: { guard: skip.guard, skipReason: skip.reason, ...skip.detail },
  };
}

/**
 * Default guard pipeline: guards run in order, the first to defer wins. See
 * network-guard.ts and power-guard.ts for their policies.
 */
export const defaultGuardCheck: SyncGuardCheck = async ({ source, sourceConfig, blockedNetworks }) => {
  const startedAt = Date.now();
  const skip = await networkGuard(sourceConfig, blockedNetworks);
  if (skip) return toSkipResult(source, skip, Date.now() - startedAt);
  const powerSkip = await powerGuard(sourceConfig);
  if (powerSkip) return toSkipResult(source, powerSkip, Date.now() - startedAt);
  const visionSkip = await visionGuard(source, sourceConfig);
  if (visionSkip) return toSkipResult(source, visionSkip, Date.now() - startedAt);
  return null;
};

export class Scheduler {
  private config: ServiceConfig;
  private db: Database;
  private syncSources: SyncSource[];
  private registeredSourceNames: Set<string>;
  private timers: Map<string, Timer> = new Map();
  private runningTasks: Set<string> = new Set();
  private inFlightCount = 0;
  private idleWaiters: Array<() => void> = [];
  private abortControllers: Map<string, AbortController> = new Map();
  private isStarted = false;
  private verbose: boolean;
  private guardCheck: SyncGuardCheck;

  constructor(
    config: ServiceConfig,
    options: {
      verbose?: boolean;
      syncSources?: SyncSource[];
      guardCheck?: SyncGuardCheck;
    } = {}
  ) {
    this.config = config;
    this.db = getAppStateDb();
    this.syncSources = options.syncSources ?? SYNC_SOURCES;
    this.registeredSourceNames = new Set(this.syncSources.map((source) => source.name));
    this.verbose = options.verbose ?? false;
    this.guardCheck = options.guardCheck ?? defaultGuardCheck;
  }

  /**
   * Start the scheduler - schedules all enabled sync sources
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      throw new Error("Scheduler already started");
    }

    this.isStarted = true;
    await this.scheduleConfiguredSources();
  }

  async reloadSyncConfig(): Promise<void> {
    if (!this.isStarted) return;

    for (const [source, timer] of this.timers) {
      clearTimeout(timer);
      if (this.verbose) {
        console.log(`Scheduler: Stopped ${source}`);
      }
    }
    this.timers.clear();
    await this.scheduleConfiguredSources();
  }

  private async scheduleConfiguredSources(): Promise<void> {
    const defaultInterval = parseInterval(this.config.scheduler.default_interval);

    // Get all configured sync sources
    const configuredSources = Object.entries(loadSyncSourcesConfig(this.db, this.registeredSourceNames));
    for (const row of listSyncSourceRows(this.db)) {
      if (!this.registeredSourceNames.has(row.source)) {
        console.warn(`Scheduler: Ignoring unregistered sync source "${row.source}"`);
      }
    }
    let staggerDelayMs = 0;
    const staggerIncrement = this.config.scheduler.stagger ? 30000 : 0; // 30s between each source

    for (const [sourceName, sourceConfig] of configuredSources) {
      const syncSource = this.syncSources.find((s) => s.name === sourceName);
      if (!syncSource) {
        throw new Error(`Registered sync source "${sourceName}" is missing from the scheduler`);
      }
      const intervalMs = this.configuredIntervalMs(sourceConfig, defaultInterval);

      if (!syncSource.enabled) {
        this.updateSourceState(sourceName, intervalMs, false);
        if (this.verbose) {
          console.log(`Scheduler: Source "${sourceName}" is disabled, skipping`);
        }
        continue;
      }

      if (sourceConfig.enabled === false) {
        this.updateSourceState(sourceName, intervalMs, false);
        if (this.verbose) {
          console.log(`Scheduler: Source "${sourceName}" disabled in config, skipping`);
        }
        continue;
      }

      // Initialize/update state in database
      this.updateSourceState(sourceName, intervalMs, true);

      // Schedule the source
      this.scheduleSource(sourceName, syncSource, sourceConfig, intervalMs, staggerDelayMs);
      staggerDelayMs += staggerIncrement;
    }

    if (this.verbose) {
      console.log(`Scheduler: Started with ${this.timers.size} sources`);
    }
  }

  /**
   * Stop the scheduler - cancels all scheduled tasks
   */
  stop(): void {
    for (const [source, timer] of this.timers) {
      clearTimeout(timer);
      if (this.verbose) {
        console.log(`Scheduler: Stopped ${source}`);
      }
    }
    this.timers.clear();
    this.isStarted = false;
  }

  /**
   * Stop scheduler timers and optionally wait for in-flight syncs to finish.
   */
  async stopAndWait(options: { abort?: boolean; timeoutMs?: number } = {}): Promise<boolean> {
    this.stop();
    if (options.abort) {
      this.abortRunningTasks();
    }
    return this.waitForIdle(options.timeoutMs);
  }

  /**
   * Abort all running syncs (cooperative).
   */
  abortRunningTasks(reason = "Scheduler stop requested"): void {
    for (const controller of this.abortControllers.values()) {
      try {
        controller.abort(reason);
      } catch {
        // Ignore abort errors
      }
    }
  }

  /**
   * Wait for in-flight syncs to complete.
   */
  waitForIdle(timeoutMs?: number): Promise<boolean> {
    if (this.inFlightCount === 0) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const onIdle = () => {
        cleanup();
        resolve(true);
      };

      const cleanup = () => {
        this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== onIdle);
        if (timeout) {
          clearTimeout(timeout);
        }
      };

      let timeout: Timer | null = null;
      if (timeoutMs && timeoutMs > 0) {
        timeout = setTimeout(() => {
          cleanup();
          resolve(false);
        }, timeoutMs);
      }

      this.idleWaiters.push(onIdle);
    });
  }

  /**
   * Get status of all scheduled tasks
   */
  getStatus(): ScheduledTask[] {
    const tasks: ScheduledTask[] = [];
    const states = this.getAllStates();

    for (const state of states) {
      const syncSource = this.syncSources.find((s) => s.name === state.source);
      if (!syncSource) continue;
      tasks.push({
        source: state.source,
        description: syncSource?.description || "Unknown source",
        intervalMs: state.interval_ms,
        lastRunAt: state.last_run_at ? new Date(state.last_run_at + "Z") : null,
        nextRunAt: state.next_run_at ? new Date(state.next_run_at + "Z") : null,
        isRunning: this.runningTasks.has(state.source),
        enabled: state.enabled === 1,
      });
    }

    return tasks;
  }

  /**
   * Execute a sync for a specific source in-process.
   *
   * Called by the job runner when claiming a `sync` job — NOT by the API.
   * The API enqueues a job; the runner picks it up and calls this method.
   *
   * @param externalSignal - Optional abort signal from the job runner. When it
   * fires, the per-source AbortController is aborted so syncSource.sync() and
   * abortRunningTasks() observe the abort uniformly.
   */
  async runNow(
    sourceName: string,
    jobId?: number | null,
    externalSignal?: AbortSignal,
    trigger?: JobTrigger,
    localWork?: LocalWorkGate,
  ): Promise<SyncResult> {
    const syncSource = this.syncSources.find((s) => s.name === sourceName);
    if (!syncSource) {
      return {
        source: sourceName,
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: `Unknown source: ${sourceName}`,
        durationMs: 0,
      };
    }

    const sourceConfig = loadSyncSourcesConfig(this.db, this.registeredSourceNames)[sourceName];
    if (!sourceConfig) {
      return {
        source: sourceName,
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: `Source not configured: ${sourceName}`,
        durationMs: 0,
      };
    }
    if (!syncSource.enabled || sourceConfig.enabled === false) {
      return {
        source: sourceName,
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: `Source disabled: ${sourceName}`,
        durationMs: 0,
      };
    }

    return this.runSync(sourceName, syncSource, sourceConfig, jobId, externalSignal, trigger, localWork);
  }

  /**
   * Pause a specific source
   */
  pause(sourceName: string): boolean {
    const timer = this.timers.get(sourceName);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sourceName);
      this.db
        .prepare("UPDATE scheduler_state SET enabled = 0, updated_at = datetime('now') WHERE source = ?")
        .run(sourceName);
      return true;
    }
    return false;
  }

  /**
   * Resume a paused source
   */
  resume(sourceName: string): boolean {
    const state = this.getSourceState(sourceName);
    if (!state) return false;

    const syncSource = this.syncSources.find((s) => s.name === sourceName);
    const sourceConfig = loadSyncSourcesConfig(this.db, this.registeredSourceNames)[sourceName];
    if (!syncSource || !sourceConfig) return false;

    this.db
      .prepare("UPDATE scheduler_state SET enabled = 1, updated_at = datetime('now') WHERE source = ?")
      .run(sourceName);

    this.scheduleSource(sourceName, syncSource, sourceConfig, state.interval_ms, 0);
    return true;
  }

  // Private methods

  private configuredIntervalMs(sourceConfig: SyncSourceConfig, defaultInterval: number): number {
    const intervalMs = sourceConfig.interval
      ? parseInterval(sourceConfig.interval)
      : defaultInterval;
    if (intervalMs <= 0 || !isValidTimeoutDelay(intervalMs)) {
      throw new Error("Scheduler interval must be greater than 0ms and within the timer delay limit");
    }
    return intervalMs;
  }

  private scheduleSource(
    sourceName: string,
    syncSource: SyncSource,
    sourceConfig: SyncSourceConfig,
    intervalMs: number,
    initialDelayMs: number
  ): void {
    // Calculate time until next run
    const state = this.getSourceState(sourceName);
    let delayMs = initialDelayMs;

    if (state?.next_run_at) {
      const nextRun = new Date(state.next_run_at + "Z");
      const now = new Date();
      const timeTilNext = nextRun.getTime() - now.getTime();
      if (timeTilNext > 0) {
        delayMs = Math.max(timeTilNext, initialDelayMs);
      }
    }

    const nextRunAt = new Date(Date.now() + delayMs);

    this.scheduleSourceAt(sourceName, syncSource, sourceConfig, intervalMs, nextRunAt);
  }

  private scheduleSourceAt(
    sourceName: string,
    syncSource: SyncSource,
    sourceConfig: SyncSourceConfig,
    intervalMs: number,
    nextRunAt: Date
  ): void {
    const existingTimer = this.timers.get(sourceName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const delayMs = Math.max(0, nextRunAt.getTime() - Date.now());
    if (!isValidTimeoutDelay(delayMs)) {
      throw new Error("Scheduler delay exceeds the timer delay limit");
    }

    if (this.verbose) {
      console.log(
        `Scheduler: ${sourceName} scheduled in ${formatInterval(delayMs)} ` +
          `(interval: ${formatInterval(intervalMs)})`
      );
    }

    // Update next run time in database
    this.db
      .prepare(
        "UPDATE scheduler_state SET next_run_at = ?, updated_at = datetime('now') WHERE source = ?"
      )
      .run(this.toSqliteTimestamp(nextRunAt), sourceName);

    // Schedule the enqueue
    const timer = setTimeout(() => {
      try {
        if (!isSyncSourceEnabled(sourceName, this.db)) {
          if (this.verbose) {
            console.log(`Scheduler: skipped ${sourceName}; source is disabled`);
          }
        } else if (this.runningTasks.has(sourceName)) {
          if (this.verbose) {
            console.log(`Scheduler: skipped ${sourceName}; sync is already running`);
          }
        } else {
          const outcome = enqueueJob({
            kind: "sync",
            source: sourceName,
            dedupeKey: `sync:${sourceName}`,
            trigger: "scheduler",
          });
          if (this.verbose) {
            console.log(
              `Scheduler: enqueued ${sourceName} (job #${outcome.jobId}${outcome.deduped ? ", deduped" : ""})`
            );
          }
        }
      } catch (error) {
        console.error(`Scheduler: failed to enqueue ${sourceName}:`, error);
      }

      // Always reschedule the next tick — the runner is responsible for executing
      // the queued job; the scheduler just decides when to enqueue.
      if (this.isStarted && isSyncSourceEnabled(sourceName, this.db)) {
        this.scheduleSource(sourceName, syncSource, sourceConfig, intervalMs, intervalMs);
      }
    }, delayMs);

    this.timers.set(sourceName, timer);
  }

  private async runSync(
    sourceName: string,
    syncSource: SyncSource,
    sourceConfig: SyncSourceConfig,
    jobId?: number | null,
    externalSignal?: AbortSignal,
    trigger?: JobTrigger,
    localWork?: LocalWorkGate,
  ): Promise<SyncResult> {
    if (this.runningTasks.has(sourceName)) {
      return {
        source: sourceName,
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Already running",
        durationMs: 0,
      };
    }

    this.runningTasks.add(sourceName);
    this.inFlightCount++;
    const abortController = new AbortController();
    this.abortControllers.set(sourceName, abortController);

    // Fan the runner's abort signal into our per-source controller. Both
    // syncSource.sync() and abortRunningTasks() observe a single abort source.
    let externalAbortHandler: (() => void) | null = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        abortController.abort(externalSignal.reason);
      } else {
        externalAbortHandler = () => abortController.abort(externalSignal.reason);
        externalSignal.addEventListener("abort", externalAbortHandler, { once: true });
      }
    }

    try {
      // Load sync config for canSync check and sync function
      const syncConfig = await loadSyncConfig(this.db, this.registeredSourceNames);
      const runtimeSourceConfig = syncConfig.sources[sourceName];

      // Check if sync can run
      const cannotSync = await syncSource.canSync(runtimeSourceConfig);
      if (cannotSync) {
        const result: SyncResult = {
          source: sourceName,
          success: true,
          skipped: true,
          eventsAdded: 0,
          eventsUpdated: 0,
          error: cannotSync,
          durationMs: 0,
        };
        recordSkippedSync(this.db, jobId ?? null, result);
        if (this.verbose) {
          console.log(formatSyncResult(result));
        }
        return result;
      }

      // Guard pipeline: defer the run on adverse conditions (e.g. uploading
      // backups over a tethered iPhone) instead of running it. A deferral is
      // recorded as a skipped sync_log row with success=1 — worker.ts treats a
      // result with success=false as a hard failure and retries it, which a
      // polite deferral must not trigger. Manual ("force it now") triggers
      // bypass the guard. Runs here, after canSync, because a guard in canSync
      // returns before startSyncLog and would leave no record of the deferral.
      if (trigger !== "manual") {
        const skip = await this.guardCheck({
          source: sourceName,
          sourceConfig: runtimeSourceConfig,
          blockedNetworks: getBlockedNetworks(this.db),
        });
        if (skip) {
          recordSkippedSync(this.db, jobId ?? null, skip);
          if (this.verbose) {
            console.log(formatSyncResult(skip));
          }
          return skip;
        }
      }

      // Log start
      const logId = startSyncLog(this.db, sourceName, jobId ?? null);

      const options: SyncOptions = {
        verbose: this.verbose,
        config: syncConfig,
        signal: abortController.signal,
        localWork,
      };

      // Run sync
      const result = await syncSource.sync(options);

      // Log completion
      completeSyncLog(this.db, logId, result);

      this.recordRunAndReschedule(sourceName, syncSource, sourceConfig);

      if (this.verbose) {
        console.log(formatSyncResult(result));
      }

      return result;
    } finally {
      if (externalSignal && externalAbortHandler) {
        externalSignal.removeEventListener("abort", externalAbortHandler);
      }
      this.runningTasks.delete(sourceName);
      this.abortControllers.delete(sourceName);
      this.inFlightCount = Math.max(0, this.inFlightCount - 1);
      if (this.inFlightCount === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const waiter of waiters) {
          waiter();
        }
      }
    }
  }

  private updateSourceState(sourceName: string, intervalMs: number, enabled: boolean): void {
    const existingState = this.getSourceState(sourceName);
    const nextRunAt =
      enabled && existingState?.interval_ms !== undefined && existingState.interval_ms !== intervalMs
        ? this.recomputeNextRunAt(existingState, intervalMs)
        : existingState?.next_run_at ?? null;

    this.db
      .prepare(
        `INSERT INTO scheduler_state (source, interval_ms, enabled, next_run_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
           interval_ms = excluded.interval_ms,
           enabled = excluded.enabled,
           next_run_at = CASE WHEN excluded.enabled = 1 THEN excluded.next_run_at ELSE NULL END,
           updated_at = datetime('now')`
      )
      .run(sourceName, intervalMs, enabled ? 1 : 0, nextRunAt);
  }

  private recomputeNextRunAt(state: SchedulerState, intervalMs: number): string {
    if (!state.last_run_at) {
      return this.toSqliteTimestamp(new Date());
    }

    const lastRunAt = new Date(`${state.last_run_at}Z`);
    const lastRunTime = lastRunAt.getTime();
    if (Number.isNaN(lastRunTime)) {
      throw new Error(`Invalid last_run_at for scheduler source ${state.source}: ${state.last_run_at}`);
    }

    const nextRunTime = Math.max(Date.now(), lastRunTime + intervalMs);
    return this.toSqliteTimestamp(new Date(nextRunTime));
  }

  private recordRunAndReschedule(
    sourceName: string,
    syncSource: SyncSource,
    sourceConfig: SyncSourceConfig
  ): void {
    const state = this.getSourceState(sourceName);
    if (!state) return;

    const finishedAt = new Date();
    const nextRunAt = new Date(finishedAt.getTime() + state.interval_ms);
    this.db
      .prepare(
        `UPDATE scheduler_state
         SET last_run_at = ?, next_run_at = ?, updated_at = datetime('now')
         WHERE source = ?`
      )
      .run(this.toSqliteTimestamp(finishedAt), this.toSqliteTimestamp(nextRunAt), sourceName);

    if (
      this.isStarted &&
      state.enabled === 1 &&
      isSyncSourceEnabled(sourceName, this.db)
    ) {
      this.scheduleSourceAt(sourceName, syncSource, sourceConfig, state.interval_ms, nextRunAt);
    }
  }

  private toSqliteTimestamp(date: Date): string {
    return date.toISOString().replace("T", " ").replace("Z", "");
  }

  private getSourceState(sourceName: string): SchedulerState | null {
    return this.db
      .prepare("SELECT * FROM scheduler_state WHERE source = ?")
      .get(sourceName) as SchedulerState | null;
  }

  private getAllStates(): SchedulerState[] {
    return this.db.prepare("SELECT * FROM scheduler_state ORDER BY source").all() as SchedulerState[];
  }
}

/**
 * Create a scheduler instance from config
 */
export function createScheduler(
  config: ServiceConfig,
  options?: { verbose?: boolean; syncSources?: SyncSource[] }
): Scheduler {
  return new Scheduler(config, options);
}
