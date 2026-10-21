/**
 * Discord API Sync Source
 *
 * Syncs Discord messages directly via the Discord API, replacing the
 * previous implementation that read from an intermediary discord-chat DB.
 *
 * Features:
 * - DMs and group DMs: auto-discovered via API, merged with known channel IDs
 * - Full guilds: channel + thread discovery, fetch all messages
 * - Sparse guilds: search for user messages, fetch conversation context
 * - Attachment downloads: CDN URLs fetched while fresh
 * - Incremental sync via per-channel snowflake cursors
 */

import { getAppStateDb, getSyncState, setSyncState } from "../../db/app-state";
import { type UpsertIdentityOptions, upsertIdentities } from "../../db/identities";
import { onImportComplete } from "../../db/import-hooks";
import { getDb, initDb } from "../../db/schema";
import type { SyncOptions, SyncResult, SyncSource } from "../../sync/types";
import { downloadAndStoreAttachments } from "./attachment-downloader";
import {
  type DiscordAttachmentRetryResult,
  retryDiscordAttachments,
} from "./attachment-retry";
import {
  type CallDetailRefreshStats,
  refreshIncompleteCallDetails,
} from "./call-details";
import {
  CHANNEL_TYPE,
  type DiscordChannel,
  DiscordClient,
  type DiscordClientStats,
  getChannelTypeName,
  isThreadType,
  type NormalizedMessage,
  snowflakeToDate,
  THREAD_CHANNEL_TYPES,
} from "./client";
import { downloadPendingEmojis, upsertEmojiRefs } from "./emoji-downloader";
import { extractEmojiRefs } from "./emoji-extractor";
import {
  buildChannelContext,
  type ChannelContext,
  convertMessage,
  getMessageAttachments,
} from "./event-converter";
import { upsertGuildEmojis } from "./guild-emojis";
import { upsertGuild } from "./guilds";
import { reconcileDiscordMessage } from "./message-reconciliation";
import { captureExpiredPollVoters, type PollVoterCaptureStats } from "./poll-voters";
import { fetchSessionContext, groupIntoSessions } from "./sparse";
import {
  buildEmojiCountMap,
  type RescanStats,
  rescanReactionTiers,
  TIERS,
  type TierCursors,
} from "./tier-rescan";

interface GuildConfig {
  name?: string;
  mode: "full" | "sparse";
  skip_discovery?: boolean;
  channels?: string[];
  exclude_channels?: string[];
}

interface DiscordPhaseStats {
  durationMs: number;
  requests: number;
  routeCounts: Record<string, number>;
  routeDurationMs: Record<string, number>;
  throttleSleepMs: number;
  proactiveRateLimitSleepMs: number;
  retrySleepMs: number;
  rateLimit429Count: number;
}

interface DiscordOptimizationStats {
  forbiddenChannelsMarked: number;
  forbiddenChannelsSkipped: number;
  forbiddenThreadSearchParentsMarked: number;
  forbiddenThreadSearchParentsSkipped: number;
  activeThreadParentsChecked: number;
  activeThreadFullSweeps: number;
  knownThreadsChecked: number;
  knownThreadsSkipped: number;
  knownThreadsDeferred: number;
  guildMetaSkipped: number;
}

const ACTIVE_THREAD_FULL_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FORBIDDEN_CHANNEL_RETRY_MS = 24 * 60 * 60 * 1000;

// Reaction authors (who reacted, not just the emoji + count the message fetch
// returns) are captured at first sync only for messages younger than this gate.
// Rationale: messages older than the 24h tier never enter a reaction rescan
// (their band has already aged past every tier), so a first backfill of a
// historical channel would otherwise fire an author fetch per old reacted
// message — thousands of requests for reactions long since settled. Gating on
// age keeps initial author capture to the freshly-posted band, which is also
// where late-deleted reactions would otherwise cost us the author list.
const INITIAL_AUTHOR_CAPTURE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Guild metadata (name/icon via fetchGuild) and the guild emoji inventory
// change rarely; refresh them daily instead of on every sync. Custom emoji
// referenced by actual messages are unaffected — those are captured per
// message via extractEmojiRefs and downloaded in the end-of-sync pass.
const GUILD_META_TTL_MS = 24 * 60 * 60 * 1000;

// Known-thread probe backoff: how often to getChannel-probe a known thread,
// by how long the thread has been inactive (age of its cursor snowflake).
// A dormant thread that wakes is caught no later than the daily active-thread
// full sweep (posting to an archived thread unarchives it, so it appears in
// the archived=false search), so the slowest probe interval matches
// ACTIVE_THREAD_FULL_SWEEP_INTERVAL_MS rather than risking unbounded staleness.
// (Probes and the sweep are gated by the same !skip_discovery block, so every
// guild that probes also sweeps — the safety net can't be configured away
// independently.)
export const THREAD_PROBE_TIERS = [
  { maxInactiveMs: 24 * 60 * 60 * 1000, probeIntervalMs: 0 },              // active today: every sync
  { maxInactiveMs: 7 * 24 * 60 * 60 * 1000, probeIntervalMs: 4 * 60 * 60 * 1000 }, // active this week: 4h
  { maxInactiveMs: Number.POSITIVE_INFINITY, probeIntervalMs: ACTIVE_THREAD_FULL_SWEEP_INTERVAL_MS },
] as const;
const THREAD_CHANNEL_TYPE_NAMES = THREAD_CHANNEL_TYPES.map(getChannelTypeName);

export interface DiscordApiSyncState {
  userId: string;
  username: string;
  channelCursors: Record<string, string>;       // channel_id -> last message snowflake
  guildSparseCursors: Record<string, string>;   // guild_id -> newest found snowflake
  threadsDiscoveredGuilds: string[];            // guilds where archived threads fully discovered
  knownGuildThreadIds?: Record<string, string[]>; // guild_id -> thread channel IDs with cursors
  knownDMChannelIds: string[];                  // includes hidden/closed DMs
  backfilledDMChannelIds: string[];             // DMs where initial backfill completed
  activeThreadFullSweepAt?: Record<string, string>; // guild_id -> last active-thread full sweep
  threadProbeAt?: Record<string, string>;       // thread channel_id -> last getChannel probe
  guildMetaAt?: Record<string, { name: string; at: string }>; // guild_id -> cached API name + last refresh
  forbiddenChannelIds?: Record<string, string>; // channel_id -> last message-fetch 403
  forbiddenThreadSearchParentIds?: Record<string, string>; // parent channel_id -> last thread-search 403
  // Per-tier reaction-rescan cursors (shape: see TierCursors). On each sync we
  // advance each cursor up to "now - tier_age", re-fetching the band of messages
  // that crossed the threshold since the previous sync. Legacy
  // rescanCursors24h/7d/30d fields are folded in by migrateRescanCursors() on load.
  rescanCursors?: TierCursors;
  // Calls first observed while active need a later direct re-fetch. IDs
  // remembered here avoid repeating fetches for unavailable messages.
  callDetailUnavailableMessageIds?: string[];
}

/**
 * Legacy per-tier cursor fields that predated the unified `rescanCursors` map.
 * Read once and dropped by migrateRescanCursors(); the field set is frozen
 * history, so it never tracks TIERS.
 */
export type LegacyRescanCursorFields = {
  rescanCursors24h?: Record<string, string>;
  rescanCursors7d?: Record<string, string>;
  rescanCursors30d?: Record<string, string>;
};

