/**
 * Discord API Client
 *
 * Native Discord API client extracted from an earlier local importer.
 * - Rate limiting with exponential backoff
 * - Snowflake <-> Date conversion
 * - Message fetching with pagination
 * - Thread discovery
 * - AbortSignal support for graceful cancellation
 */

const API_BASE = "https://discord.com/api/v10";
const DISCORD_EPOCH = 1420070400000n; // 2015-01-01 00:00:00 UTC

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Injectable so tests never await a real rate-limit/backoff timer. A real
// Discord Cloudflare 429 returns `Retry-After: 3600`, which fetchWithRetry would
// otherwise honour with an uninterruptible one-hour setTimeout — if a real
// request ever escaped a test's fetch mock (cross-test shared-state), the sync
// would hang for exactly one hour. Production keeps the real timer.
let sleep: (ms: number) => Promise<void> = realSleep;

/**
 * Test-only seam: override the retry/rate-limit sleep (e.g. with an instant
 * no-op) so no test can block on a real hour-scale Discord backoff. Pass null to
 * restore the real timer.
 */
export function setDiscordClientSleepForTests(
  fn: ((ms: number) => Promise<void>) | null,
): void {
  sleep = fn ?? realSleep;
}

export interface DiscordClientStats {
  totalRequests: number;
  routeCounts: Record<string, number>;
  routeDurationMs: Record<string, number>;
  routeMaxDurationMs: Record<string, number>;
  statusCounts: Record<string, number>;
  routeStatusCounts: Record<string, Record<string, number>>;
  throttleSleepMs: number;
  throttleSleepCount: number;
  proactiveRateLimitSleepMs: number;
  proactiveRateLimitSleepCount: number;
  rateLimit429Count: number;
  retrySleepMs: number;
  retrySleepCount: number;
  serverRetryCount: number;
  networkRetryCount: number;
}

interface ChannelAccessHandlers {
  onForbidden?: (channelId: string) => void;
  onNotFound?: (channelId: string) => void;
}

export type MessageRangeCompletion =
  | { kind: "complete" }
  | { kind: "unavailable"; status: 403 | 404 };

export type MessagePresence =
  | { kind: "found"; message: NormalizedMessage }
  | { kind: "missing" }
  | { kind: "unavailable"; status: 403 | 404 };

function createStats(): DiscordClientStats {
  return {
    totalRequests: 0,
    routeCounts: {},
    routeDurationMs: {},
    routeMaxDurationMs: {},
    statusCounts: {},
    routeStatusCounts: {},
    throttleSleepMs: 0,
    throttleSleepCount: 0,
    proactiveRateLimitSleepMs: 0,
    proactiveRateLimitSleepCount: 0,
    rateLimit429Count: 0,
    retrySleepMs: 0,
    retrySleepCount: 0,
    serverRetryCount: 0,
    networkRetryCount: 0,
  };
}

function incrementCounter(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function recordRouteDuration(
  totals: Record<string, number>,
  maxes: Record<string, number>,
  route: string,
  durationMs: number,
): void {
  totals[route] = (totals[route] ?? 0) + durationMs;
  maxes[route] = Math.max(maxes[route] ?? 0, durationMs);
}

export function classifyDiscordRoute(url: string): string {
  const parsed = new URL(url);
  let path = parsed.pathname.replace(/^\/api\/v\d+/, "");

  if (path === "/users/@me" || path === "/users/@me/channels") {
    return path;
  }

  if (/^\/channels\/[^/]+\/messages\/[^/]+\/reactions\/[^/]+$/.test(path)) {
    return "/channels/:id/messages/:id/reactions/:emoji";
  }
  if (/^\/channels\/[^/]+\/polls\/[^/]+\/answers\/[^/]+$/.test(path)) {
    return "/channels/:id/polls/:id/answers/:id";
  }
  if (/^\/channels\/[^/]+\/messages$/.test(path)) {
    path = "/channels/:id/messages";
    const modes = ["after", "before", "around"].filter((key) => parsed.searchParams.has(key));
    return modes.length > 0 ? `${path}?${modes.join("&")}` : path;
  }
  if (/^\/channels\/[^/]+\/threads\/search$/.test(path)) {
    const archived = parsed.searchParams.get("archived") === "true" ? "true" : "false";
    return `/channels/:id/threads/search?archived=${archived}`;
  }
  if (/^\/channels\/[^/]+$/.test(path)) {
    return "/channels/:id";
  }
  if (/^\/guilds\/[^/]+\/channels$/.test(path)) {
    return "/guilds/:id/channels";
  }
  if (/^\/guilds\/[^/]+\/emojis$/.test(path)) {
    return "/guilds/:id/emojis";
  }
  if (/^\/guilds\/[^/]+\/messages\/search$/.test(path)) {
    const modes = ["min_id", "max_id"].filter((key) => parsed.searchParams.has(key));
    return modes.length > 0
      ? `/guilds/:id/messages/search?${modes.join("&")}`
      : "/guilds/:id/messages/search";
  }
  if (/^\/guilds\/[^/]+$/.test(path)) {
    return "/guilds/:id";
  }
  if (/^\/users\/[^/]+$/.test(path)) {
    return "/users/:id";
  }

  return path;
}

// Snowflake utilities
export function snowflakeToDate(snowflake: string): Date {
  const id = BigInt(snowflake);
  const timestamp = Number((id >> 22n) + DISCORD_EPOCH);
  return new Date(timestamp);
}

export function dateToSnowflake(date: Date): string {
  const timestamp = BigInt(date.getTime());
  const snowflake = (timestamp - DISCORD_EPOCH) << 22n;
  return snowflake.toString();
}

export function decrementSnowflake(snowflake: string): string {
  return (BigInt(snowflake) - 1n).toString();
}

export function incrementSnowflake(snowflake: string): string {
  return (BigInt(snowflake) + 1n).toString();
}

// Discord API types
export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  discriminator: string;
  avatar: string | null;
  bot?: boolean;
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  proxy_url: string;
  content_type?: string;
  width?: number;
  height?: number;
}

