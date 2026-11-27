/**
 * Refreshing one conversation. The API checks a displayed conversation and
 * enqueues an ordinary `sync` job for its sync source with the target in the
 * payload; the worker's sync handler passes that job here instead of running
 * the full sync. The job runs in the serial lane like the full sync, holding
 * the local-work gate throughout, so it waits for a running full sync and the
 * two never run at once.
 *
 * A refresh writes no sync_log row and leaves scheduler_state alone, so it
 * neither satisfies the full sync's interval nor replaces its last result.
 */

import type { Database } from "bun:sqlite";
import { getAppStateDb } from "../db/app-state";
import { type QueryExecutor, wrapDatabase } from "../db/pool";
import { getDb } from "../db/schema";
import { enqueueOrJoinJob } from "../jobs/store";
import type { Job } from "../jobs/types";
import { PLATFORMS } from "../platforms";
import { collectConversationRefreshers } from "../platforms/registry";
import { isSyncSourceEnabled, loadSyncSourcesConfig } from "./config";
import { SYNC_SOURCES } from "./sources";
import type { ConversationRefresh, RefreshTarget, SyncResult } from "./types";

export const CONVERSATION_REFRESHERS = collectConversationRefreshers(PLATFORMS);

const REGISTERED_SOURCES = new Set(SYNC_SOURCES.map((source) => source.name));

// The accounts a conversation is stored under; two are enough to tell one from several.
const ACCOUNTS_SQL =
  "SELECT source_account AS account FROM conversation_summaries WHERE source = ? AND conversation_id = ? LIMIT 2";

type Unavailable = { ok: false; reason: string };

/** The refresher's sync source settings, or why that source can't sync now. */
async function syncSettings(
  refresher: ConversationRefresh,
  appDb: Database,
): Promise<{ ok: true; settings: Record<string, unknown> | undefined } | Unavailable> {
  const { syncSource } = refresher;
  if (!syncSource.enabled || !isSyncSourceEnabled(syncSource.name, appDb)) {
    return { ok: false, reason: `${syncSource.name} sync is turned off` };
  }
  const settings = loadSyncSourcesConfig(appDb, REGISTERED_SOURCES)[syncSource.name];
  const cannotSync = await syncSource.canSync(settings);
  return cannotSync ? { ok: false, reason: cannotSync } : { ok: true, settings };
}

/** Whether a displayed conversation can be refreshed, and as which target. */
export async function checkConversationRefresh(
  readDb: QueryExecutor,
  source: string,
  conversationId: string,
  appDb: Database = getAppStateDb(),
): Promise<Unavailable | { ok: true; target: RefreshTarget; refresher: ConversationRefresh }> {
  const refresher = CONVERSATION_REFRESHERS.find((candidate) => candidate.source === source);
  if (!refresher) return { ok: false, reason: "Conversations from this source can't be refreshed one at a time" };
  const sync = await syncSettings(refresher, appDb);
  if (!sync.ok) return sync;
  const rows = await readDb.query<{ account: string }>(ACCOUNTS_SQL, source, conversationId);
  const check = await refresher.resolve({
    conversationId,
    accounts: rows.map((row) => row.account ?? ""),
    settings: sync.settings,
    db: readDb,
  });
  return check.ok ? { ...check, refresher } : check;
}

/**
 * Enqueue a refresh of a displayed conversation, or join the one already
 * queued or running for it.
 */
export async function requestConversationRefresh(
  readDb: QueryExecutor,
  source: string,
  conversationId: string,
  appDb: Database = getAppStateDb(),
): Promise<{ ok: true; jobId: number; joined: boolean } | Unavailable> {
  const check = await checkConversationRefresh(readDb, source, conversationId, appDb);
  if (!check.ok) return check;
  const { target, refresher } = check;
  const outcome = enqueueOrJoinJob({
    kind: "sync",
    source: refresher.syncSource.name,
    payload: { refresh: target },
    dedupeKey: `refresh:${refresher.syncSource.name}:${target.account}:${target.conversationId}`,
    trigger: "manual",
  }, appDb);
  return { ok: true, jobId: outcome.jobId, joined: outcome.deduped };
}

/** The target of a refresh job, or null for a full sync job. */
export function refreshTargetOf(job: Pick<Job, "id" | "payload">): RefreshTarget | null {
  const target = job.payload.refresh;
  if (target === undefined) return null;
  if (
    !target || typeof target !== "object" ||
    typeof (target as RefreshTarget).account !== "string" ||
    typeof (target as RefreshTarget).conversationId !== "string"
  ) {
    throw new Error(`Job #${job.id} has a malformed refresh target`);
  }
  const { account, conversationId, nativeId } = target as RefreshTarget;
  if (nativeId === undefined) return { account, conversationId };
  if (typeof nativeId !== "string" || !nativeId) throw new Error(`Job #${job.id} has a malformed native conversation ID`);
  return { account, conversationId, nativeId };
}

/**
 * Run a refresh job in the worker. The target is checked again against the
 * current state: a full sync or a settings change may have run since the API
 * accepted it.
 */
export async function runRefreshJob(
  syncSourceName: string,
  target: RefreshTarget,
  signal: AbortSignal,
  appDb: Database = getAppStateDb(),
): Promise<SyncResult> {
  const refresher = CONVERSATION_REFRESHERS.find((candidate) => candidate.syncSource.name === syncSourceName);
  if (!refresher) throw new Error(`${syncSourceName} can't refresh one conversation`);
  const failed = (error: string): SyncResult => ({
    source: syncSourceName, success: false, eventsAdded: 0, eventsUpdated: 0, durationMs: 0, error,
  });
  const sync = await syncSettings(refresher, appDb);
  if (!sync.ok) return failed(sync.reason);
  const db = getDb();
  let check: Awaited<ReturnType<ConversationRefresh["resolve"]>>;
  try {
    check = await refresher.resolve({
      conversationId: target.conversationId,
      accounts: target.nativeId
        ? db.query<{ account: string }, [string, string]>(ACCOUNTS_SQL).all(refresher.source, target.conversationId).map(row => row.account)
        : [target.account],
      settings: sync.settings,
      db: wrapDatabase(db),
    });
  } finally {
    db.close();
  }
  if (!check.ok) return failed(check.reason);
  if (target.account !== check.target.account || target.nativeId !== check.target.nativeId) return failed("The conversation now maps to a different native conversation");
  return refresher.run(check.target, {
    verbose: false,
    config: { sources: { [syncSourceName]: sync.settings ?? {} } },
    signal,
  });
}
