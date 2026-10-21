import { Database } from "bun:sqlite";
import { getDb, initDb } from "../../db/schema";
import {
  onImportComplete,
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../../db/queries";
import { getRenderer } from "../../render";

// Default paths - can be overridden with env vars
export const DEFAULT_DISCORD_DB = `${process.env.HOME}/.local/share/discord-chat/personal.db`;

/**
 * Detect the account owner's username from a discord-chat database.
 * Uses the heuristic that the account owner appears in ALL DM channels,
 * while other users only appear in their own conversation.
 */
export function detectAccountName(discordDbPath: string): string | null {
  const discordDb = new Database(discordDbPath, { readonly: true });

  try {
    const result = discordDb
      .query<{ author_name: string }, []>(
        `
        SELECT author_name
        FROM messages m
        JOIN channels c ON m.channel_id = c.id
        WHERE c.type = 'DirectMessage'
        GROUP BY author_id
        ORDER BY COUNT(DISTINCT channel_id) DESC
        LIMIT 1
        `
      )
      .get();

    return result?.author_name || null;
  } finally {
    discordDb.close();
  }
}

interface DiscordChannel {
  id: string;
  name: string;
  type: string;
  guild_id: string | null;
  guild_name: string | null;
  recipients: string | null; // JSON array
  category: string | null;
}

interface EligibleGuild {
  id: string;
  name: string;
  author_count: number;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string | null;
  author_id: string;
  author_name: string;
  author_nickname: string | null;
  timestamp: string;
  data: string; // Full JSON
}

interface Recipient {
  id: string;       // Discord snowflake ID
  username: string; // Discord username (e.g., "alice123")
  name: string;     // Display name / nickname
}

type DiscordRawData = Record<string, unknown>;

const discordRenderer = (() => {
  const renderer = getRenderer("discord");
  if (!renderer) {
    throw new Error("Discord renderer is not registered");
  }
  return renderer;
})();

function getRawObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getRawString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasRawArrayItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

export interface DiscordImportStats {
  dmChannels: number;
  groupChannels: number;
  guildChannels: number;
  messages: number;
  skipped: number;
  identitiesUpserted: number;
}

/**
 * Build people array with platform identifiers and collect identities to upsert.
 * Returns both the people array (for the event) and identities to batch upsert.
 */
function buildPeopleAndIdentities(
  msg: DiscordMessage,
  recipients: Recipient[],
  rawData: DiscordRawData
): { people: string[]; identities: UpsertIdentityOptions[] } {
  const identities: UpsertIdentityOptions[] = [];
  const rawAuthor = getRawObject(rawData.author);

  // Extract author info - prefer data from raw JSON if available
  const authorId = getRawString(rawAuthor?.id) || msg.author_id;
  const authorUsername = getRawString(rawAuthor?.username) || msg.author_name;
  const authorDisplayName = msg.author_nickname || getRawString(rawAuthor?.global_name) || msg.author_name;

  // Construct Discord CDN avatar URL from author's avatar hash
  const authorAvatarHash = getRawString(rawAuthor?.avatar);
  const authorAvatarUrl = authorAvatarHash && authorId
    ? `https://cdn.discordapp.com/avatars/${authorId}/${authorAvatarHash}.png?size=128`
    : undefined;

  // Add author identity
  identities.push({
    platform: "discord",
    platformId: authorId,
    displayName: authorDisplayName,
    username: authorUsername,
    avatarUrl: authorAvatarUrl,
  });

  // Build people array starting with author
  const people: string[] = [formatIdentifier("discord", authorId)];

  // Add recipient identities
  for (const r of recipients) {
    if (r.id && r.id !== authorId) {
      identities.push({
        platform: "discord",
        platformId: r.id,
        displayName: r.name || r.username,
        username: r.username,
      });
      people.push(formatIdentifier("discord", r.id));
    }
  }

  return { people, identities };
}

export interface DiscordImportOptions {
  /** Only fetch messages after this timestamp (ISO string) for known channels */
  sinceTimestamp?: string;
  /** Channel IDs that have been previously synced (will use timestamp filter) */
  knownChannelIds?: Set<string>;
  /** Cached eligible guild IDs (skip expensive author count query) */
  eligibleGuildIds?: Set<string>;
}

export interface DiscordImportResult {
  stats: DiscordImportStats;
  /** Latest timestamp seen across all messages (for cursor update) */
  maxTimestamp: string | null;
  /** All channel IDs that were processed */
  channelIds: string[];
  /** Eligible guild IDs (for caching) */
  eligibleGuildIds: string[];
}

export async function importDiscordDMs(
  db: Database,
  discordDbPath: string,
  sourceAccount: string,
  options?: DiscordImportOptions
): Promise<DiscordImportResult> {
  const importBatch = `discord-${sourceAccount}-${Date.now()}`;
  const { sinceTimestamp, knownChannelIds, eligibleGuildIds: cachedEligibleGuildIds } = options || {};

  // Open discord DB readonly
  const discordDb = new Database(discordDbPath, { readonly: true });

  const stats: DiscordImportStats = {
    dmChannels: 0,
    groupChannels: 0,
    guildChannels: 0,
    messages: 0,
    skipped: 0,
    identitiesUpserted: 0,
  };

  // Collect all identities for batch upsert
  const allIdentities: UpsertIdentityOptions[] = [];
  let maxTimestamp: string | null = null;
  const processedChannelIds: string[] = [];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, tags, raw_data, import_batch, conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Find eligible guilds: non-sparse with <50 unique authors (friend servers)
  // Use cached guild IDs if available to skip expensive query
  let eligibleGuildIds: Set<string>;
  if (cachedEligibleGuildIds && cachedEligibleGuildIds.size > 0) {
    eligibleGuildIds = cachedEligibleGuildIds;
    console.log(`Using ${eligibleGuildIds.size} cached eligible guilds`);
  } else {
    const eligibleGuilds = discordDb
      .query<EligibleGuild, []>(
        `
      SELECT g.id, g.name, COUNT(DISTINCT m.author_id) as author_count
      FROM guilds g
      JOIN channels c ON c.guild_id = g.id
      JOIN messages m ON m.channel_id = c.id
      WHERE g.sparse = 0 OR g.sparse IS NULL
      GROUP BY g.id
      HAVING author_count < 50
    `
      )
      .all();

    eligibleGuildIds = new Set(eligibleGuilds.map((g) => g.id));
    console.log(
      `Found ${eligibleGuilds.length} eligible guilds (<50 authors):`,
      eligibleGuilds.map((g) => `${g.name} (${g.author_count})`).join(", ")
    );
  }

  // Get DM, group, and eligible guild channels
  const channels = discordDb
    .query<DiscordChannel, []>(
      `
    SELECT id, name, type, guild_id, guild_name, recipients, category
    FROM channels
    WHERE type IN ('DirectMessage', 'GroupDirectMessage', 'GuildTextChat', 'GuildPublicThread', 'GuildAnnouncement', 'GuildForum')
  `
    )
    .all()
    .filter(
      (c) => !c.guild_id || eligibleGuildIds.has(c.guild_id)
    );

  console.log(`Found ${channels.length} channels to import`);

  // Build channel lookup for fast access
  const channelMap = new Map(channels.map((c) => [c.id, c]));

  // Check if all channels are known (pure incremental sync)
  const newChannels = channels.filter((c) => !knownChannelIds?.has(c.id));
  const allChannelsKnown =
    sinceTimestamp && knownChannelIds && newChannels.length === 0;

  if (allChannelsKnown) {
    // Fast path: single query for all new messages across all channels
    console.log(`Incremental mode: querying all messages since ${sinceTimestamp}`);

    // Build query with inline channel IDs
    const channelIdsSql = channels.map((c) => `'${c.id}'`).join(",");
    const allMessages = discordDb
      .query<DiscordMessage, [string]>(
        `
      SELECT id, channel_id, content, author_id, author_name, author_nickname, timestamp, data
      FROM messages
      WHERE channel_id IN (${channelIdsSql}) AND timestamp > ?
      ORDER BY channel_id, timestamp
    `
      )
      .all(sinceTimestamp);

    console.log(`Found ${allMessages.length} new messages across all channels`);

    // Group messages by channel
    const messagesByChannel = new Map<string, DiscordMessage[]>();
    for (const msg of allMessages) {
      const channelMsgs = messagesByChannel.get(msg.channel_id) || [];
      channelMsgs.push(msg);
      messagesByChannel.set(msg.channel_id, channelMsgs);
    }

    // Process each channel that has new messages
    for (const [channelId, messages] of messagesByChannel) {
      const channel = channelMap.get(channelId);
      if (!channel) continue;

      processedChannelIds.push(channelId);

      const isDM = channel.type === "DirectMessage";
      const isGroup = channel.type === "GroupDirectMessage";
      const isGuild = !!channel.guild_id;

      let eventType: string;
      if (isDM) {
        eventType = "message:dm";
        stats.dmChannels++;
      } else if (isGroup) {
        eventType = "message:group";
        stats.groupChannels++;
      } else {
        eventType = "message:guild";
        stats.guildChannels++;
      }

      // Parse recipients
      let recipients: Recipient[] = [];
      try {
        recipients = JSON.parse(channel.recipients || "[]");
      } catch {}

      for (const msg of messages) {
        // Track max timestamp for cursor update
        if (!maxTimestamp || msg.timestamp > maxTimestamp) {
          maxTimestamp = msg.timestamp;
        }

        // Parse full message data for raw storage
        let rawData: DiscordRawData;
        try {
          rawData = getRawObject(JSON.parse(msg.data)) ?? { content: msg.content };
        } catch {
          rawData = { content: msg.content };
        }

        // Build people array with platform identifiers and collect identities
        const { people, identities } = buildPeopleAndIdentities(msg, recipients, rawData);
        allIdentities.push(...identities);

        // Add channel context to raw data
        rawData._channel = {
          id: channel.id,
          name: channel.name,
          type: channel.type,
          guild_id: channel.guild_id,
          guild_name: channel.guild_name,
          category: channel.category,
          recipients,
        };

        // Determine more specific type based on content
        let specificType = eventType;
        const { title, content } = discordRenderer(rawData);

        // Check for attachments, calls, etc in raw data
        if (hasRawArrayItems(rawData.attachments)) {
          specificType = `${eventType}:attachment`;
        } else if (rawData.type === 3) {
          specificType = `${eventType}:call`;
        } else if (hasRawArrayItems(rawData.sticker_items)) {
          specificType = `${eventType}:sticker`;
        }

        const result = insert.run(
          "discord",
          msg.id,
          sourceAccount,
          specificType,
          msg.timestamp,
          title,
          content,
          JSON.stringify(people),
          null,
          JSON.stringify(rawData),
          importBatch,
          channel.id
        );
        if (result.changes > 0) {
          stats.messages++;
        } else {
          stats.skipped++;
        }
      }
    }

    // All channels are known, add any not already in processedChannelIds
    for (const c of channels) {
      if (!processedChannelIds.includes(c.id)) {
        processedChannelIds.push(c.id);
      }
    }

    // Close discord DB
    discordDb.close();

    // Batch upsert all collected identities
    if (allIdentities.length > 0) {
      // Deduplicate by platformId
      const uniqueIdentities = new Map<string, UpsertIdentityOptions>();
      for (const id of allIdentities) {
        uniqueIdentities.set(id.platformId, id);
      }
      upsertIdentities(db, [...uniqueIdentities.values()]);
      stats.identitiesUpserted = uniqueIdentities.size;
    }

    console.log(`\n${"=".repeat(50)}`);
    console.log("Import complete (incremental mode):");
    console.log(`  DM channels: ${stats.dmChannels}`);
    console.log(`  Group channels: ${stats.groupChannels}`);
    console.log(`  Guild channels: ${stats.guildChannels}`);
    console.log(`  Messages: ${stats.messages.toLocaleString()}`);
    console.log(`  Identities: ${stats.identitiesUpserted}`);
    console.log(`  Skipped: ${stats.skipped}`);
    console.log(`  Batch ID: ${importBatch}`);

    // Only call onImportComplete if we actually imported something
    if (stats.messages > 0) {
      onImportComplete(db);
    }

    return {
      stats,
      maxTimestamp,
      channelIds: processedChannelIds,
      eligibleGuildIds: [...eligibleGuildIds],
    };
  }

  // Slow path: per-channel queries (for initial sync or when new channels exist)
  if (newChannels.length > 0) {
    console.log(`Found ${newChannels.length} new channels to backfill`);
  }

  for (const channel of channels) {
    const isDM = channel.type === "DirectMessage";
    const isGroup = channel.type === "GroupDirectMessage";
    const isGuild = !!channel.guild_id;

    let eventType: string;
    if (isDM) {
      eventType = "message:dm";
      stats.dmChannels++;
    } else if (isGroup) {
      eventType = "message:group";
      stats.groupChannels++;
    } else {
      eventType = "message:guild";
      stats.guildChannels++;
    }

    // Parse recipients
    let recipients: Recipient[] = [];
    try {
      recipients = JSON.parse(channel.recipients || "[]");
    } catch {}

    // Track this channel
    processedChannelIds.push(channel.id);

    // Determine if we should filter by timestamp (only for previously synced channels)
    const isKnownChannel = knownChannelIds?.has(channel.id) ?? false;
    const useTimestampFilter = isKnownChannel && sinceTimestamp;

    // Get messages for this channel (filtered by timestamp for known channels)
    const messages = useTimestampFilter
      ? discordDb
          .query<DiscordMessage, [string, string]>(
            `
        SELECT id, channel_id, content, author_id, author_name, author_nickname, timestamp, data
        FROM messages
        WHERE channel_id = ? AND timestamp > ?
        ORDER BY timestamp
      `
          )
          .all(channel.id, sinceTimestamp)
      : discordDb
          .query<DiscordMessage, [string]>(
            `
        SELECT id, channel_id, content, author_id, author_name, author_nickname, timestamp, data
        FROM messages
        WHERE channel_id = ?
        ORDER BY timestamp
      `
          )
          .all(channel.id);

    for (const msg of messages) {
      // Track max timestamp for cursor update
      if (!maxTimestamp || msg.timestamp > maxTimestamp) {
        maxTimestamp = msg.timestamp;
      }

      // Parse full message data for raw storage
      let rawData: DiscordRawData;
      try {
        rawData = getRawObject(JSON.parse(msg.data)) ?? { content: msg.content };
      } catch {
        rawData = { content: msg.content };
      }

      // Build people array with platform identifiers and collect identities
      const { people, identities } = buildPeopleAndIdentities(msg, recipients, rawData);
      allIdentities.push(...identities);

      // Add channel context to raw data
      rawData._channel = {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        guild_id: channel.guild_id,
        guild_name: channel.guild_name,
        category: channel.category,
        recipients,
      };

      // Determine more specific type based on content
      let specificType = eventType;
      const { title, content } = discordRenderer(rawData);

      // Check for attachments, calls, etc in raw data
      if (hasRawArrayItems(rawData.attachments)) {
        specificType = `${eventType}:attachment`;
      } else if (rawData.type === 3) {
        // Discord call message type
        specificType = `${eventType}:call`;
      } else if (hasRawArrayItems(rawData.sticker_items)) {
        specificType = `${eventType}:sticker`;
      }

      const result = insert.run(
        "discord",
        msg.id, // Discord message IDs are globally unique
        sourceAccount,
        specificType,
        msg.timestamp,
        title,
        content,
        JSON.stringify(people),
        null, // tags
        JSON.stringify(rawData),
        importBatch,
        channel.id
      );
      // INSERT OR IGNORE returns 0 changes if row already exists
      if (result.changes > 0) {
        stats.messages++;
      } else {
        stats.skipped++;
      }
    }

    // Progress indicator
    const totalChannels =
      stats.dmChannels + stats.groupChannels + stats.guildChannels;
    if (totalChannels % 20 === 0) {
      console.log(
        `  Processed ${totalChannels} channels, ${stats.messages.toLocaleString()} messages...`
      );
    }
  }

  discordDb.close();

  // Batch upsert all collected identities
  if (allIdentities.length > 0) {
    // Deduplicate by platformId
    const uniqueIdentities = new Map<string, UpsertIdentityOptions>();
    for (const id of allIdentities) {
      uniqueIdentities.set(id.platformId, id);
    }
    upsertIdentities(db, [...uniqueIdentities.values()]);
    stats.identitiesUpserted = uniqueIdentities.size;
  }

  // Print summary
  console.log(`\n${"=".repeat(50)}`);
  console.log("Import complete:");
  console.log(`  DM channels: ${stats.dmChannels}`);
  console.log(`  Group channels: ${stats.groupChannels}`);
  console.log(`  Guild channels: ${stats.guildChannels}`);
  console.log(`  Messages: ${stats.messages.toLocaleString()}`);
  console.log(`  Identities: ${stats.identitiesUpserted}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Batch ID: ${importBatch}`);

  // Only call onImportComplete if we actually imported something
  if (stats.messages > 0) {
    onImportComplete(db);
  }

  return {
    stats,
    maxTimestamp,
    channelIds: processedChannelIds,
    eligibleGuildIds: [...eligibleGuildIds],
  };
}

// CLI - only run when executed directly
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1 && !process.env.DISCORD_DB_PATH) {
    console.log(
      "Usage: bun run src/platforms/discord/parser.ts <discord-db-path> [account-name]"
    );
    console.log("");
    console.log(
      "Imports DMs, group chats, and small guild servers from a discord-chat database into timeline."
    );
    console.log(
      "Guild servers with <50 unique authors are imported; larger/sparse servers are skipped."
    );
    console.log("");
    console.log("Account name is auto-detected from DM channels if not provided.");
    console.log("");
    console.log("Examples:");
    console.log(
      "  bun run src/platforms/discord/parser.ts ~/.local/share/discord-chat/personal.db"
    );
    console.log(
      "  DISCORD_DB_PATH=~/.local/share/discord-chat/work.db bun run src/platforms/discord/parser.ts"
    );
    console.log("");
    console.log(`Default discord DB: ${DEFAULT_DISCORD_DB}`);
    process.exit(1);
  }

  const discordDbPath = args[0]?.startsWith("/")
    ? args[0]
    : args[0]?.startsWith("~")
      ? args[0].replace("~", process.env.HOME || "")
      : process.env.DISCORD_DB_PATH || DEFAULT_DISCORD_DB;

  // Auto-detect account name if not provided
  let accountName: string | undefined | null = args[1];
  if (!accountName) {
    accountName = detectAccountName(discordDbPath);
    if (!accountName) {
      console.error("Could not auto-detect account name (no DM channels found)");
      console.error("Please provide account name as second argument");
      process.exit(1);
    }
    console.log(`Auto-detected account: ${accountName}`);
  }

  console.log(`Importing Discord DMs/groups from ${discordDbPath}`);
  console.log(`Account: ${accountName}\n`);

  const db = getDb();
  initDb(db);

  const result = await importDiscordDMs(db, discordDbPath, accountName);
  console.log(`Max timestamp: ${result.maxTimestamp}`);
  console.log(`Channels processed: ${result.channelIds.length}`);

  db.close();
}
