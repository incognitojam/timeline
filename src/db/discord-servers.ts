import { conversationTypeClause, fillMonthGaps } from "./conversations";
import { formatIdentifier, parseIdentifier, type ResolvedIdentity, resolveIdentities } from "./identities";
import type { QueryExecutor } from "./pool";

/**
 * Discord "server" (guild) views.
 *
 * Discord guild/channel metadata is not promoted to dedicated columns — it
 * lives in `raw_data._channel` (guild_id, guild_name, name, category, type).
 * Rather than `json_extract` across every Discord row, we join each
 * `conversation_summaries` row to its latest titled event. All messages in a
 * channel share the same guild, so that representative event carries the
 * current names while the summary supplies counts and date ranges.
 *
 * The result is one metadata row per Discord channel, which
 * powers both the server index (grouped by guild) and the per-server detail.
 */

/** Metadata + aggregates for a single Discord channel. */
interface DiscordChannelMeta {
  conversationId: string;
  sourceAccount: string | null;
  /** Representative (latest) message id — used to deep-link the conversation. */
  lastEventId: number;
  /** Current channel title, e.g. "Guild #general" or a thread name. */
  title: string;
  guildId: string | null;
  guildName: string | null;
  channelName: string | null;
  category: string | null;
  /** Discord channel type, e.g. "GuildTextChat", "GuildPublicThread". */
  channelType: string | null;
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
}

export interface DiscordServerSummary {
  guildId: string;
  name: string;
  /** Discord CDN URL for the guild icon, or null when the guild has no icon. */
  iconUrl: string | null;
  channelCount: number;
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
}

export interface DiscordServerChannel {
  conversationId: string;
  /** Channel name (without the guild prefix), for display in the channel list. */
  name: string;
  /** Full conversation title. */
  title: string;
  lastEventId: number;
  isThread: boolean;
  messageCount: number;
  lastMessage: string | null;
}

export interface DiscordServerCategory {
  /** Category name, or null for channels with no category. */
  name: string | null;
  channels: DiscordServerChannel[];
  messageCount: number;
}

export interface DiscordServerParticipant {
  identifier: string;
  name: string;
  contactId: number | null;
  avatarUrl: string | null;
  count: number;
}

export interface DiscordServerEmoji {
  emojiId: string;
  name: string;
  animated: boolean;
  imageUrl: string;
}

export interface DiscordServerEmojiUploader {
  uploaderId: string | null;
  identifier: string | null;
  name: string;
  contactId: number | null;
  avatarUrl: string | null;
  count: number;
  emojis: DiscordServerEmoji[];
}

export interface DiscordServerDetail {
  guildId: string;
  name: string;
  /** Discord CDN URL for the guild icon, or null when the guild has no icon. */
  iconUrl: string | null;
  channelCount: number;
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
  categories: DiscordServerCategory[];
  participants: DiscordServerParticipant[];
  activityByMonth: { month: string; count: number }[];
  emojiCount: number;
  emojiUploaders: DiscordServerEmojiUploader[];
}

interface ChannelMetaRow {
  conversationId: string;
  sourceAccount: string | null;
  lastEventId: number;
  title: string;
  guildId: string | null;
  guildName: string | null;
  channelName: string | null;
  category: string | null;
  channelType: string | null;
  messageCount: number;
  firstMessage: string | null;
  lastMessage: string | null;
}

interface DiscordChannelScope {
  clause: string;
  params: string[];
}

/**
 * Scope an events query to the exact account/channel pairs represented by a
 * guild. Including source_account lets SQLite use idx_events_conversation_id,
 * whose leading columns are source, source_account, and conversation_id.
 */
function buildDiscordChannelScope(
  channels: DiscordChannelMeta[],
  alias: string,
): DiscordChannelScope {
  const channelIdsByAccount = new Map<string | null, string[]>();
  for (const channel of channels) {
    const channelIds = channelIdsByAccount.get(channel.sourceAccount);
    if (channelIds) channelIds.push(channel.conversationId);
    else channelIdsByAccount.set(channel.sourceAccount, [channel.conversationId]);
  }

  const conditions: string[] = [];
  const params: string[] = [];
  for (const [sourceAccount, channelIds] of channelIdsByAccount) {
    const accountClause = sourceAccount === null
      ? `${alias}source_account IS NULL`
      : `${alias}source_account = ?`;
    if (sourceAccount !== null) params.push(sourceAccount);
    conditions.push(
      `(${accountClause} AND ${alias}conversation_id IN (${channelIds.map(() => "?").join(", ")}))`,
    );
    params.push(...channelIds);
  }

  if (conditions.length === 0) {
    throw new Error("Cannot build a Discord channel scope without channels");
  }
  return { clause: `(${conditions.join(" OR ")})`, params };
}