function log(verbose: boolean, msg: string) {
  if (verbose) console.log(`[discord] ${msg}`);
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function emptyRescanStats(): RescanStats {
  return {
    channelsChecked: 0,
    channelsSkipped: 0,
    channelsSkippedEmptyBand: 0,
    messagesReFetched: 0,
    reactionsUpdated: 0,
    pollsUpdated: 0,
    observationsRecorded: 0,
    messagesEdited: 0,
    messagesTombstoned: 0,
    tombstonesCleared: 0,
    deletionConfirmations: 0,
  };
}

function emptyCallDetailRefreshStats(): CallDetailRefreshStats {
  return { attempted: 0, updated: 0, pending: 0, unavailable: 0, failed: 0 };
}

function emptyPollVoterCaptureStats(): PollVoterCaptureStats {
  return { captured: 0, failed: 0, remaining: 0 };
}

function discordEventsUpdated(
  rescanStats: RescanStats,
  callDetailStats: CallDetailRefreshStats,
  pollVoterStats: PollVoterCaptureStats,
): number {
  return rescanStats.reactionsUpdated +
    rescanStats.pollsUpdated +
    rescanStats.messagesEdited +
    rescanStats.messagesTombstoned +
    rescanStats.tombstonesCleared +
    callDetailStats.updated +
    pollVoterStats.captured;
}

function emptyOptimizationStats(): DiscordOptimizationStats {
  return {
    forbiddenChannelsMarked: 0,
    forbiddenChannelsSkipped: 0,
    forbiddenThreadSearchParentsMarked: 0,
    forbiddenThreadSearchParentsSkipped: 0,
    activeThreadParentsChecked: 0,
    activeThreadFullSweeps: 0,
    knownThreadsChecked: 0,
    knownThreadsSkipped: 0,
    knownThreadsDeferred: 0,
    guildMetaSkipped: 0,
  };
}

function diffNumberRecords(
  after: Record<string, number>,
  before: Record<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(after)) {
    const diff = value - (before[key] ?? 0);
    if (diff !== 0) result[key] = diff;
  }
  return result;
}

function isFreshTimestamp(iso: string | undefined, nowMs: number, ttlMs: number): boolean {
  if (!iso) return false;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && nowMs - parsed < ttlMs;
}

function isCachedIn(
  cache: Record<string, string> | undefined,
  id: string,
  nowMs: number,
  ttlMs: number,
): boolean {
  if (!cache) return false;
  if (isFreshTimestamp(cache[id], nowMs, ttlMs)) return true;
  delete cache[id];
  return false;
}

export function isForbiddenChannelCached(
  state: DiscordApiSyncState,
  channelId: string,
  nowMs: number,
): boolean {
  return isCachedIn(state.forbiddenChannelIds, channelId, nowMs, FORBIDDEN_CHANNEL_RETRY_MS);
}

export function isForbiddenThreadSearchParentCached(
  state: DiscordApiSyncState,
  channelId: string,
  nowMs: number,
): boolean {
  return isCachedIn(state.forbiddenThreadSearchParentIds, channelId, nowMs, FORBIDDEN_CHANNEL_RETRY_MS);
}

function markForbiddenChannel(state: DiscordApiSyncState, channelId: string, nowMs: number): void {
  const cache = (state.forbiddenChannelIds ??= {});
  cache[channelId] = new Date(nowMs).toISOString();
}

function markForbiddenThreadSearchParent(state: DiscordApiSyncState, channelId: string, nowMs: number): void {
  const cache = (state.forbiddenThreadSearchParentIds ??= {});
  cache[channelId] = new Date(nowMs).toISOString();
}

export function shouldRunActiveThreadFullSweep(
  state: DiscordApiSyncState,
  guildId: string,
  nowMs: number,
): boolean {
  return !isFreshTimestamp(
    state.activeThreadFullSweepAt?.[guildId],
    nowMs,
    ACTIVE_THREAD_FULL_SWEEP_INTERVAL_MS,
  );
}

function markActiveThreadFullSweep(state: DiscordApiSyncState, guildId: string, nowMs: number): void {
  const sweeps = (state.activeThreadFullSweepAt ??= {});
  sweeps[guildId] = new Date(nowMs).toISOString();
}

export function shouldProbeKnownThread(
  state: DiscordApiSyncState,
  threadId: string,
  nowMs: number,
): boolean {
  const cursor = state.channelCursors[threadId];
  if (!cursor) return true; // no cursor to age — probe to (re)establish one

  const inactiveMs = nowMs - snowflakeToDate(cursor).getTime();
  const tier = THREAD_PROBE_TIERS.find((t) => inactiveMs < t.maxInactiveMs) ??
    THREAD_PROBE_TIERS[THREAD_PROBE_TIERS.length - 1];
  if (tier.probeIntervalMs === 0) return true;

  return !isFreshTimestamp(state.threadProbeAt?.[threadId], nowMs, tier.probeIntervalMs);
}

function markThreadProbed(state: DiscordApiSyncState, threadId: string, nowMs: number): void {
  const probes = (state.threadProbeAt ??= {});
  probes[threadId] = new Date(nowMs).toISOString();
}

/** Cached API guild name when refreshed within GUILD_META_TTL_MS, else null. */
export function freshGuildMetaName(
  state: DiscordApiSyncState,
  guildId: string,
  nowMs: number,
): string | null {
  const meta = state.guildMetaAt?.[guildId];
  if (!meta || !isFreshTimestamp(meta.at, nowMs, GUILD_META_TTL_MS)) return null;
  return meta.name;
}

function markGuildMeta(
  state: DiscordApiSyncState,
  guildId: string,
  name: string,
  nowMs: number,
): void {
  const metas = (state.guildMetaAt ??= {});
  metas[guildId] = { name, at: new Date(nowMs).toISOString() };
}

function rememberKnownGuildThread(
  state: DiscordApiSyncState,
  guildId: string | undefined,
  threadId: string,
): void {
  if (!guildId) return;
  const byGuild = (state.knownGuildThreadIds ??= {});
  const ids = new Set(byGuild[guildId] ?? []);
  ids.add(threadId);
  byGuild[guildId] = [...ids].sort();
}

export function forgetKnownGuildThread(
  state: DiscordApiSyncState,
  guildId: string,
  threadId: string,
): void {
  const byGuild = state.knownGuildThreadIds;
  const ids = byGuild?.[guildId];
  if (ids) {
    // Keep the entry even when it becomes empty (don't delete the key):
    // loadKnownGuildThreadIds treats an undefined entry as "not yet
    // bootstrapped" and re-runs the expensive unindexed events scan, so a
    // guild whose last known thread is pruned must stay marked as migrated.
    byGuild[guildId] = ids.filter((id) => id !== threadId);
  }
  delete state.channelCursors[threadId];
  delete state.threadProbeAt?.[threadId];
  for (const cursors of Object.values(state.rescanCursors ?? {})) {
    delete cursors[threadId];
  }
}

