/**
 * Refreshing one Discord DM or group DM (see src/sync/refresh.ts): one channel
 * lookup, then new messages after the channel's stored cursor, a few pages at
 * most, stored the way every Discord sync stores them. Only that channel's
 * cursor moves, and only as far as stored. Everything else a full sync does
 * (listing DMs and servers, searches, reaction rescans, the attachment retry
 * backlog) is left to it, including edits and reactions on older messages.
 */

import { getAppStateDb, getSyncState } from "../../db/app-state";
import { getDb, initDb } from "../../db/schema";
import type { ConversationRefresh, RefreshCheck, RefreshTarget, SyncOptions, SyncResult } from "../../sync/types";
import { CHANNEL_TYPE, type DiscordChannel, DiscordClient, MESSAGE_PAGE_SIZE } from "./client";
import { checkPage, saveChannelProgress, verifyDiscordAccount } from "./dm-pass";
import { buildChannelContext } from "./event-converter";
import { createMessageStore, finishMessageStore, type MessageStore } from "./message-store";
import { type DiscordApiSyncState, discordSyncSource, hasNoNewMessages, isForbiddenChannelCached } from "./sync";

/**
 * Most pages of 100 messages one refresh fetches. A conversation with more
 * says so, and the next refresh or full sync continues from its cursor.
 */
export const MAX_REFRESH_PAGES = 5;

function refuse(reason: string): RefreshCheck {
  return { ok: false, reason };
}

function resolve(args: { conversationId: string; accounts: string[] }): RefreshCheck {
  const { conversationId, accounts } = args;
  const [account, other] = accounts;
  if (!account) return refuse("Not a stored Discord conversation");
  if (other) return refuse("This conversation is stored under more than one Discord account");
  const state = getSyncState<DiscordApiSyncState>(getAppStateDb(), "discord-api");
  if (!state?.userId) return refuse("Waiting for the first full Discord sync");
  if (state.userId !== account) return refuse("This conversation isn't from the Discord account that syncs");
  // Without a cursor a refresh would read the whole history: leave that to the full sync.
  if (!state.channelCursors[conversationId]) return refuse("The full Discord sync hasn't collected this conversation yet");
  if (!state.knownDMChannelIds.includes(conversationId)) return refuse("Only Discord DMs and group DMs can be refreshed");
  if (isForbiddenChannelCached(state, conversationId, Date.now())) {
    return refuse("Discord refused access to this conversation recently");
  }
  return { ok: true, target: { account, conversationId } };
}

async function run(target: RefreshTarget, options: SyncOptions): Promise<SyncResult> {
  const startTime = Date.now();
  const channelId = target.conversationId;
  let client: DiscordClient | undefined;
  const result = (outcome: Partial<SyncResult>, store?: MessageStore): SyncResult => ({
    source: discordSyncSource.name,
    success: true,
    eventsAdded: store?.totals.added ?? 0,
    eventsUpdated: store ? store.totals.edited + store.totals.tombstonesCleared : 0,
    durationMs: Date.now() - startTime,
    ...outcome,
    metadata: {
      refresh: target,
      requests: client?.getStats().totalRequests ?? 0,
      ...(store && { attachmentsStored: store.totals.attachments.stored, attachmentsFailed: store.totals.attachments.failed }),
      ...outcome.metadata,
    },
  });

  const token = process.env.DISCORD_TOKEN;
  if (!token) return result({ success: false, error: "DISCORD_TOKEN environment variable not set" });
  const appDb = getAppStateDb();
  const state = getSyncState<DiscordApiSyncState>(appDb, "discord-api");
  const after = state?.channelCursors[channelId];
  if (!state || state.userId !== target.account || !after) {
    return result({ success: false, error: "Discord sync state changed before the refresh" });
  }

  client = new DiscordClient(token, options.signal);
  const forbidden: Record<string, string> = {};
  const onForbidden = (id: string) => {
    forbidden[id] = new Date().toISOString();
  };
  let store: MessageStore | undefined;
  let notFound = false;
  try {
    await verifyDiscordAccount(client, token, state);
    const channel = await client.getChannel(channelId, { onForbidden });
    if (!channel || forbidden[channelId]) {
      if (forbidden[channelId]) saveChannelProgress(appDb, state, [], forbidden);
      return result({
        success: false,
        error: forbidden[channelId] ? "Discord refused access to this conversation" : "Discord couldn't find this conversation",
      });
    }
    if (channel.type !== CHANNEL_TYPE.DM && channel.type !== CHANNEL_TYPE.GROUP_DM) {
      return result({ success: false, error: "Only Discord DMs and group DMs can be refreshed" });
    }
    if (hasNoNewMessages(state, channelId, channel.last_message_id)) {
      return result({ metadata: { moreRemaining: false } });
    }

    const db = getDb();
    initDb(db);
    store = createMessageStore({
      db,
      client,
      userId: state.userId,
      importBatch: `discord-api-${state.userId}-${Date.now()}`,
      state,
      signal: options.signal,
      verbose: options.verbose,
    });
    let pages: { count: number; lastFull: boolean } = { count: 0, lastFull: false };
    try {
      pages = await storeNewMessages(client, store, channel, after, { onForbidden, onNotFound: () => (notFound = true) });
    } finally {
      // The cursor moved only as far as storeBatch stored, also when a fetch failed.
      finishMessageStore(db, store, () => saveChannelProgress(appDb, state, [channelId], forbidden));
    }
    // storeBatch stops quietly on an abort.
    if (options.signal?.aborted) return result({ metadata: { cancelled: true } }, store);
    if (forbidden[channelId]) return result({ success: false, error: "Discord refused access to this conversation" }, store);
    if (notFound) return result({ success: false, error: "Discord couldn't find this conversation" }, store);
    const cursor = state.channelCursors[channelId];
    // Without the channel's newest message id, a full last page may have more behind it.
    const moreRemaining = pages.lastFull && pages.count >= MAX_REFRESH_PAGES &&
      (!channel.last_message_id || BigInt(cursor ?? after) < BigInt(channel.last_message_id));
    return result({ metadata: { moreRemaining, pages: pages.count } }, store);
  } catch (error) {
    if (options.signal?.aborted) return result({ metadata: { cancelled: true } }, store);
    return result({ success: false, error: error instanceof Error ? error.message : String(error) }, store);
  }
}

/** Fetch and store pages after the cursor, checking each page's order before storing it. */
async function storeNewMessages(
  client: DiscordClient,
  store: MessageStore,
  channel: DiscordChannel,
  after: string,
  access: { onForbidden: (channelId: string) => void; onNotFound: (channelId: string) => void },
): Promise<{ count: number; lastFull: boolean }> {
  const ctx = buildChannelContext(channel);
  const pages = { count: 0, lastFull: false };
  let floor = after;
  for await (const batch of client.fetchMessages(channel.id, after, access)) {
    // Checked against the last message stored, so a page that jumps ahead
    // fails instead of moving the cursor past a gap.
    await checkPage(client, channel.id, floor, batch, "discord refresh: Discord paged channel");
    await store.storeBatch(batch, ctx);
    floor = batch.at(-1)?.id ?? floor;
    pages.count++;
    pages.lastFull = batch.length === MESSAGE_PAGE_SIZE;
    // A short page is the last one; stopping saves the empty page after it.
    if (!pages.lastFull || pages.count >= MAX_REFRESH_PAGES) break;
  }
  return pages;
}

export const discordConversationRefresh: ConversationRefresh = {
  source: "discord",
  syncSource: discordSyncSource,
  resolve,
  run,
};
