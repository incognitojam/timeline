/**
 * Refresh on read: before a broad get_updates, make sure stored Discord DMs
 * are fresh by asking the worker for a DM pass through the job queue and
 * waiting briefly for it. The API never syncs or writes timeline.db itself.
 */
import type { Database } from "bun:sqlite";
import { getAppStateDb } from "../db/app-state";
import { enqueueJob, getJob, listJobs } from "../jobs/store";
import { discordDmsSyncSource, isDmPassBackingOff, lastDmPassAt } from "../platforms/discord/dm-pass";
import { isSyncSourceEnabled } from "../sync/config";

/**
 * A pass that started this recently counts as fresh. Half the lane's 2-minute
 * interval: the reply is never more than a minute behind, and however often
 * an agent calls, refreshes add at most one DM listing a minute.
 */
const FRESH_MS = 60_000;
/**
 * Longest a call waits for the pass. The lane claims within its 2s idle poll
 * and a pass is one listing plus a fetch per moved DM; a pass still going
 * after this is usually queued behind a full sync on the shared gate.
 */
const WAIT_MS = 6_000;
const POLL_MS = 200;

const SOURCE = discordDmsSyncSource.name;

export interface RefreshOptions {
  appDb?: Database;
  waitMs?: number;
  pollMs?: number;
}

/** Whether a get_updates call is a broad catch-up that could include Discord DMs. */
export function wantsDmRefresh(params: { until?: string; skip?: number; sources?: string[]; conversation_id?: string }): boolean {
  if (params.conversation_id !== undefined || params.until !== undefined || (params.skip ?? 0) > 0) return false;
  return params.sources === undefined || params.sources.includes("discord");
}

/**
 * Bring Discord DMs up to date if the DM pass is on and stale. Returns a line
 * for the reply saying when they last synced if they may still be behind, or
 * null. Never throws.
 */
export async function refreshDiscordDms(options: RefreshOptions = {}): Promise<string | null> {
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  let appDb: Database | null = null;
  try {
    appDb = options.appDb ?? getAppStateDb();
    if (!isSyncSourceEnabled(SOURCE, appDb) || (await discordDmsSyncSource.canSync())) return null;
    // The job before the stamp: a pass stamps before its job finishes, so one
    // that finishes between the two reads shows as fresh, not as a finished job.
    const newest = listJobs({ kind: "sync", source: SOURCE, limit: 1 }, appDb)[0];
    if (isFresh(lastDmPassAt(appDb))) return null;
    if (!isDmPassBackingOff(appDb)) {
      // Join the newest pass while it is queued or running. One that ended
      // inside the window without making DMs fresh (failed, skipped, cut
      // short) is not asked for again until the window has passed.
      const active = newest?.status === "queued" || newest?.status === "running";
      const finishedAt = newest?.finishedAt ? Date.parse(`${newest.finishedAt}Z`) : Number.NaN;
      if (active || !isFresh(finishedAt)) {
        // "scheduler", not "manual": nobody forced this run, so guards still apply and skips fold into one log row.
        const jobId = active && newest
          ? newest.id
          : enqueueJob({ kind: "sync", source: SOURCE, dedupeKey: `sync:${SOURCE}`, trigger: "scheduler" }, appDb).jobId;
        await waitForJob(appDb, jobId, deadline, options.pollMs ?? POLL_MS);
        if (isFresh(lastDmPassAt(appDb))) return null;
      }
    }
  } catch (error) {
    console.error("[get_updates] Discord DM refresh failed:", error);
  }
  return lastSyncedLine(appDb);
}

function isFresh(at: number | null): boolean {
  return at !== null && Number.isFinite(at) && Date.now() - at < FRESH_MS;
}

async function waitForJob(appDb: Database, jobId: number, deadline: number, pollMs: number): Promise<void> {
  while (Date.now() < deadline) {
    const status = getJob(jobId, appDb)?.status;
    if (status !== "queued" && status !== "running") return;
    await Bun.sleep(Math.min(pollMs, deadline - Date.now()));
  }
}

/** When DMs last synced, to the minute, in the reply's UTC form. */
function lastSyncedLine(appDb: Database | null): string {
  let passedAt: number | null = null;
  try {
    if (appDb) passedAt = lastDmPassAt(appDb);
  } catch (error) {
    console.error("[get_updates] Reading the last Discord DM pass failed:", error);
  }
  if (passedAt === null) return "Discord DMs have never synced.";
  return `Discord DMs last synced ${new Date(passedAt).toISOString().slice(0, 16).replace("T", " ")}.`;
}
