/**
 * One sync run: the canSync check, an optional pre-run guard, and the sync
 * itself, each recorded in sync_log. The scheduler and the single-source runner
 * (src/sync/once.ts) both go through here.
 */

import type { Database } from "bun:sqlite";
import type { LocalWorkGate } from "../jobs/local-work";
import type { SyncConfig } from "./config";
import { completeSyncLog, formatSyncResult, recordSkippedSync, startSyncLog } from "./log";
import type { SyncResult, SyncSource } from "./types";

export interface SyncRunInput {
  appDb: Database;
  source: SyncSource;
  config: SyncConfig;
  /** The source's schedule interval (resolveSyncIntervalMs), passed to sync(). */
  intervalMs: number;
  jobId?: number | null;
  signal?: AbortSignal;
  localWork?: LocalWorkGate;
  verbose?: boolean;
  /** Returns a skip result to defer the run after canSync passes, or null to proceed. */
  guard?: () => Promise<SyncResult | null>;
}

export interface SyncRunOutcome {
  result: SyncResult;
  /** False when canSync or the guard skipped the run before sync() was called. */
  ran: boolean;
}

export async function runSyncSource(input: SyncRunInput): Promise<SyncRunOutcome> {
  const { appDb, source, config } = input;
  const jobId = input.jobId ?? null;
  const report = (result: SyncResult) => {
    if (input.verbose) console.log(formatSyncResult(result));
  };

  const cannotSync = await source.canSync(config.sources[source.name]);
  if (cannotSync) {
    const result: SyncResult = {
      source: source.name,
      success: true,
      skipped: true,
      eventsAdded: 0,
      eventsUpdated: 0,
      error: cannotSync,
      durationMs: 0,
    };
    recordSkippedSync(appDb, jobId, result);
    report(result);
    return { result, ran: false };
  }

  // A guard runs after canSync because a guard in canSync returns before
  // startSyncLog and would leave no record of the deferral.
  const skip = input.guard ? await input.guard() : null;
  if (skip) {
    recordSkippedSync(appDb, jobId, skip);
    report(skip);
    return { result: skip, ran: false };
  }

  const logId = startSyncLog(appDb, source.name, jobId);
  const result = await source.sync({
    verbose: input.verbose ?? false,
    config,
    signal: input.signal,
    localWork: input.localWork,
    intervalMs: input.intervalMs,
  });
  completeSyncLog(appDb, logId, result);
  report(result);
  return { result, ran: true };
}