/**
 * One metadata row per Discord channel. Per-channel aggregates and the latest
 * titled event id come from `conversation_summaries`; guild/channel names come
 * from that event's `raw_data._channel` so renamed channels show their current
 * name.
 */
async function getDiscordChannelMeta(db: QueryExecutor): Promise<DiscordChannelMeta[]> {
  const rows = await db.query<ChannelMetaRow>(`
    SELECT
      cs.conversation_id AS conversationId,
      cs.source_account AS sourceAccount,
      cs.message_count AS messageCount,
      cs.first_message AS firstMessage,
      cs.last_message AS lastMessage,
      e.id AS lastEventId,
      e.title AS title,
      json_extract(e.raw_data, '$._channel.guild_id') AS guildId,
      json_extract(e.raw_data, '$._channel.guild_name') AS guildName,
      json_extract(e.raw_data, '$._channel.name') AS channelName,
      json_extract(e.raw_data, '$._channel.category') AS category,
      json_extract(e.raw_data, '$._channel.type') AS channelType
    FROM conversation_summaries cs
    JOIN events e ON e.id = cs.latest_title_event_id
    WHERE cs.source = 'discord'
  `);

  return rows.map((r) => ({
    conversationId: r.conversationId,
    sourceAccount: r.sourceAccount,
    lastEventId: r.lastEventId,
    title: r.title,
    guildId: r.guildId,
    guildName: r.guildName,
    channelName: r.channelName,
    category: r.category,
    channelType: r.channelType,
    messageCount: r.messageCount,
    firstMessage: r.firstMessage,
    lastMessage: r.lastMessage,
  }));
}

/** Pick the most descriptive guild name — the one from the most recently active channel. */
function latestGuildName(channels: DiscordChannelMeta[]): string {
  let best: DiscordChannelMeta | undefined;
  for (const c of channels) {
    if (!c.guildName) continue;
    if (!best || (c.lastMessage ?? "") > (best.lastMessage ?? "")) best = c;
  }
  return best?.guildName ?? channels[0]?.guildName ?? "Unknown server";
}

function minDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function maxDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** Map of guild_id -> icon hash, for guilds that have an icon set. */
async function getGuildIconMap(db: QueryExecutor): Promise<Map<string, string>> {
  const rows = await db.query<{ guildId: string; icon: string }>(
    `SELECT guild_id AS guildId, icon FROM discord_guilds WHERE icon IS NOT NULL`,
  );
  return new Map(rows.map((r) => [r.guildId, r.icon]));
}

/** Discord CDN URL for a guild's icon, or null when the guild has no icon. */
export function guildIconUrl(guildId: string, iconHash: string | undefined): string | null {
  // ?size=128 matches the avatar URLs built in src/platforms/discord/parser.ts; it caps the
  // download at 128px instead of the full-res default for an avatar rendered at
  // ~36-40px (with retina headroom).
  return iconHash ? `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.png?size=128` : null;
}

/**
 * List Discord servers (guilds) with channel/message counts and activity span.
 * DM and group-DM channels (no guild) are excluded.
 */
export async function listDiscordServers(db: QueryExecutor): Promise<DiscordServerSummary[]> {
  const channels = await getDiscordChannelMeta(db);
  const iconMap = await getGuildIconMap(db);

  const byGuild = new Map<string, DiscordChannelMeta[]>();
  for (const c of channels) {
    if (!c.guildId) continue; // DMs / group DMs
    const existing = byGuild.get(c.guildId);
    if (existing) existing.push(c);
    else byGuild.set(c.guildId, [c]);
  }

  const servers: DiscordServerSummary[] = [];
  for (const [guildId, guildChannels] of byGuild) {
    let messageCount = 0;
    let firstMessage: string | null = null;
    let lastMessage: string | null = null;
    for (const c of guildChannels) {
      messageCount += c.messageCount;
      firstMessage = minDate(firstMessage, c.firstMessage);
      lastMessage = maxDate(lastMessage, c.lastMessage);
    }
    servers.push({
      guildId,
      name: latestGuildName(guildChannels),
      iconUrl: guildIconUrl(guildId, iconMap.get(guildId)),
      channelCount: guildChannels.length,
      messageCount,
      firstMessage,
      lastMessage,
    });
  }

  servers.sort((a, b) => b.messageCount - a.messageCount);
  return servers;
}

function channelDisplayName(c: DiscordChannelMeta): string {
  if (c.channelName) return c.channelName;
  // Fall back to the part of the title after the guild prefix ("Guild #chan").
  const hashIdx = c.title.indexOf(" #");
  if (hashIdx >= 0) return c.title.slice(hashIdx + 2);
  return c.title;
}

