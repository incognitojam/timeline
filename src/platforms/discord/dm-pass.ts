/**
 * Discord DM pass: a short sync of DMs and group DMs only, run every couple of
 * minutes on a claim loop of its own (see scheduler/worker.ts), so new
 * messages arrive between full Discord syncs. One DM listing, then only the
 * channels whose `last_message_id` moved past their cursor are fetched. The
 * full sync keeps doing everything else: servers, hidden DMs, reaction
 * rescans, call details, poll voters, emoji downloads, attachment recovery.
 *
 * The pass and the full sync share `discord-api` state. The pass reads it
 * again, fetches and stores only while holding the worker's local-work gate,
 * which a full sync, like every serial job, holds for its whole run, so the
 * two never run against that state at the same time. It saves only the
 * cursors and DMs it changed, merged into the latest state (saveDmProgress).
 * Separately, and only to save a listing while one runs, it skips its tick
 * while a full Discord sync job is running.
 */

import type { Database } from "bun:sqlite";
import { deleteSyncState, getAppStateDb, getSyncState, setSyncState } from "../../db/app-state";
import { getDb, initDb } from "../../db/schema";
import { runLocalWork } from "../../jobs/local-work";
import { listJobs } from "../../jobs/store";
import type { SyncOptions, SyncResult, SyncSource } from "../../sync/types";
import { type DiscordChannel, DiscordClient, MESSAGE_PAGE_SIZE } from "./client";
import { buildChannelContext } from "./event-converter";
import { createMessageStore, finishMessageStore, type MessageStore } from "./message-store";
import { type DiscordApiSyncState, discordSyncSource, hasNoNewMessages, isForbiddenChannelCached } from "./sync";

const SOURCE = "discord-dms";

/** sync_state row holding the pass's back-off after a failed or rate-limited pass. */
const BACKOFF_STATE = "discord-dms";

const MAX_BACKOFF_MS = 30 * 60_000;

/** sync_state row holding when the last completed pass listed DMs; get_updates reads it. */
const PASSED_STATE = "discord-dms-passed";

/**
 * Most pages of 100 messages fetched per channel in one pass. A channel with
 * more waits for the next pass, which continues from its cursor.
 */
const MAX_PAGES_PER_CHANNEL = 10;

interface Backoff {
  failures: number;
  retryAt: string;
}

// The account behind DISCORD_TOKEN, checked once per token. The token comes
// from the environment, so it changes only with a restart.
let verified: { token: string; userId: string } | null = null;

export const discordDmsSyncSource: SyncSource = {
  name: SOURCE,
  description: "Sync new Discord DMs and group DMs between full Discord syncs",
  enabled: true,
  defaultInterval: "2m",

  canSync: () => discordSyncSource.canSync(),

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const appDb = getAppStateDb();
    const token = process.env.DISCORD_TOKEN;
    if (!token) return failed("DISCORD_TOKEN environment variable not set", startTime);
    if (!options.intervalMs) return failed("The DM pass needs the schedule interval (SyncOptions.intervalMs)", startTime);

    if (isFullSyncRunning(appDb)) return skipped("A full Discord sync is running", startTime);
    const backoff = getSyncState<Backoff>(appDb, BACKOFF_STATE);
    if (backoff && isBackingOff(backoff)) {
      return skipped("Backing off after a failed or rate-limited pass", startTime, { retryAt: backoff.retryAt });
    }
    const listedState = getSyncState<DiscordApiSyncState>(appDb, "discord-api");
    if (!listedState?.userId) return skipped("Waiting for the first full Discord sync", startTime);

    const client = new DiscordClient(token, options.signal);
    // Filled in once messages start being stored, so a failed pass still reports them.
    const progress: { store?: MessageStore } = {};
    let result: SyncResult;
    try {
      result = await runPass(client, token, listedState, appDb, options, startTime, progress);
      // Only a pass that stored everything its listing showed makes DMs fresh.
      if (!options.signal?.aborted && !result.metadata?.channelsCapped) {
        setSyncState(appDb, PASSED_STATE, { at: new Date(startTime).toISOString() });
      }
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      result = {
        ...emptyResult(startTime),
        ...storedCounts(progress.store),
        ...(aborted
          ? { metadata: { cancelled: true } }
          : { success: false, error: error instanceof Error ? error.message : String(error) }),
      };
    }

    // A pass that saw a 429 backs off even when its retry succeeded or it was cancelled.
    const http = client.getStats();
    if (!result.success || http.rateLimit429Count > 0) {
      const failures = (backoff?.failures ?? 0) + 1;
      const delayMs = Math.min(options.intervalMs * 2 ** failures, MAX_BACKOFF_MS);
      setSyncState(appDb, BACKOFF_STATE, { failures, retryAt: new Date(Date.now() + delayMs).toISOString() });
    } else if (backoff && !result.metadata?.cancelled) {
      // A cancelled pass proves nothing, so it keeps the back-off count.
      deleteSyncState(appDb, BACKOFF_STATE);
    }
    return {
      ...result,
      metadata: { ...result.metadata, requests: http.totalRequests, rateLimit429Count: http.rateLimit429Count },
    };
  },
};