export interface DiscordEmbed {
  title?: string;
  type?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: { text: string; icon_url?: string };
  image?: { url: string; width?: number; height?: number };
  thumbnail?: { url: string; width?: number; height?: number };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export interface DiscordReaction {
  count: number;
  me: boolean;
  emoji: { id: string | null; name: string; animated?: boolean };
}

export interface DiscordPollMedia {
  text?: string;
  emoji?: { id: string | null; name: string; animated?: boolean };
}

/**
 * Poll attached to a message. See:
 * https://docs.discord.com/developers/resources/poll
 * `results` may be absent in some responses (absent ≠ zero votes); answers
 * with no votes are omitted from `answer_counts`.
 */
export interface DiscordPoll {
  question: DiscordPollMedia;
  answers: Array<{ answer_id: number; poll_media: DiscordPollMedia }>;
  expiry: string | null;
  allow_multiselect: boolean;
  layout_type: number;
  results?: {
    is_finalized: boolean;
    answer_counts: Array<{ id: number; count: number; me_voted: boolean }>;
  };
}

export interface DiscordGuildEmoji {
  id: string;
  name: string;
  roles?: string[];
  user?: DiscordUser;
  require_colons?: boolean;
  managed?: boolean;
  animated?: boolean;
  available?: boolean;
}

export interface DiscordMentionChannel {
  id: string;
  guild_id: string;
  type: number;
  name: string;
}

/**
 * Forwarded-message snapshot. See:
 * https://docs.discord.com/developers/resources/message#message-snapshot-object
 * Contains a minimal copy of the forwarded message. Author is intentionally
 * excluded by Discord.
 */
export interface DiscordMessageSnapshot {
  message: {
    type: number;
    content: string;
    embeds: DiscordEmbed[];
    attachments: DiscordAttachment[];
    timestamp: string;
    edited_timestamp: string | null;
    flags?: number;
    mentions: DiscordUser[];
    mention_roles?: string[];
    sticker_items?: Array<{ id: string; name: string; format_type: number }>;
    components?: unknown[];
  };
}

export interface DiscordMessage {
  id: string;
  type: number;
  content: string;
  channel_id: string;
  author: DiscordUser;
  timestamp: string;
  edited_timestamp: string | null;
  tts: boolean;
  mention_everyone: boolean;
  mentions: DiscordUser[];
  mention_roles?: string[];
  mention_channels?: DiscordMentionChannel[];
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
  reactions?: DiscordReaction[];
  pinned: boolean;
  referenced_message?: DiscordMessage | null;
  message_reference?: {
    type?: number;
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  };
  message_snapshots?: DiscordMessageSnapshot[];
  flags?: number;
  thread?: DiscordThread;
  sticker_items?: Array<{ id: string; name: string; format_type: number }>;
  call?: { participants: string[]; ended_timestamp?: string };
  poll?: DiscordPoll;
  components?: unknown[];
  interaction_metadata?: unknown;
  webhook_id?: string;
  application_id?: string;
  activity?: { type: number; party_id?: string };
}

export interface DiscordThread {
  id: string;
  name: string;
  parent_id: string | null;
  type: number;
  guild_id?: string;
  owner_id?: string;
  last_message_id?: string | null;
  message_count?: number;
  member_count?: number;
  thread_metadata?: {
    archived: boolean;
    archive_timestamp: string;
    auto_archive_duration: number;
    locked: boolean;
  };
}

export interface DiscordChannelRecipient {
  id: string;
  username: string;
  global_name: string | null;
}

export interface DiscordChannel {
  id: string;
  type: number;
  name: string;
  guild_id?: string;
  parent_id?: string | null;
  topic?: string | null;
  last_message_id?: string | null;
  recipients?: DiscordChannelRecipient[];
}

// Normalized types
export interface ReactionUser {
  id: string;
  name: string;
}

/** Poll voter identity stored in raw_data.poll.voters.answers. */
export interface PollVoter {
  id: string;
  name: string;
  username: string;
  avatar: string | null;
}

export interface NormalizedReaction {
  emoji: { id: string | null; name: string; animated?: boolean };
  count: number;
  users?: ReactionUser[];
}

export interface NormalizedThread {
  id: string;
  name: string;
  parentId: string | null;
  type: number;
  guildId?: string;
  ownerId?: string;
  lastMessageId?: string | null;
}

export interface NormalizedMessage {
  id: string;
  type: string;
  timestamp: string;
  timestampEdited: string | null;
  content: string;
  flags?: number;
  author: {
    id: string;
    name: string;
    nickname: string | null;
    isBot: boolean;
    avatarUrl: string | null;
  };
  attachments: Array<{
    id: string;
    url: string;
    fileName: string;
    fileSizeBytes: number;
    contentType?: string;
    width?: number;
    height?: number;
  }>;
  embeds: DiscordEmbed[];
  reactions: NormalizedReaction[];
  mentions: Array<{ id: string; name: string }>;
  mentionRoles?: string[];
  mentionChannels?: Array<{ id: string; guildId: string; type: number; name: string }>;
  reference?: {
    type?: number;
    messageId?: string;
    channelId?: string;
    guildId?: string;
  };
  snapshots?: DiscordMessageSnapshot[];
  referencedMessage?: NormalizedMessage | null;
  thread?: NormalizedThread;
  stickerItems?: Array<{ id: string; name: string; formatType: number }>;
  call?: { participants: string[]; endedTimestamp?: string };
  poll?: DiscordPoll;
  components?: unknown[];
  interactionMetadata?: unknown;
  webhookId?: string;
  applicationId?: string;
  activity?: { type: number; partyId?: string };
  rawType: number;
}

// Message type mapping
// https://discord.com/developers/docs/resources/message#message-object-message-types
const MESSAGE_TYPES: Record<number, string> = {
  0: "Default",
  1: "RecipientAdd",
  2: "RecipientRemove",
  3: "Call",
  4: "ChannelNameChange",
  5: "ChannelIconChange",
  6: "ChannelPinnedMessage",
  7: "GuildMemberJoin",
  8: "UserPremiumGuildSubscription",
  9: "UserPremiumGuildSubscriptionTier1",
  10: "UserPremiumGuildSubscriptionTier2",
  11: "UserPremiumGuildSubscriptionTier3",
  12: "ChannelFollowAdd",
  14: "GuildDiscoveryDisqualified",
  15: "GuildDiscoveryRequalified",
  16: "GuildDiscoveryGracePeriodInitialWarning",
  17: "GuildDiscoveryGracePeriodFinalWarning",
  18: "ThreadCreated",
  19: "Reply",
  20: "ChatInputCommand",
  21: "ThreadStarterMessage",
  22: "GuildInviteReminder",
  23: "ContextMenuCommand",
  24: "AutoModerationAction",
  25: "RoleSubscriptionPurchase",
  26: "InteractionPremiumUpsell",
  27: "StageStart",
  28: "StageEnd",
  29: "StageSpeaker",
  31: "StageTopic",
  32: "GuildApplicationPremiumSubscription",
  36: "GuildIncidentAlertModeEnabled",
  37: "GuildIncidentAlertModeDisabled",
  38: "GuildIncidentReportRaid",
  39: "GuildIncidentReportFalseAlarm",
  44: "PurchaseNotification",
  46: "PollResult",
};

// Channel type constants
export const CHANNEL_TYPE = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_STAGE: 13,
  GUILD_DIRECTORY: 14,
  GUILD_FORUM: 15,
} as const;