/**
 * Normalise a channel's category to a non-empty name or null. The API sync
 * path stores real category names (or null when uncategorised, via
 * event-converter's `|| null`), but the file-parser path (src/platforms/discord/parser.ts)
 * passes `_channel.category` through verbatim and can yield an empty string —
 * collapse those (and whitespace) to null so the UI never renders a blank
 * category header.
 */
function normalizeCategory(category: string | null): string | null {
  const trimmed = category?.trim();
  return trimmed ? trimmed : null;
}

interface DiscordGuildEmojiRow {
  emojiId: string;
  name: string;
  animated: number;
  uploaderId: string | null;
  uploaderUsername: string | null;
  uploaderDisplayName: string | null;
  uploaderAvatarUrl: string | null;
}

function guildEmojiImageUrl(emojiId: string, animated: boolean): string {
  return `/api/discord/emoji/${emojiId}.${animated ? "gif" : "png"}`;
}

function newUploaderGroup(
  row: DiscordGuildEmojiRow,
  identifier: string | null,
  identity: ResolvedIdentity | undefined,
): DiscordServerEmojiUploader {
  return {
    uploaderId: row.uploaderId,
    identifier,
    name:
      identity?.name ||
      identity?.username ||
      row.uploaderDisplayName ||
      row.uploaderUsername ||
      "Unknown uploader",
    contactId: identity?.contactId ?? null,
    avatarUrl: identity?.avatarUrl || row.uploaderAvatarUrl,
    count: 0,
    emojis: [],
  };
}

async function getGuildEmojiUploaders(
  db: QueryExecutor,
  guildId: string,
): Promise<{ uploaders: DiscordServerEmojiUploader[]; total: number }> {
  const rows = await db.query<DiscordGuildEmojiRow>(
    `SELECT
       emoji_id AS emojiId,
       name,
       animated,
       uploader_id AS uploaderId,
       uploader_username AS uploaderUsername,
       uploader_display_name AS uploaderDisplayName,
       uploader_avatar_url AS uploaderAvatarUrl
     FROM discord_guild_emojis
     WHERE guild_id = ? AND deleted_at IS NULL
     ORDER BY name COLLATE NOCASE`,
    guildId,
  );
  if (rows.length === 0) return { uploaders: [], total: 0 };

  const identifiers = [
    ...new Set(
      rows
        .map((r) => (r.uploaderId ? formatIdentifier("discord", r.uploaderId) : null))
        .filter((id): id is string => id !== null),
    ),
  ];
  const resolved = await resolveIdentities(db, identifiers);
  const groups = new Map<string, DiscordServerEmojiUploader>();

  for (const row of rows) {
    const identifier = row.uploaderId ? formatIdentifier("discord", row.uploaderId) : null;
    // A hidden contact's uploads are dropped from the attribution list; the
    // emojis themselves still count towards `total` (rows.length).
    if (identifier && resolved[identifier]?.hidden) continue;
    const contactId = identifier ? resolved[identifier]?.contactId : null;
    const key = contactId ? `contact:${contactId}` : (identifier ?? "unknown");
    let group = groups.get(key);
    if (!group) {
      group = newUploaderGroup(row, identifier, identifier ? resolved[identifier] : undefined);
      groups.set(key, group);
    }

    const animated = row.animated === 1;
    group.emojis.push({
      emojiId: row.emojiId,
      name: row.name,
      animated,
      imageUrl: guildEmojiImageUrl(row.emojiId, animated),
    });
    group.count = group.emojis.length;
  }

  const uploaders = [...groups.values()];
  for (const uploader of uploaders) {
    uploader.emojis.sort((a, b) => a.name.localeCompare(b.name));
  }
  uploaders.sort((a, b) => {
    if (a.uploaderId === null && b.uploaderId !== null) return 1;
    if (a.uploaderId !== null && b.uploaderId === null) return -1;
    return b.count - a.count || a.name.localeCompare(b.name);
  });
  return { uploaders, total: rows.length };
}

/**
 * Build the participant leaderboard from per-identity sender counts.
 * Identities linked to the same contact (e.g. two Discord accounts) merge
 * into one row, represented by their most active identity.
 */
function buildParticipants(
  senderRows: { person: string; count: number }[],
  resolved: Record<string, ResolvedIdentity>,
): DiscordServerParticipant[] {
  const participantMap = new Map<string, DiscordServerParticipant>();
  for (const r of senderRows) {
    const identity = resolved[r.person];
    const contactId = identity?.contactId ?? null;
    const key = contactId !== null ? `contact:${contactId}` : r.person;
    const existing = participantMap.get(key);
    if (existing) {
      existing.count += r.count;
      existing.avatarUrl ??= identity?.avatarUrl ?? null;
      continue;
    }
    let name = identity?.name || identity?.username;
    if (!name) {
      const parsed = parseIdentifier(r.person);
      if (parsed?.platformId?.startsWith("name:")) name = parsed.platformId.slice("name:".length);
      else name = parsed?.platformId || r.person;
    }
    participantMap.set(key, {
      identifier: r.person,
      name,
      contactId,
      avatarUrl: identity?.avatarUrl ?? null,
      count: r.count,
    });
  }
  return [...participantMap.values()].sort((a, b) => b.count - a.count);
}