/** When the last completed pass started, so every DM message sent before it is stored. */
export function lastDmPassAt(appDb: Database): number | null {
  const at = Date.parse(getSyncState<{ at: string }>(appDb, PASSED_STATE)?.at ?? "");
  return Number.isFinite(at) ? at : null;
}

export function isDmPassBackingOff(appDb: Database): boolean {
  const backoff = getSyncState<Backoff>(appDb, BACKOFF_STATE);
  return backoff !== null && isBackingOff(backoff);
}

const isBackingOff = (backoff: Backoff) => Date.parse(backoff.retryAt) > Date.now();

async function runPass(
  client: DiscordClient,
  token: string,
  listedState: DiscordApiSyncState,
  appDb: Database,
  options: SyncOptions,
  startTime: number,
  progress: { store?: MessageStore },
): Promise<SyncResult> {
  if (verified?.token !== token) {
    const user = await client.getCurrentUser();
    if (!user) throw new Error("Failed to get current Discord user - check token");
    verified = { token, userId: user.id };
  }
  if (verified.userId !== listedState.userId) {
    throw new Error(`Discord account changed: cached ${listedState.username} (${listedState.userId}); the full sync reports the details`);
  }

  const channels = await client.fetchDMChannels();
  const moved = (state: DiscordApiSyncState) =>
    channels.filter((channel) =>
      !hasNoNewMessages(state, channel.id, channel.last_message_id) &&
      !isForbiddenChannelCached(state, channel.id, Date.now())
    );
  if (moved(listedState).length === 0) return skipped("No new DM messages", startTime);

  return runLocalWork(options.localWork, options.signal, async () => {
    // Read again: a full sync may have run since the listing.
    const state = getSyncState<DiscordApiSyncState>(appDb, "discord-api");
    if (state?.userId !== listedState.userId) throw new Error("Discord sync state changed during the DM pass");
    return storeChannels(client, state, moved(state), appDb, options, startTime, progress);
  });
}

async function storeChannels(
  client: DiscordClient,
  state: DiscordApiSyncState,
  channels: DiscordChannel[],
  appDb: Database,
  options: SyncOptions,
  startTime: number,
  progress: { store?: MessageStore },
): Promise<SyncResult> {
  const db = getDb();
  initDb(db);
  const store = (progress.store = createMessageStore({
    db,
    client,
    userId: state.userId,
    importBatch: `discord-api-${state.userId}-${Date.now()}`,
    state,
    signal: options.signal,
    verbose: options.verbose,
  }));
  const forbidden: Record<string, string> = {};
  let channelsCapped = 0;
  try {
    for (const channel of channels) {
      const ctx = buildChannelContext(channel);
      let pages = 0;
      const onForbidden = (channelId: string) => {
        forbidden[channelId] = new Date().toISOString();
      };
      for await (const batch of client.fetchMessages(channel.id, state.channelCursors[channel.id], { onForbidden })) {
        await checkPage(client, channel.id, state.channelCursors[channel.id], batch, pages === 0);
        await store.storeBatch(batch, ctx);
        pages++;
        // A short page is the last one; stopping saves the empty page after it.
        if (batch.length < MESSAGE_PAGE_SIZE) break;
        if (pages >= MAX_PAGES_PER_CHANNEL) {
          channelsCapped++;
          break;
        }
      }
      // Nothing after the cursor although the listing says otherwise: the
      // newest message was deleted. No message lies between the two (a later
      // one would have a higher id and been returned), so move the cursor up
      // to the listed id rather than fetch this channel again on every pass.
      if (pages === 0 && !forbidden[channel.id] && channel.last_message_id) {
        state.channelCursors[channel.id] = channel.last_message_id;
      }
    }
  } finally {
    // Cursors moved only as far as storeBatch stored, also when a fetch failed.
    finishMessageStore(db, store, () => saveDmProgress(appDb, state, channels, forbidden));
  }
  if (store.totals.added + store.totals.edited + store.totals.tombstonesCleared === 0) {
    return skipped("No new DM messages", startTime);
  }
  return {
    ...emptyResult(startTime),
    ...storedCounts(store),
    metadata: {
      channelsFetched: channels.length,
      ...(channelsCapped > 0 ? { channelsCapped } : {}),
      attachmentsStored: store.totals.attachments.stored,
      attachmentsFailed: store.totals.attachments.failed,
    },
  };
}