export function loadKnownGuildThreadIds(
  db: import("bun:sqlite").Database,
  state: DiscordApiSyncState,
  guildId: string,
): string[] {
  const byGuild = (state.knownGuildThreadIds ??= {});

  // The events scan below is a one-time bootstrap: it is an unindexed full scan
  // over every Discord row because json_extract on raw_data can't use an index.
  // This becomes expensive on large databases.
  // Once a guild has an entry, the thread index is maintained incrementally by
  // rememberKnownGuildThread (on discovery) and forgetKnownGuildThread (on 404),
  // so the scan is redundant — skip it on every later sync.
  let knownThreadIds = byGuild[guildId];
  if (knownThreadIds === undefined) {
    const ids = new Set<string>();
    const rows = db
      .prepare(`
        SELECT DISTINCT json_extract(raw_data, '$._channel.id') AS channel_id
        FROM events
        WHERE source = 'discord'
          AND json_extract(raw_data, '$._channel.guild_id') = ?
          AND json_extract(raw_data, '$._channel.type') IN (?, ?, ?)
      `)
      .all(guildId, ...THREAD_CHANNEL_TYPE_NAMES) as { channel_id: string | null }[];

    for (const row of rows) {
      if (row.channel_id) ids.add(row.channel_id);
    }

    // Always record an entry — even an empty one — so a guild with no thread
    // events is marked migrated and does not re-scan on every sync.
    knownThreadIds = [...ids].filter((id) => state.channelCursors[id]).sort();
    byGuild[guildId] = knownThreadIds;
  }

  return knownThreadIds.filter((id) => state.channelCursors[id]);
}

function buildDiscordSyncMetadata(args: {
  attachments: { stored: number; failed: number };
  attachmentRecovery: DiscordAttachmentRetryResult;
  emojis: { stored: number; tombstoned: number; failed: number };
  rescanStats: RescanStats;
  callDetails: CallDetailRefreshStats;
  pollVoters: PollVoterCaptureStats;
  phaseStats: Record<string, DiscordPhaseStats>;
  clientStats: DiscordClientStats;
  optimizationStats?: DiscordOptimizationStats;
}): Record<string, unknown> {
  return {
    attachmentsStored: args.attachments.stored,
    attachmentsFailed: args.attachments.failed,
    attachmentRecoveryAttempted: args.attachmentRecovery.attempted,
    attachmentRecoveryStored: args.attachmentRecovery.stored,
    attachmentRecoveryFailed: args.attachmentRecovery.failed,
    attachmentRecoveryUnrecoverable: args.attachmentRecovery.unrecoverable,
    attachmentRecoveryUnavailable: args.attachmentRecovery.unavailable,
    emojisStored: args.emojis.stored,
    emojisTombstoned: args.emojis.tombstoned,
    emojisFailed: args.emojis.failed,
    rescanChannelsChecked: args.rescanStats.channelsChecked,
    rescanChannelsSkippedEmptyBand: args.rescanStats.channelsSkippedEmptyBand,
    rescanMessagesReFetched: args.rescanStats.messagesReFetched,
    rescanObservationsRecorded: args.rescanStats.observationsRecorded,
    messagesEdited: args.rescanStats.messagesEdited,
    messagesTombstoned: args.rescanStats.messagesTombstoned,
    tombstonesCleared: args.rescanStats.tombstonesCleared,
    deletionConfirmations: args.rescanStats.deletionConfirmations,
    callDetailRefreshAttempted: args.callDetails.attempted,
    callDetailRefreshUpdated: args.callDetails.updated,
    callDetailRefreshPending: args.callDetails.pending,
    callDetailRefreshUnavailable: args.callDetails.unavailable,
    callDetailRefreshFailed: args.callDetails.failed,
    pollVotersCaptured: args.pollVoters.captured,
    pollVotersFailed: args.pollVoters.failed,
    pollVotersRemaining: args.pollVoters.remaining,
    phaseTimings: args.phaseStats,
    http: args.clientStats,
    optimization: args.optimizationStats,
  };
}