/**
 * Detailed view of one Discord server: channels grouped by category, the
 * top participants (by messages sent), and monthly activity. Returns null when
 * no synced channels belong to the guild.
 */
export async function getDiscordServer(
  db: QueryExecutor,
  guildId: string,
): Promise<DiscordServerDetail | null> {
  const allChannels = await getDiscordChannelMeta(db);
  const channels = allChannels.filter((c) => c.guildId === guildId);
  if (channels.length === 0) return null;

  const iconMap = await getGuildIconMap(db);

  let messageCount = 0;
  let firstMessage: string | null = null;
  let lastMessage: string | null = null;
  for (const c of channels) {
    messageCount += c.messageCount;
    firstMessage = minDate(firstMessage, c.firstMessage);
    lastMessage = maxDate(lastMessage, c.lastMessage);
  }

  // Group channels by category, ordered by total messages (channels and
  // categories alike) — we don't have Discord's channel ordering, so activity
  // is the most useful proxy.
  const categoryMap = new Map<string, DiscordServerCategory>();
  for (const c of channels) {
    const category = normalizeCategory(c.category);
    const key = category ?? " "; // sentinel for "no category"
    let cat = categoryMap.get(key);
    if (!cat) {
      cat = { name: category, channels: [], messageCount: 0 };
      categoryMap.set(key, cat);
    }
    cat.channels.push({
      conversationId: c.conversationId,
      name: channelDisplayName(c),
      title: c.title,
      lastEventId: c.lastEventId,
      isThread: c.channelType?.includes("Thread") ?? false,
      messageCount: c.messageCount,
      lastMessage: c.lastMessage,
    });
    cat.messageCount += c.messageCount;
  }
  const categories = [...categoryMap.values()];
  for (const cat of categories) {
    cat.channels.sort((a, b) => b.messageCount - a.messageCount);
  }
  categories.sort((a, b) => b.messageCount - a.messageCount);

  const channelScope = buildDiscordChannelScope(channels, "e.");

  // Participant leaderboard: count messages where the person is the sender
  // (event_people.is_sender = 1) across this guild's channels. Resolve names
  // separately — joining identities by a computed `'discord:' || platform_id`
  // expression can't use an index and is pathologically slow.
  // Hidden contacts are excluded in SQL, before the LIMIT, so they don't
  // occupy leaderboard slots that visible senders should fill.
  const senderRows = await db.query<{ person: string; count: number }>(
    `SELECT ep.person AS person, COUNT(*) AS count
     FROM events e
     JOIN event_people ep ON ep.event_id = e.id AND ep.is_sender = 1
     WHERE e.source = 'discord'
       AND e.conversation_id IS NOT NULL
       AND ${conversationTypeClause("e.")}
       AND ${channelScope.clause}
       AND ep.person NOT IN (
         SELECT i.platform || ':' || i.platform_id
         FROM identities i
         JOIN contacts c ON c.id = i.contact_id AND c.hidden = 1
       )
     GROUP BY ep.person
     ORDER BY count DESC
     LIMIT 100`,
    ...channelScope.params,
  );

  const resolved = await resolveIdentities(db, senderRows.map((r) => r.person));
  const participants = buildParticipants(senderRows, resolved);

  const activityByMonth = fillMonthGaps(await db.query<{ month: string; count: number }>(
    `SELECT strftime('%Y-%m', e.timestamp) AS month, COUNT(*) AS count
     FROM events e
     WHERE e.source = 'discord'
       AND e.conversation_id IS NOT NULL
       AND ${conversationTypeClause("e.")}
       AND e.timestamp IS NOT NULL
       AND ${channelScope.clause}
     GROUP BY month
     ORDER BY month`,
    ...channelScope.params,
  ));

  const { uploaders: emojiUploaders, total: emojiCount } = await getGuildEmojiUploaders(db, guildId);

  return {
    guildId,
    name: latestGuildName(channels),
    iconUrl: guildIconUrl(guildId, iconMap.get(guildId)),
    channelCount: channels.length,
    messageCount,
    firstMessage,
    lastMessage,
    categories,
    participants,
    activityByMonth,
    emojiCount,
    emojiUploaders,
  };
}
