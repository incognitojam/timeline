/**
 * Refreshing one Discord conversation (see src/sync/refresh.ts): a DM, a group
 * DM, or a channel or thread in a server the full sync follows in full. One
 * channel lookup, then new messages after the channel's stored cursor, a few
 * pages at most, stored the way every Discord sync stores them. Only that
 * channel's cursor moves, and only as far as stored. Everything else a full
 * sync does (listing DMs and servers, searches, reaction rescans, the
 * attachment retry backlog) is left to it, including edits and reactions on
 * older messages.
 *
 * Channels in sparse servers are refused: the full sync keeps only your own
 * messages and their context there, and reading every new message would start
 * collecting the whole channel.
 */

import { getAppStateDb, getSyncState } from "../../db/app-state";
import { conversationTypeClause } from "../../db/conversation-types";
import { type QueryExecutor, wrapDatabase } from "../../db/pool";
import { getDb, initDb } from "../../db/schema";
import type { ConversationRefresh, RefreshCheck, RefreshTarget, SyncOptions, SyncResult } from "../../sync/types";
import { CHANNEL_TYPE, type DiscordChannel, DiscordClient, isThreadType, MESSAGE_PAGE_SIZE } from "./client";
import { checkPage, saveChannelProgress, verifyDiscordAccount } from "./dm-pass";
import { buildChannelContext, type ChannelContext } from "./event-converter";
import { createMessageStore, finishMessageStore, type MessageStore } from "./message-store";
import {
  type DiscordApiSyncState,
  discordSyncSource,
  type GuildConfig,
  hasNoNewMessages,
  isForbiddenChannelCached,
  parseGuildConfigs,
} from "./sync";

/**
 * Most pages of 100 messages one refresh fetches. A conversation with more
 * says so, and the next refresh or full sync continues from its cursor.
 */
export const MAX_REFRESH_PAGES = 5;

/** Where a refreshable conversation lives, as the stored conversation and the sync settings say. */
type Scope =
  | { kind: "dm" }
  | { kind: "guild"; guildId: string; guild: GuildConfig; guildName: string | null; category: string | null };

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** The server a stored channel or thread belongs to, from its newest stored message. */
async function storedGuild(db: QueryExecutor, account: string, channelId: string) {
  return db.get<{ guildId: string | null; guildName: string | null; category: string | null }>(
    `SELECT json_extract(raw_data, '$._channel.guild_id') AS guildId,
            json_extract(raw_data, '$._channel.guild_name') AS guildName,
            json_extract(raw_data, '$._channel.category') AS category
     FROM events
     WHERE source = 'discord' AND source_account = ? AND conversation_id = ? AND ${conversationTypeClause()}
     ORDER BY timestamp DESC LIMIT 1`,
    account,
    channelId,
  );
}

const THREADS_NOT_FOLLOWED = "The Discord sync doesn't follow threads in this server";

/** The full sync leaves threads alone with skip_discovery, unless the manual channel list names them. */
function threadsNotFollowed(guild: GuildConfig, threadId: string): boolean {
  return !!guild.skip_discovery && !guild.channels?.includes(threadId);
}

async function scopeOf(
  state: DiscordApiSyncState,
  account: string,
  channelId: string,
  settings: Record<string, unknown> | undefined,
  db: QueryExecutor,
): Promise<{ ok: true; scope: Scope } | { ok: false; reason: string }> {
  if (state.knownDMChannelIds.includes(channelId)) return { ok: true, scope: { kind: "dm" } };
  const stored = await storedGuild(db, account, channelId);
  const guildId = stored?.guildId;
  if (!guildId) return refuse("Only Discord DMs, group DMs and server channels can be refreshed");
  const guild = parseGuildConfigs(settings)[guildId];
  if (!guild) return refuse("The Discord sync no longer follows this server");
  if (guild.mode === "sparse") {
    return refuse("This server is synced sparsely, so its channels can't be refreshed one at a time");
  }
  if (guild.exclude_channels?.includes(channelId)) return refuse("This channel is excluded from the Discord sync");
  if (guild.channels?.length && !guild.channels.includes(channelId)) {
    return refuse("This channel isn't in the server's channel list in the Discord sync settings");
  }
  const knownThread = Object.values(state.knownGuildThreadIds ?? {}).some((threads) => threads.includes(channelId));
  if (knownThread && threadsNotFollowed(guild, channelId)) return refuse(THREADS_NOT_FOLLOWED);
  return { ok: true, scope: { kind: "guild", guildId, guild, guildName: stored.guildName, category: stored.category } };
}

async function resolve(args: {
  conversationId: string;
  accounts: string[];
  settings: Record<string, unknown> | undefined;
  db: QueryExecutor;
}): Promise<RefreshCheck> {
  const { conversationId, accounts } = args;
  const [account, other] = accounts;
  if (!account) return refuse("Not a stored Discord conversation");
  if (other) return refuse("This conversation is stored under more than one Discord account");
  const state = getSyncState<DiscordApiSyncState>(getAppStateDb(), "discord-api");
  if (!state?.userId) return refuse("Waiting for the first full Discord sync");
  if (state.userId !== account) return refuse("This conversation isn't from the Discord account that syncs");
  // Without a cursor a refresh would read the whole history: leave that to the full sync.
  if (!state.channelCursors[conversationId]) return refuse("The full Discord sync hasn't collected this conversation yet");
  const scope = await scopeOf(state, account, conversationId, args.settings, args.db);
  if (!scope.ok) return scope;
  if (isForbiddenChannelCached(state, conversationId, Date.now())) {
    return refuse("Discord refused access to this conversation recently");
  }
  return { ok: true, target: { account, conversationId } };
}