export const discordSyncSource: SyncSource = {
  name: "discord",
  description: "Sync Discord messages via API",
  enabled: true,

  async canSync(config?: Record<string, unknown>): Promise<string | null> {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      return "DISCORD_TOKEN environment variable not set";
    }
    return null;
  },

  async sync(options: SyncOptions): Promise<SyncResult> {
    const startTime = Date.now();
    const sourceConfig = options.config.sources["discord"];

    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      return {
        source: "discord",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "DISCORD_TOKEN environment variable not set",
        durationMs: Date.now() - startTime,
      };
    }

    // Parse guild configs
    const guilds = parseGuildConfigs(sourceConfig);

    const signal = options.signal;

    const client = new DiscordClient(token, signal);
    const phaseStats: Record<string, DiscordPhaseStats> = {};
    let activePhaseFinish: (() => void) | null = null;
    const startPhase = (name: string): (() => void) => {
      const startedAt = Date.now();
      const before = client.getStats();
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        if (activePhaseFinish === finish) activePhaseFinish = null;

        const after = client.getStats();
        const stats: DiscordPhaseStats = {
          durationMs: Date.now() - startedAt,
          requests: after.totalRequests - before.totalRequests,
          routeCounts: diffNumberRecords(after.routeCounts, before.routeCounts),
          routeDurationMs: diffNumberRecords(after.routeDurationMs, before.routeDurationMs),
          throttleSleepMs: after.throttleSleepMs - before.throttleSleepMs,
          proactiveRateLimitSleepMs:
            after.proactiveRateLimitSleepMs - before.proactiveRateLimitSleepMs,
          retrySleepMs: after.retrySleepMs - before.retrySleepMs,
          rateLimit429Count: after.rateLimit429Count - before.rateLimit429Count,
        };
        phaseStats[name] = stats;
        log(
          options.verbose,
          `Phase ${name}: ${formatSeconds(stats.durationMs)}, ${stats.requests} request(s), ` +
            `${formatSeconds(stats.throttleSleepMs)} throttle, ` +
            `${formatSeconds(stats.proactiveRateLimitSleepMs)} rate-limit sleep, ` +
            `${formatSeconds(stats.retrySleepMs)} retry sleep, ${stats.rateLimit429Count} 429(s)`,
        );
      };
      activePhaseFinish = finish;
      return finish;
    };
    const finishActivePhase = () => {
      const finish = activePhaseFinish;
      if (finish) finish();
    };
    const buildEarlyMetadata = () =>
      buildDiscordSyncMetadata({
        attachments: { stored: 0, failed: 0 },
        attachmentRecovery: {
          attempted: 0,
          stored: 0,
          failed: 0,
          unrecoverable: 0,
          unavailable: 0,
        },
        emojis: { stored: 0, tombstoned: 0, failed: 0 },
        rescanStats: emptyRescanStats(),
        callDetails: emptyCallDetailRefreshStats(),
        pollVoters: emptyPollVoterCaptureStats(),
        phaseStats,
        clientStats: client.getStats(),
        optimizationStats: emptyOptimizationStats(),
      });

    // Load sync state
    const appDb = getAppStateDb();
    let state = getSyncState<DiscordApiSyncState>(appDb, "discord-api");

    // Always fetch current user to validate token and detect account changes
    let currentUser: { id: string; username: string } | null = null;
    let authError: string | null = null;
    const finishAuthPhase = startPhase("auth");
    try {
      const user = await client.getCurrentUser();
      if (!user) {
        authError = "Failed to get current Discord user - check token";
      } else {
        currentUser = { id: user.id, username: user.username };
      }
    } catch (error) {
      authError = `Failed to authenticate: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      finishAuthPhase();
    }
    if (authError) {
      return {
        source: "discord",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: authError,
        durationMs: Date.now() - startTime,
        metadata: buildEarlyMetadata(),
      };
    }
    if (!currentUser) {
      return {
        source: "discord",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error: "Failed to authenticate: missing Discord user",
        durationMs: Date.now() - startTime,
        metadata: buildEarlyMetadata(),
      };
    }

    // Detect account change (cursors are scoped to the old account)
    if (state?.userId && state.userId !== currentUser.id) {
      return {
        source: "discord",
        success: false,
        eventsAdded: 0,
        eventsUpdated: 0,
        error:
          `Discord account changed: cached ${state.username} (${state.userId}) ≠ ` +
          `current ${currentUser.username} (${currentUser.id}). ` +
          `Clear sync state for 'discord-api' to resync with the new account.`,
        durationMs: Date.now() - startTime,
        metadata: buildEarlyMetadata(),
      };
    }

    const userId = currentUser.id;
    const username = currentUser.username;
    log(options.verbose, `Authenticated as ${username} (${userId})`);

    // Initialize or update state
    if (!state) {
      state = {
        userId,
        username,
        channelCursors: {},
        guildSparseCursors: {},
        threadsDiscoveredGuilds: [],
        knownDMChannelIds: [],
        backfilledDMChannelIds: [],
      };
    } else {
      // Persist latest identity (handles username renames)
      state.userId = userId;
      state.username = username;
    }

    // Carry legacy cursors forward into the unified map that Phase 4 advances
    // (see migrateRescanCursors).
    const rescanCursors = migrateRescanCursors(state);

    // Drop cached guild meta for guilds no longer configured, so removed
    // guilds don't leave entries in state forever.
    if (state.guildMetaAt) {
      for (const gid of Object.keys(state.guildMetaAt)) {
        if (!guilds[gid]) delete state.guildMetaAt[gid];
      }
    }

    const db = getDb();
    initDb(db);

    const importBatch = `discord-api-${userId}-${Date.now()}`;
    let totalAdded = 0;
    let incidentalMessageEdits = 0;
    let incidentalTombstonesCleared = 0;
    let totalAttachments = { stored: 0, failed: 0 };
    let attachmentRecovery: DiscordAttachmentRetryResult = {
      attempted: 0,
      stored: 0,
      failed: 0,
      unrecoverable: 0,
      unavailable: 0,
    };
    let totalEmojis = { stored: 0, tombstoned: 0, failed: 0 };
    let rescanStats = emptyRescanStats();
    let callDetailStats = emptyCallDetailRefreshStats();
    let pollVoterStats = emptyPollVoterCaptureStats();
    let incidentalMetricsFolded = false;
    const optimizationStats = emptyOptimizationStats();
    const allIdentities: UpsertIdentityOptions[] = [];
    const foldIncidentalMetrics = () => {
      if (incidentalMetricsFolded) return;
      rescanStats.messagesEdited += incidentalMessageEdits;
      rescanStats.tombstonesCleared += incidentalTombstonesCleared;
      incidentalMetricsFolded = true;
    };

    // Flush accumulated identities to DB and clear the buffer.
    // Safe to call multiple times — upsertIdentities uses ON CONFLICT UPDATE.
    const flushIdentities = () => {
      if (allIdentities.length === 0) return;
      const uniqueIdentities = new Map<string, UpsertIdentityOptions>();
      for (const id of allIdentities) {
        uniqueIdentities.set(id.platformId, id);
      }
      upsertIdentities(db, [...uniqueIdentities.values()]);
      log(options.verbose, `Flushed ${uniqueIdentities.size} identities`);
      allIdentities.length = 0;
    };

    // Returns false when the inventory was unavailable, so callers can retry
    // sooner than the guild-meta TTL.
    const syncGuildEmojiInventory = async (guildId: string, guildName: string): Promise<boolean> => {
      const guildEmojis = await client.fetchGuildEmojis(guildId);
      if (!guildEmojis) {
        log(options.verbose, `  ${guildName}: emoji inventory unavailable`);
        return false;
      }

      upsertGuildEmojis(db, guildId, guildEmojis);
      upsertEmojiRefs(
        db,
        guildEmojis.map((emoji) => ({
          id: emoji.id,
          name: emoji.name,
          animated: emoji.animated === true,
        })),
      );
      log(options.verbose, `  ${guildName}: ${guildEmojis.length} emoji(s) indexed`);
      return true;
    };

    // Refresh guild metadata (name/icon) + emoji inventory at most once per
    // GUILD_META_TTL_MS, returning the guild name to use for channel context.
    // Only a run where both fetches succeed is cached, so either failure
    // retries next sync instead of waiting out the TTL.
    // (`state` is guarded rather than narrowed — closures don't keep the
    // post-init narrowing; see processBatch.)
    const refreshGuildMeta = async (
      guildId: string,
      guildConfig: GuildConfig,
    ): Promise<string> => {
      const cachedName = state ? freshGuildMetaName(state, guildId, Date.now()) : null;
      if (cachedName !== null) {
        optimizationStats.guildMetaSkipped++;
        return cachedName;
      }

      const guildInfo = await client.fetchGuild(guildId);
      if (guildInfo) upsertGuild(db, guildInfo);
      const guildName = guildInfo?.name || guildConfig.name || guildId;
      const emojisSynced = await syncGuildEmojiInventory(guildId, guildName);
      if (guildInfo && emojisSynced && state) {
        markGuildMeta(state, guildId, guildInfo.name, Date.now());
      }
      return guildName;
    };

    try {

      const insert = db.prepare(`
        INSERT OR IGNORE INTO events (
          source, source_id, source_account, type, timestamp,
          title, content, people, tags, raw_data, import_batch, conversation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertObservation = db.prepare(
        `INSERT OR REPLACE INTO discord_reaction_observations
           (event_id, tier, observed_at, age_ms, total_count, emoji_counts)
         VALUES (?, ?, ?, ?, ?, json(?))`,
      );

      // Same shape as tier-rescan's updateReactions: writes the reactions
      // array (now carrying `users`) back into raw_data.$.reactions.
      const updateReactions = db.prepare(
        "UPDATE events SET raw_data = json_set(raw_data, '$.reactions', json(?)) WHERE source = 'discord' AND source_id = ? AND source_account = ?",
      );

      // Helper: process a batch of messages for a channel
      const processBatch = async (
        messages: NormalizedMessage[],
        channelCtx: ChannelContext
      ) => {
        for (const msg of messages) {
          if (signal?.aborted) return;

          const { event, identities } = convertMessage(msg, channelCtx, userId, importBatch);
          allIdentities.push(...identities);

          const result = insert.run(
            event.source,
            event.sourceId,
            event.sourceAccount,
            event.type,
            event.timestamp,
            event.title,
            event.content,
            JSON.stringify(event.people),
            event.tags,
            JSON.stringify(event.rawData),
            event.importBatch,
            event.conversationId
          );

          if (result.changes > 0) {
            totalAdded++;
            const eventId = Number(result.lastInsertRowid);

            // Record initial reaction observation if the message had any
            // reactions at first sync. Provides a baseline for measuring drift
            // captured by later tier re-fetches. The observation records counts
            // only — author capture below is separate.
            if (msg.reactions.length > 0) {
              const nowMs = Date.now();
              const ageMs = nowMs - Date.parse(msg.timestamp);
              const totalCount = msg.reactions.reduce((s, r) => s + r.count, 0);
              insertObservation.run(
                eventId,
                "initial",
                new Date(nowMs).toISOString(),
                ageMs,
                totalCount,
                JSON.stringify(buildEmojiCountMap(msg.reactions)),
              );

              // Capture *who* reacted at first sync for freshly-posted messages
              // (the message fetch returns only emoji + count). Gated on age so
              // a historical backfill doesn't fire an author fetch per old
              // reacted message — see INITIAL_AUTHOR_CAPTURE_MAX_AGE_MS. Runs
              // after the INSERT OR IGNORE so a duplicate (no-op) message —
              // e.g. a sparse-context overlap — never wastes an author fetch.
              if (
                !signal?.aborted &&
                ageMs < INITIAL_AUTHOR_CAPTURE_MAX_AGE_MS
              ) {
                // Isolate hard failures like the attachment path does: author
                // enrichment is best-effort, and one bad fetch must not abort
                // the rest of the sync run. The counts are already stored; a
                // count change at the 1h/6h/24h tiers re-attempts the capture.
                try {
                  const enriched = await client.fetchAllReactionUsers(
                    channelCtx.id,
                    msg.id,
                    msg.reactions,
                  );
                  updateReactions.run(JSON.stringify(enriched), msg.id, userId);
                } catch (err) {
                  if (err instanceof DOMException && err.name === "AbortError") throw err;
                  console.warn(
                    `[discord] initial author capture failed for ${msg.id}: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
              }
            }

            // Discord forwards keep the original files inside message_snapshots,
            // while the forwarding wrapper's attachment array stays empty.
            const messageAttachments = getMessageAttachments(msg);
            if (messageAttachments.length > 0) {
              const attResult = await downloadAndStoreAttachments(
                db,
                eventId,
                channelCtx.id,
                messageAttachments,
                signal
              );
              totalAttachments.stored += attResult.stored;
              totalAttachments.failed += attResult.failed;
            }

            // Cheap: record any custom-emoji refs as 'pending' rows so we can
            // download them in a single deduped pass at the end of the sync.
            const emojiRefs = extractEmojiRefs(event.rawData);
            if (emojiRefs.length > 0) upsertEmojiRefs(db, emojiRefs);
          } else {
            // Sparse context and overlapping discovery paths often re-fetch an
            // already indexed message. Reconcile those observations for free.
            const reconciled = reconcileDiscordMessage(db, msg, userId);
            if (reconciled.edited) incidentalMessageEdits++;
            if (reconciled.tombstoneCleared) incidentalTombstonesCleared++;
          }

          // Update cursor
          if (state) {
            const existing = state.channelCursors[channelCtx.id];
            if (!existing || BigInt(msg.id) > BigInt(existing)) {
              state.channelCursors[channelCtx.id] = msg.id;
            }
          }
        }
      };

      // Helper: check if a channel can be skipped (no new messages since last sync)
      const canSkipChannel = (channelId: string, lastMessageId?: string | null): boolean => {
        if (lastMessageId === undefined) return false; // no data available, must sync
        if (lastMessageId === null) return true;       // channel has no messages at all
        const cursor = state.channelCursors[channelId];
        if (!cursor) return false;
        // BigInt compare: string comparison breaks across the 18→19 digit rollover
        // (Discord snowflakes grew in length around July 2022).
        return BigInt(lastMessageId) <= BigInt(cursor);
      };

      // Helper: sync a single channel (full mode)
      const syncChannel = async (channelCtx: ChannelContext) => {
        if (signal?.aborted) return;

        const cursor = state.channelCursors[channelCtx.id];
        let batchCount = 0;

        for await (const batch of client.fetchMessages(channelCtx.id, cursor, {
          onForbidden: (channelId) => {
            if (!isForbiddenChannelCached(state, channelId, Date.now())) {
              optimizationStats.forbiddenChannelsMarked++;
            }
            markForbiddenChannel(state, channelId, Date.now());
          },
        })) {
          if (signal?.aborted) return;
          await processBatch(batch, channelCtx);
          batchCount++;
        }

        if (options.verbose && batchCount > 0) {
          log(true, `  ${channelCtx.name}: ${batchCount} batch(es)`);
        }
      };

      // ========== Phase 1: DMs and Groups ==========
      const finishDmsPhase = startPhase("dms");
      log(options.verbose, "Syncing DMs and groups...");
      const apiDMChannels = await client.fetchDMChannels();

      // Merge with known DM channel IDs from state
      const knownDMIds = new Set(state.knownDMChannelIds);
      for (const ch of apiDMChannels) {
        knownDMIds.add(ch.id);
      }

      // Build channel context map from API results
      const dmContextMap = new Map<string, { channel: DiscordChannel; ctx: ChannelContext }>();
      for (const ch of apiDMChannels) {
        const ctx = buildChannelContext(ch);
        dmContextMap.set(ch.id, { channel: ch, ctx });
      }

      // Sync all known DM channels
      // Track backfilled DMs in a Set for O(1) lookups during the loop.
      // Discord resurfaces hidden DMs in fetchDMChannels() when they receive
      // new messages, so backfilled hidden DMs that stay hidden are safe to skip.
      const backfilledSet = new Set(state.backfilledDMChannelIds ?? []);
      let dmSynced = 0;
      let dmSkipped = 0;
      let dmSkippedBackfilled = 0;
      for (const channelId of knownDMIds) {
        if (signal?.aborted) break;

        let ctx: ChannelContext;
        const cached = dmContextMap.get(channelId);
        if (cached) {
          // Visible DM - we have last_message_id from the listing
          if (canSkipChannel(channelId, cached.channel.last_message_id)) {
            dmSkipped++;
            continue;
          }
          ctx = cached.ctx;
        } else {
          // Hidden/closed DM - skip if already backfilled (new messages
          // would cause it to appear in the API listing)
          if (backfilledSet.has(channelId)) {
            dmSkippedBackfilled++;
            continue;
          }

          // Needs initial backfill - fetch channel info
          const ch = await client.getChannel(channelId);
          if (!ch) continue;
          if (canSkipChannel(channelId, ch.last_message_id)) {
            dmSkipped++;
            backfilledSet.add(channelId);
            continue;
          }
          ctx = buildChannelContext(ch);
        }

        await syncChannel(ctx);
        if (!signal?.aborted && !dmContextMap.has(channelId)) {
          backfilledSet.add(channelId);
        }
        dmSynced++;
      }

      state.backfilledDMChannelIds = [...backfilledSet];
      log(options.verbose, `DMs: ${dmSynced} synced, ${dmSkipped} skipped (no new messages), ${dmSkippedBackfilled} skipped (backfilled)`);

      // Update known DM channel IDs
      state.knownDMChannelIds = [...knownDMIds];

      flushIdentities();
      finishDmsPhase();

      // ========== Phase 2: Full Guilds ==========
      const fullGuilds = Object.entries(guilds).filter(([_, g]) => g.mode === "full");
      const sparseGuilds = Object.entries(guilds).filter(([_, g]) => g.mode === "sparse");

      const finishFullGuildsPhase = startPhase("full-guilds");
      for (const [guildId, guildConfig] of fullGuilds) {
        if (signal?.aborted) break;

        const guildName = await refreshGuildMeta(guildId, guildConfig);
        log(options.verbose, `Syncing full guild: ${guildName}`);

        let guildSynced = 0;
        let guildSkipped = 0;

        // Manual channel list: skip discovery, only sync specified channels
        if (guildConfig.channels && guildConfig.channels.length > 0) {
          const manualExcludeSet = guildConfig.exclude_channels ? new Set(guildConfig.exclude_channels) : null;
          const filteredChannels = manualExcludeSet
            ? guildConfig.channels.filter((id) => !manualExcludeSet.has(id))
            : guildConfig.channels;
          log(options.verbose, `  Manual mode: ${filteredChannels.length} channel(s)`);

          for (const channelId of filteredChannels) {
            if (signal?.aborted) break;

            if (isForbiddenChannelCached(state, channelId, Date.now())) {
              optimizationStats.forbiddenChannelsSkipped++;
              guildSkipped++;
              continue;
            }

            const ch = await client.getChannel(channelId);
            if (!ch) {
              log(options.verbose, `  Channel ${channelId} not found, skipping`);
              continue;
            }

            // Verify channel belongs to this guild
            if (ch.guild_id && ch.guild_id !== guildId) {
              console.warn(`[discord] Channel ${channelId} belongs to guild ${ch.guild_id}, not ${guildId} - skipping`);
              continue;
            }

            // Skip non-text channel types
            if (
              ch.type === CHANNEL_TYPE.GUILD_CATEGORY ||
              ch.type === CHANNEL_TYPE.GUILD_VOICE ||
              ch.type === CHANNEL_TYPE.GUILD_STAGE
            ) {
              console.warn(`[discord] Channel ${channelId} is type ${ch.type} (${ch.name}), not a text channel - skipping`);
              continue;
            }

            if (canSkipChannel(ch.id, ch.last_message_id)) {
              guildSkipped++;
              continue;
            }

            const ctx: ChannelContext = {
              id: ch.id,
              type: ch.type,
              name: ch.name || channelId,
              guildId,
              guildName,
              category: "",
            };
            await syncChannel(ctx);
            guildSynced++;
          }

          log(options.verbose, `  ${guildName}: ${guildSynced} synced, ${guildSkipped} skipped (no new messages)`);
          flushIdentities();
          continue;
        }

        // Discover channels
        const apiChannels = await client.fetchGuildChannels(guildId);

        // Build category map
        const categories = new Map<string, string>();
        for (const ch of apiChannels) {
          if (ch.type === CHANNEL_TYPE.GUILD_CATEGORY) categories.set(ch.id, ch.name);
        }

        // Sync text channels
        const excludeSet = guildConfig.exclude_channels ? new Set(guildConfig.exclude_channels) : null;
        const textChannels = apiChannels.filter((ch) =>
          ch.type !== CHANNEL_TYPE.GUILD_CATEGORY &&
          ch.type !== CHANNEL_TYPE.GUILD_VOICE &&
          ch.type !== CHANNEL_TYPE.GUILD_STAGE &&
          (!excludeSet || !excludeSet.has(ch.id))
        );

        if (excludeSet && options.verbose) {
          const excluded = apiChannels.filter((ch) => excludeSet.has(ch.id));
          for (const ch of excluded) {
            log(true, `  Excluding channel: #${ch.name} (${ch.id})`);
          }
        }

        for (const ch of textChannels) {
          if (signal?.aborted) break;

          if (isForbiddenChannelCached(state, ch.id, Date.now())) {
            optimizationStats.forbiddenChannelsSkipped++;
            guildSkipped++;
            continue;
          }

          if (canSkipChannel(ch.id, ch.last_message_id)) {
            guildSkipped++;
            continue;
          }

          const category = ch.parent_id ? categories.get(ch.parent_id) || "" : "";
          const ctx: ChannelContext = {
            id: ch.id,
            type: ch.type,
            name: ch.name,
            guildId,
            guildName,
            category,
          };
          await syncChannel(ctx);
          guildSynced++;
        }

        // Discover and sync threads
        if (!guildConfig.skip_discovery) {
          const parentChannels = textChannels.filter(
            (ch) => ch.type === CHANNEL_TYPE.GUILD_TEXT || ch.type === CHANNEL_TYPE.GUILD_FORUM
          );
          const parentChannelsById = new Map(parentChannels.map((ch) => [ch.id, ch]));

          const needsFullDiscovery = !state.threadsDiscoveredGuilds.includes(guildId);
          const knownThreadIds = loadKnownGuildThreadIds(db, state, guildId);

          for (const threadId of knownThreadIds) {
            if (signal?.aborted) break;

            if (isForbiddenChannelCached(state, threadId, Date.now())) {
              optimizationStats.forbiddenChannelsSkipped++;
              guildSkipped++;
              continue;
            }

            if (!shouldProbeKnownThread(state, threadId, Date.now())) {
              optimizationStats.knownThreadsDeferred++;
              guildSkipped++;
              continue;
            }

            optimizationStats.knownThreadsChecked++;
            // Mark before the fetch: a 404 forgets the thread (and its probe
            // timestamp) inside the onNotFound callback, and marking afterwards
            // would resurrect the entry for a thread we no longer track.
            markThreadProbed(state, threadId, Date.now());
            const thread = await client.getChannel(threadId, {
              onForbidden: (channelId) => {
                if (!isForbiddenChannelCached(state, channelId, Date.now())) {
                  optimizationStats.forbiddenChannelsMarked++;
                }
                markForbiddenChannel(state, channelId, Date.now());
              },
              onNotFound: (channelId) => {
                forgetKnownGuildThread(state, guildId, channelId);
              },
            });
            if (!thread) {
              guildSkipped++;
              continue;
            }
            if (!isThreadType(thread.type)) continue;
            if (thread.guild_id && thread.guild_id !== guildId) continue;
            if (excludeSet?.has(thread.id) || (thread.parent_id && excludeSet?.has(thread.parent_id))) {
              guildSkipped++;
              continue;
            }
            if (canSkipChannel(thread.id, thread.last_message_id)) {
              optimizationStats.knownThreadsSkipped++;
              guildSkipped++;
              rememberKnownGuildThread(state, thread.guild_id ?? guildId, thread.id);
              continue;
            }

            const parent = thread.parent_id ? parentChannelsById.get(thread.parent_id) : undefined;
            const category = parent?.parent_id ? categories.get(parent.parent_id) || "" : "";
            const ctx: ChannelContext = {
              id: thread.id,
              type: thread.type,
              name: thread.name,
              guildId,
              guildName,
              category,
            };
            await syncChannel(ctx);
            rememberKnownGuildThread(state, thread.guild_id ?? guildId, thread.id);
            guildSynced++;
          }

          const runActiveThreadFullSweep = shouldRunActiveThreadFullSweep(state, guildId, Date.now());
          if (runActiveThreadFullSweep) {
            optimizationStats.activeThreadFullSweeps++;
          }

          // Active-thread search is expensive and rate-limited by a hidden
          // Discord sub-limit. Regular freshness comes from probing known
          // threads above; search is only a periodic discovery pass.
          for (const ch of runActiveThreadFullSweep ? parentChannels : []) {
            if (signal?.aborted) break;

            if (isForbiddenThreadSearchParentCached(state, ch.id, Date.now())) {
              optimizationStats.forbiddenThreadSearchParentsSkipped++;
              guildSkipped++;
              continue;
            }

            optimizationStats.activeThreadParentsChecked++;
            for await (const batch of client.searchThreads(ch.id, false, {
              onForbidden: (channelId) => {
                if (!isForbiddenThreadSearchParentCached(state, channelId, Date.now())) {
                  optimizationStats.forbiddenThreadSearchParentsMarked++;
                }
                markForbiddenThreadSearchParent(state, channelId, Date.now());
              },
            })) {
              for (const thread of batch) {
                if (signal?.aborted) break;
                rememberKnownGuildThread(state, thread.guild_id ?? guildId, thread.id);
                if (canSkipChannel(thread.id, thread.last_message_id)) {
                  guildSkipped++;
                  continue;
                }
                const category = ch.parent_id ? categories.get(ch.parent_id) || "" : "";
                const ctx: ChannelContext = {
                  id: thread.id,
                  type: thread.type,
                  name: thread.name,
                  guildId,
                  guildName,
                  category,
                };
                await syncChannel(ctx);
                guildSynced++;
              }
            }
          }
          if (runActiveThreadFullSweep && !signal?.aborted) {
            markActiveThreadFullSweep(state, guildId, Date.now());
          }

          // Full archived thread discovery on first run only
          if (needsFullDiscovery) {
            log(options.verbose, `  Discovering archived threads...`);
            for (const ch of parentChannels) {
              if (signal?.aborted) break;

              if (isForbiddenThreadSearchParentCached(state, ch.id, Date.now())) {
                optimizationStats.forbiddenThreadSearchParentsSkipped++;
                guildSkipped++;
                continue;
              }

              for await (const batch of client.searchThreads(ch.id, true, {
                onForbidden: (channelId) => {
                  if (!isForbiddenThreadSearchParentCached(state, channelId, Date.now())) {
                    optimizationStats.forbiddenThreadSearchParentsMarked++;
                  }
                  markForbiddenThreadSearchParent(state, channelId, Date.now());
                },
              })) {
                for (const thread of batch) {
                  if (signal?.aborted) break;
                  rememberKnownGuildThread(state, thread.guild_id ?? guildId, thread.id);
                  if (canSkipChannel(thread.id, thread.last_message_id)) {
                    guildSkipped++;
                    continue;
                  }
                  const category = ch.parent_id ? categories.get(ch.parent_id) || "" : "";
                  const ctx: ChannelContext = {
                    id: thread.id,
                    type: thread.type,
                    name: thread.name,
                    guildId,
                    guildName,
                    category,
                  };
                  await syncChannel(ctx);
                  guildSynced++;
                }
              }
            }

            if (!signal?.aborted) {
              state.threadsDiscoveredGuilds.push(guildId);
            }
          }
        }

        log(options.verbose, `  ${guildName}: ${guildSynced} synced, ${guildSkipped} skipped (no new messages)`);

        flushIdentities();
      }
      finishFullGuildsPhase();

      // ========== Phase 3: Sparse Guilds ==========
      const finishSparseGuildsPhase = startPhase("sparse-guilds");
      for (const [guildId, guildConfig] of sparseGuilds) {
        if (signal?.aborted) break;

        const guildName = await refreshGuildMeta(guildId, guildConfig);
        log(options.verbose, `Syncing sparse guild: ${guildName}`);

        const minId = state.guildSparseCursors[guildId];
        if (minId) {
          log(options.verbose, `  Incremental from ${minId}`);
        }

        // Search for user's messages
        const messagesByChannel = new Map<string, { id: string; timestamp: string }[]>();
        let newestMsgId: string | undefined;
        let totalFound = 0;

        for await (const batch of client.searchGuildMessages(guildId, [userId], minId)) {
          if (signal?.aborted) break;

          for (const msg of batch) {
            const list = messagesByChannel.get(msg.channel_id) || [];
            list.push({ id: msg.id, timestamp: msg.timestamp });
            messagesByChannel.set(msg.channel_id, list);

            if (!newestMsgId || BigInt(msg.id) > BigInt(newestMsgId)) {
              newestMsgId = msg.id;
            }
          }
          totalFound += batch.length;
        }

        log(options.verbose, `  Found ${totalFound} messages in ${messagesByChannel.size} channels`);

        // Process each channel with sparse context
        for (const [channelId, userMessages] of messagesByChannel) {
          if (signal?.aborted) break;

          // Get channel info for context
          const ch = await client.getChannel(channelId);
          if (!ch) continue;

          const ctx: ChannelContext = {
            id: channelId,
            type: ch.type,
            name: ch.name || "(unknown)",
            guildId,
            guildName,
            category: "",
          };

          // Group into sessions and fetch context
          const sessions = groupIntoSessions(userMessages);
          for await (const batch of fetchSessionContext(client, channelId, sessions)) {
            if (signal?.aborted) break;
            await processBatch(batch, ctx);
          }
        }

        // Update sparse cursor
        const finalNewestId = newestMsgId || state.guildSparseCursors[guildId];
        if (finalNewestId) {
          state.guildSparseCursors[guildId] = finalNewestId;
        }

        flushIdentities();
      }
      finishSparseGuildsPhase();

      // ========== Phase 4: Reaction tier re-fetch ==========
      // Re-fetch messages whose age has just crossed a tier threshold (see
      // TIERS) to capture reactions added after the initial sync. Cheap because
      // we only fetch the band of messages aged across the threshold since the
      // previous sync. Any custom emoji discovered in the new reactions get
      // queued via upsertEmojiRefs for the download pass below.
      const channelIds = Object.keys(state.channelCursors);
      log(options.verbose, `Reaction rescan across ${channelIds.length} channel(s)...`);
      const finishReactionRescanPhase = startPhase("reaction-rescan");
      rescanStats = await rescanReactionTiers(
        client,
        db,
        rescanCursors,
        channelIds,
        state.channelCursors,
        userId,
        signal,
      );
      foldIncidentalMetrics();
      finishReactionRescanPhase();
      log(
        options.verbose,
        `Rescan: ${rescanStats.channelsChecked} fetched, ${rescanStats.channelsSkipped} skipped, ` +
          `${rescanStats.channelsSkippedEmptyBand} empty-band, ` +
          `${rescanStats.messagesReFetched} messages, ${rescanStats.observationsRecorded} observations`,
      );

      // ========== Phase 5: Recover details for calls inserted while active ==========
      const finishCallDetailPhase = startPhase("call-detail-refresh");
      if (!signal?.aborted) {
        const unavailableCallIds = new Set(state.callDetailUnavailableMessageIds ?? []);
        callDetailStats = await refreshIncompleteCallDetails(
          client,
          db,
          userId,
          unavailableCallIds,
          { currentImportBatch: importBatch, signal },
        );
        state.callDetailUnavailableMessageIds = [...unavailableCallIds];
        if (callDetailStats.attempted > 0) {
          log(
            options.verbose,
            `Call details: ${callDetailStats.updated} updated, ${callDetailStats.pending} still active, ` +
              `${callDetailStats.unavailable} unavailable, ${callDetailStats.failed} failed`,
          );
        }
      }
      finishCallDetailPhase();

      // ========== Phase 6: Capture voters from ended polls ==========
      const finishPollVoterPhase = startPhase("poll-voter-capture");
      if (!signal?.aborted) {
        pollVoterStats = await captureExpiredPollVoters(client, db, userId, signal);
        if (pollVoterStats.captured + pollVoterStats.failed > 0) {
          log(
            options.verbose,
            `Poll voters: ${pollVoterStats.captured} captured, ${pollVoterStats.failed} failed, ` +
              `${pollVoterStats.remaining} remaining`,
          );
        }
      }
      finishPollVoterPhase();

      // ========== Phase 7: Download pending custom emoji ==========
      // Single deduped pass after the message loops + rescan complete: each
      // unique emoji ID is fetched once regardless of how many messages
      // referenced it.
      const finishEmojiPhase = startPhase("emoji-download");
      if (!signal?.aborted) {
        try {
          const emojiResult = await downloadPendingEmojis(db, signal);
          totalEmojis = emojiResult;
          if (emojiResult.stored + emojiResult.tombstoned + emojiResult.failed > 0) {
            log(
              options.verbose,
              `Emoji: ${emojiResult.stored} stored, ${emojiResult.tombstoned} tombstoned, ${emojiResult.failed} failed`,
            );
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") throw err;
          console.error("[discord] Emoji download phase failed:", err);
        }
      }
      finishEmojiPhase();

      // ========== Phase 8: Retry interrupted/failed attachment downloads ==========
      // Attachment URLs saved in raw_data expire quickly, so candidates must be
      // re-fetched from Discord before the usual downloader can retry them.
      const finishAttachmentRecoveryPhase = startPhase("attachment-recovery");
      if (!signal?.aborted) {
        attachmentRecovery = await retryDiscordAttachments(db, client, userId, signal);
        totalAttachments.stored += attachmentRecovery.stored;
        totalAttachments.failed += attachmentRecovery.failed;
        if (attachmentRecovery.attempted > 0) {
          log(
            options.verbose,
            `Attachment recovery: ${attachmentRecovery.attempted} messages, ` +
              `${attachmentRecovery.stored} stored, ${attachmentRecovery.failed} failed, ` +
              `${attachmentRecovery.unrecoverable} unrecoverable, ${attachmentRecovery.unavailable} unavailable`,
          );
        }
      }
      finishAttachmentRecoveryPhase();

      // ========== Finalize ==========
      finalize(db, appDb, state, flushIdentities, totalAdded, importBatch);

      log(options.verbose, `Done: +${totalAdded} events, ${totalAttachments.stored} attachments stored, ${totalAttachments.failed} failed`);
      const clientStats = client.getStats();
      log(
        options.verbose,
        `HTTP: ${clientStats.totalRequests} request(s), ` +
          `${formatSeconds(clientStats.throttleSleepMs)} throttle, ` +
          `${formatSeconds(clientStats.proactiveRateLimitSleepMs)} rate-limit sleep, ` +
          `${formatSeconds(clientStats.retrySleepMs)} retry sleep, ${clientStats.rateLimit429Count} 429(s)`,
      );

      return {
        source: "discord",
        success: true,
        eventsAdded: totalAdded,
        eventsUpdated: discordEventsUpdated(rescanStats, callDetailStats, pollVoterStats),
        durationMs: Date.now() - startTime,
        metadata: buildDiscordSyncMetadata({
          attachments: totalAttachments,
          attachmentRecovery,
          emojis: totalEmojis,
          rescanStats,
          callDetails: callDetailStats,
          pollVoters: pollVoterStats,
          phaseStats,
          clientStats,
          optimizationStats,
        }),
      };
    } catch (error) {
      finishActivePhase();
      foldIncidentalMetrics();
      // Always finalize (upsert identities, save state, close db) even on error
      try {
        finalize(db, appDb, state, flushIdentities, totalAdded, importBatch);
      } catch (finalizeErr) {
        console.error("[discord] Error during finalization:", finalizeErr);
      }

      // Don't report abort as an error
      if (error instanceof DOMException && error.name === "AbortError") {
        return {
          source: "discord",
          success: true,
          eventsAdded: totalAdded,
          eventsUpdated: discordEventsUpdated(rescanStats, callDetailStats, pollVoterStats),
          durationMs: Date.now() - startTime,
          metadata: {
            cancelled: true,
            ...buildDiscordSyncMetadata({
              attachments: totalAttachments,
              attachmentRecovery,
              emojis: totalEmojis,
              rescanStats,
              callDetails: callDetailStats,
              pollVoters: pollVoterStats,
              phaseStats,
              clientStats: client.getStats(),
              optimizationStats,
            }),
          },
        };
      }

      return {
        source: "discord",
        success: false,
        eventsAdded: totalAdded,
        eventsUpdated: discordEventsUpdated(rescanStats, callDetailStats, pollVoterStats),
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
        metadata: buildDiscordSyncMetadata({
          attachments: totalAttachments,
          attachmentRecovery,
          emojis: totalEmojis,
          rescanStats,
          callDetails: callDetailStats,
          pollVoters: pollVoterStats,
          phaseStats,
          clientStats: client.getStats(),
          optimizationStats,
        }),
      };
    }
  },
};

/**
 * Finalize sync: upsert identities, trigger import hooks, save state, close DB.
 * Called on both success and error paths to ensure cleanup.
 */
function finalize(
  db: import("bun:sqlite").Database,
  appDb: import("bun:sqlite").Database,
  state: DiscordApiSyncState,
  flushIdentities: () => void,
  totalAdded: number,
  importBatch: string,
): void {
  flushIdentities();

  // Trigger import hooks
  if (totalAdded > 0) {
    onImportComplete(db);
  }

  // Save sync state
  setSyncState(appDb, "discord-api", state);

  db.close();
}

/**
 * Migrate reaction-rescan cursors to the unified tier-keyed map.
 *
 * Folds the legacy single-tier fields (rescanCursors24h/7d/30d, written before
 * cursors were unified) into state.rescanCursors and drops them so they stop
 * being serialized. Returns the map, which aliases state.rescanCursors so the
 * Phase 4 rescan's in-place cursor advances persist with the rest of the state
 * (no writeback needed).
 *
 * Per-tier buckets are seeded lazily by rescanReactionTiers (the sole reader),
 * not here, so bucket existence is owned by that loop and a freshly added tier
 * needs no change in this function. Buckets for tiers retired from TIERS are
 * pruned here so they stop being serialized.
 *
 * Idempotent: the unified bucket wins over any leftover legacy field (??=), so
 * re-running on already-migrated state is a no-op.
 */
export function migrateRescanCursors(state: DiscordApiSyncState): TierCursors {
  const legacy = state as DiscordApiSyncState & LegacyRescanCursorFields;
  const cursors = (state.rescanCursors ??= {});

  // The legacy tier set is a frozen historical fact, so fold its fields in by
  // name. The unified bucket wins if both somehow exist (??=).
  const fold = (tier: string, legacyCursors?: Record<string, string>) => {
    if (legacyCursors) cursors[tier] ??= legacyCursors;
  };
  fold("24h", legacy.rescanCursors24h);
  fold("7d", legacy.rescanCursors7d);
  fold("30d", legacy.rescanCursors30d);
  delete legacy.rescanCursors24h;
  delete legacy.rescanCursors7d;
  delete legacy.rescanCursors30d;

  // Prune buckets for tiers no longer in TIERS (e.g. 30d after the retune) —
  // the rescan would never read or advance them again.
  for (const tier of Object.keys(cursors)) {
    if (!TIERS.some((t) => t.name === tier)) delete cursors[tier];
  }

  return cursors;
}

/**
 * Parse guild configs from the source config.
 * Config format:
 *   [sync.discord.guilds.GUILD_ID]
 *   name = "Server Name"
 *   mode = "full"
 *   skip_discovery = false
 */
function parseGuildConfigs(sourceConfig?: Record<string, unknown>): Record<string, GuildConfig> {
  const guilds: Record<string, GuildConfig> = {};
  const guildsConfig = sourceConfig?.guilds;

  if (!guildsConfig || typeof guildsConfig !== "object") return guilds;

  for (const [guildId, config] of Object.entries(guildsConfig as Record<string, unknown>)) {
    if (!config || typeof config !== "object") continue;
    const c = config as Record<string, unknown>;

    const mode = c.mode as string | undefined;
    if (mode && mode !== "full" && mode !== "sparse") {
      console.warn(`[discord] Invalid mode "${mode}" for guild ${guildId}, defaulting to "full"`);
    }

    const channels = Array.isArray(c.channels)
      ? (c.channels as unknown[]).map(String)
      : undefined;

    const exclude_channels = Array.isArray(c.exclude_channels)
      ? (c.exclude_channels as unknown[]).map(String)
      : undefined;

    guilds[guildId] = {
      name: c.name as string | undefined,
      mode: mode === "sparse" ? "sparse" : "full",
      skip_discovery: (c.skip_discovery as boolean) || false,
      channels,
      exclude_channels,
    };
  }

  return guilds;
}