export const THREAD_CHANNEL_TYPES = [
  CHANNEL_TYPE.ANNOUNCEMENT_THREAD,
  CHANNEL_TYPE.PUBLIC_THREAD,
  CHANNEL_TYPE.PRIVATE_THREAD,
] as const;

const THREAD_CHANNEL_TYPE_SET = new Set<number>(THREAD_CHANNEL_TYPES);

// Channel type name mapping
const CHANNEL_TYPES: Record<number, string> = {
  0: "GuildTextChat",
  1: "DirectMessage",
  2: "GuildVoice",
  3: "GroupDirectMessage",
  4: "GuildCategory",
  5: "GuildAnnouncement",
  10: "GuildAnnouncementThread",
  11: "GuildPublicThread",
  12: "GuildPrivateThread",
  13: "GuildStageVoice",
  14: "GuildDirectory",
  15: "GuildForum",
};

export function getChannelTypeName(type: number): string {
  return CHANNEL_TYPES[type] || `Unknown(${type})`;
}

export function getChannelTypeFromName(name: string): number | null {
  for (const [id, n] of Object.entries(CHANNEL_TYPES)) {
    if (n === name) return parseInt(id, 10);
  }
  return null;
}

export function isThreadType(type: number): boolean {
  return THREAD_CHANNEL_TYPE_SET.has(type);
}