/**
 * The channel context to store messages under, or why the channel Discord
 * describes no longer matches the scope the refresh was accepted for.
 */
function channelContext(
  channel: DiscordChannel,
  scope: Scope,
  state: DiscordApiSyncState,
): { ok: true; ctx: ChannelContext } | { ok: false; reason: string } {
  if (scope.kind === "dm") {
    if (channel.type !== CHANNEL_TYPE.DM && channel.type !== CHANNEL_TYPE.GROUP_DM) {
      return refuse("Discord no longer describes this conversation as a DM");
    }
    return { ok: true, ctx: buildChannelContext(channel) };
  }
  if (channel.guild_id !== scope.guildId) return refuse("Discord says this channel belongs to another server");
  if (
    channel.type === CHANNEL_TYPE.GUILD_CATEGORY ||
    channel.type === CHANNEL_TYPE.GUILD_VOICE ||
    channel.type === CHANNEL_TYPE.GUILD_STAGE
  ) {
    return refuse("Discord says this isn't a text channel");
  }
  if (isThreadType(channel.type) && threadsNotFollowed(scope.guild, channel.id)) return refuse(THREADS_NOT_FOLLOWED);
  if (isThreadType(channel.type) && channel.parent_id && scope.guild.exclude_channels?.includes(channel.parent_id)) {
    return refuse("This thread's channel is excluded from the Discord sync");
  }
  return {
    ok: true,
    ctx: {
      id: channel.id,
      type: channel.type,
      name: channel.name || channel.id,
      guildId: scope.guildId,
      guildName: state.guildMetaAt?.[scope.guildId]?.name ?? scope.guild.name ?? scope.guildName ?? scope.guildId,
      category: scope.category ?? "",
    },
  };
}

async function run(target: RefreshTarget, options: SyncOptions): Promise<SyncResult> {
  const startTime = Date.now();
  const channelId = target.conversationId;
  let client: DiscordClient | undefined;
  let store: MessageStore | undefined;
  const result = (outcome: Partial<SyncResult>): SyncResult => ({
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

  const db = getDb();
  initDb(db);
  const forbidden: Record<string, string> = {};
  const onForbidden = (id: string) => {
    forbidden[id] = new Date().toISOString();
  };
  let pages = { count: 0, lastFull: false };
  let notFound = false;
  try {
    const found = await scopeOf(state, target.account, channelId, options.config.sources[discordSyncSource.name], wrapDatabase(db));
    if (!found.ok) return result({ success: false, error: found.reason });

    client = new DiscordClient(token, options.signal);
    await verifyDiscordAccount(client, token, state);
    const channel = await client.getChannel(channelId, { onForbidden });
    if (!channel) {
      return result({
        success: false,
        error: forbidden[channelId] ? "Discord refused access to this conversation" : "Discord couldn't find this conversation",
      });
    }
    const context = channelContext(channel, found.scope, state);
    if (!context.ok) return result({ success: false, error: context.reason });
    if (hasNoNewMessages(state, channelId, channel.last_message_id)) return result({ metadata: { moreRemaining: false } });

    store = createMessageStore({
      db,
      client,
      userId: state.userId,
      importBatch: `discord-api-${state.userId}-${Date.now()}`,
      state,
      signal: options.signal,
      verbose: options.verbose,
    });
    pages = await storeNewMessages(client, store, context.ctx, after, { onForbidden, onNotFound: () => (notFound = true) });
    // storeBatch stops quietly on an abort.
    if (options.signal?.aborted) return result({ metadata: { cancelled: true } });
    if (forbidden[channelId]) return result({ success: false, error: "Discord refused access to this conversation" });
    if (notFound) return result({ success: false, error: "Discord couldn't find this conversation" });
    const cursor = state.channelCursors[channelId] ?? after;
    // Without the channel's newest message id, a full last page may have more behind it.
    const moreRemaining = pages.lastFull && pages.count >= MAX_REFRESH_PAGES &&
      (!channel.last_message_id || BigInt(cursor) < BigInt(channel.last_message_id));
    return result({ metadata: { moreRemaining, pages: pages.count } });
  } catch (error) {
    if (options.signal?.aborted) return result({ metadata: { cancelled: true } });
    return result({ success: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    // Save this channel's cursor, only as far as storeBatch stored (also when a
    // fetch failed), and any 403; then close the database.
    const save = () => saveChannelProgress(appDb, state, store ? [channelId] : [], forbidden);
    if (store) finishMessageStore(db, store, save);
    else {
      try {
        if (Object.keys(forbidden).length > 0) save();
      } finally {
        db.close();
      }
    }
  }
}

/** Fetch and store pages after the cursor, checking each page's order before storing it. */
async function storeNewMessages(
  client: DiscordClient,
  store: MessageStore,
  ctx: ChannelContext,
  after: string,
  access: { onForbidden: (channelId: string) => void; onNotFound: (channelId: string) => void },
): Promise<{ count: number; lastFull: boolean }> {
  const pages = { count: 0, lastFull: false };
  let floor = after;
  for await (const batch of client.fetchMessages(ctx.id, after, access)) {
    // Checked against the last message stored, so a page that jumps ahead
    // fails instead of moving the cursor past a gap.
    await checkPage(client, ctx.id, floor, batch, "discord refresh: Discord paged channel");
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