/**
 * Throw, before anything in the page is stored, unless Discord answered
 * `after=` as the paging relies on: only messages after the cursor, newest
 * first, and the ones right after the cursor rather than the newest ones. The
 * last needs one extra request, made only when a channel's first page is full.
 */
async function checkPage(client: DiscordClient, channelId: string, after: string | undefined, page: { id: string }[], first: boolean) {
  const fail = (problem: string): never => {
    throw new Error(`discord-dms: Discord paged DM channel ${channelId} after ${after ?? 0} out of order: ${problem}`);
  };
  const floor = BigInt(after ?? 0);
  page.forEach(({ id }, i) => {
    if (BigInt(id) <= floor) fail(`expected only ids after ${after ?? 0}, saw ${id}`);
    // fetchMessages reversed the page, so the one before this was sent after it.
    const sentAfter = page[i - 1]?.id;
    if (sentAfter && BigInt(id) <= BigInt(sentAfter)) fail(`expected newest first, saw ${id} before ${sentAfter}`);
  });
  const oldest = page[0];
  if (first && oldest && page.length === MESSAGE_PAGE_SIZE) {
    const before = await client.fetchMessageIdBefore(channelId, oldest.id);
    if (before && BigInt(before) > floor) {
      fail(`expected the oldest messages after ${after ?? 0} first, saw a page starting at ${oldest.id} with ${before} skipped`);
    }
  }
}

/**
 * Write only what this pass changed into the latest `discord-api` state, in
 * one transaction: each fetched channel's cursor (never moved back), the DMs
 * now known, and channels that answered 403. Anything else in the state stays
 * as the full sync last saved it, even if another process saved it meanwhile.
 */
function saveDmProgress(
  appDb: Database,
  ours: DiscordApiSyncState,
  channels: DiscordChannel[],
  forbidden: Record<string, string>,
): void {
  appDb.transaction(() => {
    const latest = getSyncState<DiscordApiSyncState>(appDb, "discord-api");
    if (latest?.userId !== ours.userId) throw new Error("Discord sync state changed during the DM pass");
    for (const { id } of channels) {
      const cursor = ours.channelCursors[id];
      const existing = latest.channelCursors[id];
      if (cursor && (!existing || BigInt(cursor) > BigInt(existing))) latest.channelCursors[id] = cursor;
    }
    latest.knownDMChannelIds = [...new Set([...latest.knownDMChannelIds, ...channels.map(({ id }) => id)])];
    if (Object.keys(forbidden).length > 0) latest.forbiddenChannelIds = { ...latest.forbiddenChannelIds, ...forbidden };
    setSyncState(appDb, "discord-api", latest);
  }).immediate();
}

function storedCounts(store: MessageStore | undefined): Pick<SyncResult, "eventsAdded" | "eventsUpdated"> {
  return {
    eventsAdded: store?.totals.added ?? 0,
    eventsUpdated: store ? store.totals.edited + store.totals.tombstonesCleared : 0,
  };
}

function isFullSyncRunning(appDb: Database): boolean {
  return listJobs({ kind: "sync", source: discordSyncSource.name, status: "running", limit: 1 }, appDb).length > 0;
}

function emptyResult(startTime: number): SyncResult {
  return { source: SOURCE, success: true, eventsAdded: 0, eventsUpdated: 0, durationMs: Date.now() - startTime };
}

function skipped(skipReason: string, startTime: number, detail: Record<string, unknown> = {}): SyncResult {
  return { ...emptyResult(startTime), skipped: true, metadata: { ...detail, skipReason } };
}

function failed(error: string, startTime: number): SyncResult {
  return { ...emptyResult(startTime), success: false, error };
}