export function normalizeMessage(msg: DiscordMessage): NormalizedMessage {
  return {
    id: msg.id,
    type: MESSAGE_TYPES[msg.type] || `Unknown(${msg.type})`,
    rawType: msg.type,
    timestamp: msg.timestamp,
    timestampEdited: msg.edited_timestamp,
    content: msg.content,
    flags: msg.flags,
    author: {
      id: msg.author.id,
      name: msg.author.username,
      nickname: msg.author.global_name,
      isBot: msg.author.bot || false,
      avatarUrl: msg.author.avatar
        ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.png`
        : null,
    },
    attachments: msg.attachments.map((a) => ({
      id: a.id,
      url: a.url,
      fileName: a.filename,
      fileSizeBytes: a.size,
      contentType: a.content_type,
      width: a.width,
      height: a.height,
    })),
    embeds: msg.embeds,
    reactions: (msg.reactions || []).map((r) => ({
      emoji: r.emoji,
      count: r.count,
    })),
    mentions: msg.mentions.map((u) => ({
      id: u.id,
      name: u.global_name || u.username,
    })),
    mentionRoles: msg.mention_roles,
    mentionChannels: msg.mention_channels?.map((c) => ({
      id: c.id,
      guildId: c.guild_id,
      type: c.type,
      name: c.name,
    })),
    reference: msg.message_reference
      ? {
          type: msg.message_reference.type,
          messageId: msg.message_reference.message_id,
          channelId: msg.message_reference.channel_id,
          guildId: msg.message_reference.guild_id,
        }
      : undefined,
    snapshots: msg.message_snapshots,
    referencedMessage: msg.referenced_message
      ? normalizeMessage(msg.referenced_message)
      : msg.referenced_message === null
        ? null
        : undefined,
    thread: msg.thread
      ? {
          id: msg.thread.id,
          name: msg.thread.name,
          parentId: msg.thread.parent_id,
          type: msg.thread.type,
          guildId: msg.thread.guild_id,
          ownerId: msg.thread.owner_id,
          lastMessageId: msg.thread.last_message_id,
        }
      : undefined,
    stickerItems: msg.sticker_items?.map((s) => ({
      id: s.id,
      name: s.name,
      formatType: s.format_type,
    })),
    call: msg.call
      ? {
          participants: msg.call.participants,
          endedTimestamp: msg.call.ended_timestamp,
        }
      : undefined,
    poll: msg.poll,
    components: msg.components,
    interactionMetadata: msg.interaction_metadata,
    webhookId: msg.webhook_id,
    applicationId: msg.application_id,
    activity: msg.activity
      ? { type: msg.activity.type, partyId: msg.activity.party_id }
      : undefined,
  };
}

export class DiscordClient {
  private headers: Record<string, string>;
  private lastRequestTime = 0;
  private signal?: AbortSignal;
  private stats = createStats();

  constructor(private token: string, signal?: AbortSignal) {
    this.headers = {
      Authorization: token,
      "Content-Type": "application/json",
    };
    this.signal = signal;
  }

  private checkAborted(): void {
    if (this.signal?.aborted) {
      throw new DOMException("Discord sync aborted", "AbortError");
    }
  }

  getStats(): DiscordClientStats {
    return {
      ...this.stats,
      routeCounts: { ...this.stats.routeCounts },
      routeDurationMs: { ...this.stats.routeDurationMs },
      routeMaxDurationMs: { ...this.stats.routeMaxDurationMs },
      statusCounts: { ...this.stats.statusCounts },
      routeStatusCounts: Object.fromEntries(
        Object.entries(this.stats.routeStatusCounts).map(([route, counts]) => [
          route,
          { ...counts },
        ]),
      ),
    };
  }

  private async trackedSleep(ms: number): Promise<number> {
    const startedAt = Date.now();
    await sleep(ms);
    return Date.now() - startedAt;
  }

  private async rateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < 100) {
      this.stats.throttleSleepCount++;
      this.stats.throttleSleepMs += await this.trackedSleep(100 - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

  private async fetchWithRetry(url: string, maxRetries = 8): Promise<Response> {
    const route = classifyDiscordRoute(url);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      this.checkAborted();
      let requestStartedAt = 0;

      try {
        await this.rateLimit();
        requestStartedAt = Date.now();
        this.stats.totalRequests++;
        incrementCounter(this.stats.routeCounts, route);
        const res = await fetch(url, {
          headers: this.headers,
          signal: this.signal,
        });
        const status = String(res.status);
        incrementCounter(this.stats.statusCounts, status);
        const routeStatusCounts = (this.stats.routeStatusCounts[route] ??= {});
        incrementCounter(routeStatusCounts, status);

        // Handle rate limit headers proactively
        const remaining = res.headers.get("X-RateLimit-Remaining");
        const resetAfter = res.headers.get("X-RateLimit-Reset-After");
        if (remaining === "0" && resetAfter) {
          const resetAfterSeconds = Number.parseFloat(resetAfter);
          if (Number.isFinite(resetAfterSeconds)) {
            this.stats.proactiveRateLimitSleepCount++;
            this.stats.proactiveRateLimitSleepMs += await this.trackedSleep(
              (resetAfterSeconds + 0.5) * 1000,
            );
          }
        }

        if (res.status === 429) {
          const retryAfter = Number.parseFloat(res.headers.get("Retry-After") || "1");
          const retryAfterSeconds = Number.isFinite(retryAfter) ? retryAfter : 1;
          this.stats.rateLimit429Count++;
          this.stats.retrySleepCount++;
          console.error(`Rate limited, waiting ${retryAfterSeconds}s...`);
          this.stats.retrySleepMs += await this.trackedSleep(retryAfterSeconds * 1000);
          recordRouteDuration(
            this.stats.routeDurationMs,
            this.stats.routeMaxDurationMs,
            route,
            Date.now() - requestStartedAt,
          );
          continue;
        }

        if (res.status >= 500 || res.status === 408) {
          const delay = Math.pow(2, attempt) + 1;
          this.stats.serverRetryCount++;
          this.stats.retrySleepCount++;
          console.error(`Server error ${res.status}, retrying in ${delay}s...`);
          this.stats.retrySleepMs += await this.trackedSleep(delay * 1000);
          recordRouteDuration(
            this.stats.routeDurationMs,
            this.stats.routeMaxDurationMs,
            route,
            Date.now() - requestStartedAt,
          );
          continue;
        }

        recordRouteDuration(
          this.stats.routeDurationMs,
          this.stats.routeMaxDurationMs,
          route,
          Date.now() - requestStartedAt,
        );
        return res;
      } catch (e) {
        // Re-throw abort errors immediately
        if (e instanceof DOMException && e.name === "AbortError") throw e;
        if (attempt === maxRetries) {
          if (requestStartedAt > 0) {
            recordRouteDuration(
              this.stats.routeDurationMs,
              this.stats.routeMaxDurationMs,
              route,
              Date.now() - requestStartedAt,
            );
          }
          throw e;
        }
        const delay = Math.pow(2, attempt) + 1;
        this.stats.networkRetryCount++;
        this.stats.retrySleepCount++;
        console.error(`Request failed, retrying in ${delay}s...`, e);
        this.stats.retrySleepMs += await this.trackedSleep(delay * 1000);
        if (requestStartedAt > 0) {
          recordRouteDuration(
            this.stats.routeDurationMs,
            this.stats.routeMaxDurationMs,
            route,
            Date.now() - requestStartedAt,
          );
        }
      }
    }
    throw new Error("Max retries exceeded");
  }

  async getChannel(
    channelId: string,
    handlers?: ChannelAccessHandlers,
  ): Promise<DiscordChannel | null> {
    const res = await this.fetchWithRetry(`${API_BASE}/channels/${channelId}`);
    if (!res.ok) {
      if (res.status === 403) handlers?.onForbidden?.(channelId);
      if (res.status === 404) handlers?.onNotFound?.(channelId);
      return null;
    }
    return res.json();
  }

  async fetchUser(userId: string): Promise<DiscordUser | null> {
    const res = await this.fetchWithRetry(`${API_BASE}/users/${userId}`);
    if (!res.ok) return null;
    return res.json();
  }

  /**
   * Fetch a single message by ID. Uses the listing endpoint with `?around=`
   * because the direct `GET /channels/{c}/messages/{m}` endpoint is
   * bot-only (returns 403 "Only bots can use this endpoint" for user tokens).
   */
  async fetchMessage(
    channelId: string,
    messageId: string,
  ): Promise<NormalizedMessage | null> {
    const result = await this.fetchMessageResult(channelId, messageId);
    if (result.status === 403 || result.status === 404) return null;
    if (!result.ok) throw new Error(`Failed to fetch message: ${result.status}`);
    return result.message ?? null;
  }

  private async fetchMessageResult(
    channelId: string,
    messageId: string,
  ): Promise<{ ok: boolean; status: number; message?: NormalizedMessage }> {
    const url = `${API_BASE}/channels/${channelId}/messages?limit=1&around=${messageId}`;
    const res = await this.fetchWithRetry(url);
    if (!res.ok) return { ok: false, status: res.status };
    const messages: DiscordMessage[] = await res.json();
    const match = messages.find((m) => m.id === messageId);
    return { ok: true, status: res.status, message: match ? normalizeMessage(match) : undefined };
  }

  /**
   * Fetch a message for attachment recovery, preserving a 404 distinction so
   * callers only tombstone attachments that Discord confirms are gone.
   */
  async fetchMessageForAttachmentRecovery(
    channelId: string,
    messageId: string,
  ): Promise<
    | { kind: "found"; message: NormalizedMessage }
    | { kind: "not-found" }
    | { kind: "unavailable" }
  > {
    const result = await this.fetchMessageResult(channelId, messageId);
    if (result.status === 404) return { kind: "not-found" };
    if (result.status === 403) return { kind: "unavailable" };
    if (!result.ok) throw new Error(`Failed to fetch message: ${result.status}`);
    return result.message ? { kind: "found", message: result.message } : { kind: "not-found" };
  }

  async *fetchMessages(
    channelId: string,
    after?: string,
    handlers?: ChannelAccessHandlers,
  ): AsyncGenerator<NormalizedMessage[]> {
    let currentAfter = after ?? "0";

    while (true) {
      this.checkAborted();
      const url = `${API_BASE}/channels/${channelId}/messages?limit=100&after=${currentAfter}`;
      const res = await this.fetchWithRetry(url);

      if (!res.ok) {
        if (res.status === 403) {
          handlers?.onForbidden?.(channelId);
          return;
        }
        if (res.status === 404) return;
        throw new Error(`Failed to fetch messages: ${res.status}`);
      }

      const messages: DiscordMessage[] = await res.json();
      if (messages.length === 0) break;

      // Messages come newest→oldest, reverse for chronological order
      messages.reverse();
      yield messages.map(normalizeMessage);
      currentAfter = messages[messages.length - 1].id;
    }
  }

  async *fetchMessagesInRange(
    channelId: string,
    afterSnowflake: string,
    beforeSnowflake: string,
    handlers?: {
      onComplete?: () => void;
      onUnavailable?: (status: 403 | 404) => void;
    },
  ): AsyncGenerator<NormalizedMessage[], MessageRangeCompletion> {
    const afterId = BigInt(afterSnowflake);
    let currentBefore = beforeSnowflake;

    while (true) {
      this.checkAborted();
      // Page backwards from the upper bound. Paging forward with `after` can
      // repeatedly return the newest messages and falsely appear to finish
      // before reaching an older reconciliation band.
      const url = `${API_BASE}/channels/${channelId}/messages?limit=100&before=${currentBefore}`;
      const res = await this.fetchWithRetry(url);

      if (!res.ok) {
        if (res.status === 403 || res.status === 404) {
          const status = res.status as 403 | 404;
          handlers?.onUnavailable?.(status);
          return { kind: "unavailable", status };
        }
        throw new Error(`Failed to fetch messages: ${res.status}`);
      }

      const messages: DiscordMessage[] = await res.json();
      if (messages.length === 0) {
        handlers?.onComplete?.();
        return { kind: "complete" };
      }

      const filtered = messages.filter((m) => BigInt(m.id) > afterId);

      if (filtered.length > 0) {
        yield filtered.reverse().map(normalizeMessage);
      }

      if (filtered.length < messages.length) {
        handlers?.onComplete?.();
        return { kind: "complete" };
      }
      currentBefore = messages[messages.length - 1].id;
    }
  }

  /**
   * Confirm whether a message is present using the user-token-compatible
   * `around` listing. Only a successful response that omits the requested ID
   * proves absence; 403/404 describe channel availability.
   */
  async checkMessagePresence(channelId: string, messageId: string): Promise<MessagePresence> {
    const result = await this.fetchMessageResult(channelId, messageId);
    if (result.status === 403 || result.status === 404) {
      return { kind: "unavailable", status: result.status };
    }
    if (!result.ok) throw new Error(`Failed to check message presence: ${result.status}`);
    return result.message ? { kind: "found", message: result.message } : { kind: "missing" };
  }

  async fetchMessagesBefore(
    channelId: string,
    beforeSnowflake: string,
    limit: number,
    maxAgeMs: number
  ): Promise<NormalizedMessage[]> {
    const results: NormalizedMessage[] = [];
    const refTime = snowflakeToDate(beforeSnowflake).getTime();
    const cutoffTime = refTime - maxAgeMs;
    let currentBefore = beforeSnowflake;

    while (results.length < limit) {
      this.checkAborted();
      const url = `${API_BASE}/channels/${channelId}/messages?limit=100&before=${currentBefore}`;
      const res = await this.fetchWithRetry(url);

      if (!res.ok) {
        if (res.status === 403 || res.status === 404) break;
        throw new Error(`Failed to fetch messages: ${res.status}`);
      }

      const messages: DiscordMessage[] = await res.json();
      if (messages.length === 0) break;

      for (const msg of messages) {
        const msgTime = new Date(msg.timestamp).getTime();
        if (msgTime < cutoffTime) return results.reverse();
        if (results.length >= limit) break;
        results.push(normalizeMessage(msg));
      }

      currentBefore = messages[messages.length - 1].id;
    }

    return results.reverse();
  }

  async fetchMessagesAfter(
    channelId: string,
    afterSnowflake: string,
    limit: number,
    maxAgeMs: number
  ): Promise<NormalizedMessage[]> {
    const results: NormalizedMessage[] = [];
    const refTime = snowflakeToDate(afterSnowflake).getTime();
    const cutoffTime = refTime + maxAgeMs;
    let currentAfter = afterSnowflake;

    while (results.length < limit) {
      this.checkAborted();
      const url = `${API_BASE}/channels/${channelId}/messages?limit=100&after=${currentAfter}`;
      const res = await this.fetchWithRetry(url);

      if (!res.ok) {
        if (res.status === 403 || res.status === 404) break;
        throw new Error(`Failed to fetch messages: ${res.status}`);
      }

      const messages: DiscordMessage[] = await res.json();
      if (messages.length === 0) break;

      messages.reverse();
      for (const msg of messages) {
        const msgTime = new Date(msg.timestamp).getTime();
        if (msgTime > cutoffTime) return results;
        if (results.length >= limit) break;
        results.push(normalizeMessage(msg));
      }

      currentAfter = messages[messages.length - 1].id;
    }

    return results;
  }

  async *searchThreads(
    channelId: string,
    archived: boolean,
    handlers?: ChannelAccessHandlers,
  ): AsyncGenerator<DiscordThread[]> {
    let offset = 0;
    const pageSize = 25;

    while (true) {
      this.checkAborted();
      const url = `${API_BASE}/channels/${channelId}/threads/search?archived=${archived}&offset=${offset}`;
      const res = await this.fetchWithRetry(url);

      if (!res.ok) {
        if (res.status === 403) {
          handlers?.onForbidden?.(channelId);
          return;
        }
        if (res.status === 404) return;
        throw new Error(`Failed to search threads: ${res.status}`);
      }

      const data = (await res.json()) as {
        threads: DiscordThread[];
        has_more: boolean;
        total_results: number;
      };

      if (!data.threads || data.threads.length === 0) break;
      yield data.threads;
      if (!data.has_more) break;
      offset += pageSize;
    }
  }

  async fetchGuildChannels(guildId: string): Promise<DiscordChannel[]> {
    const res = await this.fetchWithRetry(`${API_BASE}/guilds/${guildId}/channels`);
    if (!res.ok) return [];
    return res.json() as Promise<DiscordChannel[]>;
  }

  async fetchGuildEmojis(guildId: string): Promise<DiscordGuildEmoji[] | null> {
    const res = await this.fetchWithRetry(`${API_BASE}/guilds/${guildId}/emojis`);
    if (!res.ok) return null;
    return res.json() as Promise<DiscordGuildEmoji[]>;
  }

  async fetchDMChannels(): Promise<DiscordChannel[]> {
    const res = await this.fetchWithRetry(`${API_BASE}/users/@me/channels`);
    if (!res.ok) return [];
    return res.json() as Promise<DiscordChannel[]>;
  }

  async fetchGuild(
    guildId: string,
  ): Promise<{ id: string; name: string; icon: string | null } | null> {
    const res = await this.fetchWithRetry(`${API_BASE}/guilds/${guildId}`);
    if (!res.ok) return null;
    // `icon` is the guild icon hash (null when the guild has no icon). Animated
    // icons use an `a_`-prefixed hash; the `.png` CDN URL renders them static.
    return res.json() as Promise<{ id: string; name: string; icon: string | null }>;
  }

  async getCurrentUser(): Promise<{ id: string; username: string } | null> {
    const res = await this.fetchWithRetry(`${API_BASE}/users/@me`);
    if (!res.ok) return null;
    return res.json() as Promise<{ id: string; username: string }>;
  }

  async *searchGuildMessages(
    guildId: string,
    authorIds: string[],
    minId?: string
  ): AsyncGenerator<{ id: string; channel_id: string; timestamp: string }[]> {
    for (const authorId of authorIds) {
      let maxId: string | undefined = undefined;
      let totalFetched = 0;

      while (true) {
        this.checkAborted();
        let url = `${API_BASE}/guilds/${guildId}/messages/search?author_id=${authorId}`;
        if (minId) url += `&min_id=${minId}`;
        if (maxId) url += `&max_id=${maxId}`;

        const res = await this.fetchWithRetry(url);
        if (!res.ok) {
          if (res.status === 403) return;
          throw new Error(`Search failed: ${res.status}`);
        }

        const data = (await res.json()) as {
          messages: DiscordMessage[][];
          total_results: number;
        };
        if (!data.messages || data.messages.length === 0) break;

        const messages = data.messages
          .filter((group) => group.length > 0)
          .map((group) => ({
            id: group[0].id,
            channel_id: group[0].channel_id,
            timestamp: group[0].timestamp,
          }));

        yield messages;

        const lastGroup = data.messages[data.messages.length - 1];
        if (lastGroup && lastGroup.length > 0) {
          maxId = lastGroup[0].id;
        }

        totalFetched += data.messages.length;
        if (totalFetched >= data.total_results) break;
      }
    }
  }

  async fetchReactionUsers(
    channelId: string,
    messageId: string,
    emoji: { id: string | null; name: string }
  ): Promise<ReactionUser[]> {
    if (emoji.id) {
      return this.tryFetchReactionUsers(channelId, messageId, `${emoji.name}:${emoji.id}`);
    }

    const original = emoji.name;
    const stripped = emoji.name.replace(/[\ufe0e\ufe0f]/g, "");
    const withSelector = stripped + "\ufe0f";

    const variants = [original];
    if (stripped !== original) variants.push(stripped);
    if (withSelector !== original && withSelector !== stripped) variants.push(withSelector);

    for (const variant of variants) {
      const users = await this.tryFetchReactionUsers(channelId, messageId, encodeURIComponent(variant));
      if (users.length > 0) return users;
    }

    return [];
  }

  private async tryFetchReactionUsers(
    channelId: string,
    messageId: string,
    emojiParam: string
  ): Promise<ReactionUser[]> {
    const url = `${API_BASE}/channels/${channelId}/messages/${messageId}/reactions/${emojiParam}?limit=100`;
    const res = await this.fetchWithRetry(url);
    if (!res.ok) {
      if (res.status === 400 || res.status === 403 || res.status === 404) return [];
      throw new Error(`Failed to fetch reaction users: ${res.status}`);
    }

    const users = (await res.json()) as DiscordUser[];
    return users.map((u) => ({
      id: u.id,
      name: u.global_name || u.username,
    }));
  }

  async fetchPollAnswerVoters(
    channelId: string,
    messageId: string,
    answerId: number,
  ): Promise<PollVoter[]> {
    return this.tryFetchPollAnswerVoters(channelId, messageId, answerId);
  }

  private async tryFetchPollAnswerVoters(
    channelId: string,
    messageId: string,
    answerId: number,
  ): Promise<PollVoter[]> {
    const users: PollVoter[] = [];
    let after: string | undefined;

    while (true) {
      const params = new URLSearchParams({ limit: "100" });
      if (after) params.set("after", after);
      const url = `${API_BASE}/channels/${channelId}/polls/${messageId}/answers/${answerId}?${params}`;
      const res = await this.fetchWithRetry(url);
      if (!res.ok) {
        if (!after && (res.status === 400 || res.status === 403 || res.status === 404)) return [];
        throw new Error(`Failed to fetch poll answer voters: ${res.status}`);
      }

      const page = (await res.json()) as { users: DiscordUser[] };
      users.push(...page.users.map((u) => ({
        id: u.id,
        name: u.global_name ?? u.username,
        username: u.username,
        avatar: u.avatar,
      })));
      if (page.users.length < 100) return users;
      const lastUser = page.users.at(-1);
      if (!lastUser) return users;
      after = lastUser.id;
    }
  }

  async fetchAllReactionUsers(
    channelId: string,
    messageId: string,
    reactions: NormalizedReaction[]
  ): Promise<NormalizedReaction[]> {
    const enriched: NormalizedReaction[] = [];
    for (const reaction of reactions) {
      const users = await this.fetchReactionUsers(channelId, messageId, reaction.emoji);
      enriched.push({ ...reaction, users });
    }
    return enriched;
  }
}
