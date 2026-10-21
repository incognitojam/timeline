/**
 * Discord Event Converter
 *
 * Maps NormalizedMessage + channel context to Timeline events.
 * Reuses the same logic from src/platforms/discord/parser.ts for compatibility.
 */

import type { UpsertIdentityOptions } from "../../db/identities";
import { formatIdentifier } from "../../db/identities";
import { getRenderer } from "../../render";
import {
  getDiscordSnapshotAttachments,
  getDiscordStickerItems,
} from "../../shared/discord-forward";
import {
  CHANNEL_TYPE,
  type DiscordChannel,
  type DiscordChannelRecipient,
  getChannelTypeName,
  type NormalizedMessage,
} from "./client";

// Message flag bits. See:
// https://docs.discord.com/developers/resources/message#message-object-message-flags
const FLAG_HAS_SNAPSHOT = 1 << 14;

// message_reference.type values
const REFERENCE_TYPE_FORWARD = 1;

function isForwardedMessage(msg: NormalizedMessage): boolean {
  if (msg.reference?.type === REFERENCE_TYPE_FORWARD) return true;
  if (msg.flags !== undefined && (msg.flags & FLAG_HAS_SNAPSHOT) !== 0) return true;
  return false;
}

export function getDiscordMessageEventType(
  msg: NormalizedMessage,
  baseType: "message:dm" | "message:group" | "message:guild",
): string {
  if (isForwardedMessage(msg)) return `${baseType}:forward`;
  if (msg.poll) return `${baseType}:poll`;
  if (msg.attachments.length > 0) return `${baseType}:attachment`;
  if (msg.rawType === 3) return `${baseType}:call`;
  if (msg.stickerItems && msg.stickerItems.length > 0) return `${baseType}:sticker`;
  return baseType;
}

type DownloadableDiscordAsset = NormalizedMessage["attachments"][number];

interface DiscordStickerAssetInput {
  id: string;
  name: string;
  formatType: number;
}

/** Convert Discord's sticker-item metadata into its stable CDN asset. */
export function getStickerAttachment(
  sticker: DiscordStickerAssetInput,
): DownloadableDiscordAsset | null {
  const format = (() => {
    switch (sticker.formatType) {
      case 1:
      case 2:
        return { extension: "png", contentType: "image/png", host: "cdn.discordapp.com" };
      case 3:
        return { extension: "json", contentType: "application/json", host: "cdn.discordapp.com" };
      case 4:
        return { extension: "gif", contentType: "image/gif", host: "media.discordapp.net" };
      default:
        return null;
    }
  })();
  if (!format) return null;

  return {
    id: sticker.id,
    url: `https://${format.host}/stickers/${sticker.id}.${format.extension}`,
    fileName: `${sticker.name}.${format.extension}`,
    fileSizeBytes: 0,
    contentType: format.contentType,
  };
}

/** Downloadable files and stickers belonging to a message or forwarded snapshot. */
export function getMessageAttachments(msg: NormalizedMessage): NormalizedMessage["attachments"] {
  const byId = new Map(msg.attachments.map((attachment) => [attachment.id, attachment]));
  const snapshotAttachments = getDiscordSnapshotAttachments({
    message_snapshots: msg.snapshots,
  });
  for (const attachment of snapshotAttachments) {
    if (byId.has(attachment.id)) continue;
    byId.set(attachment.id, {
      id: attachment.id,
      url: attachment.url,
      fileName: attachment.filename,
      fileSizeBytes: attachment.size,
      contentType: attachment.content_type,
      width: attachment.width,
      height: attachment.height,
    });
  }

  const stickers = [
    ...(msg.stickerItems ?? []),
    ...getDiscordStickerItems({ message_snapshots: msg.snapshots })
      .filter((sticker): sticker is { id: string; name: string; formatType: number } =>
        sticker.id !== null && sticker.name !== null && sticker.formatType !== null),
  ];
  for (const sticker of stickers) {
    if (byId.has(sticker.id)) continue;
    const attachment = getStickerAttachment(sticker);
    if (attachment) byId.set(attachment.id, attachment);
  }
  return [...byId.values()];
}

/** Channel context needed for event conversion */
export interface ChannelContext {
  id: string;
  type: number;
  name: string;
  guildId?: string;
  guildName?: string;
  category?: string;
  recipients?: DiscordChannelRecipient[];
}

/** Result of converting a single message */
export interface ConvertedEvent {
  event: {
    source: "discord";
    sourceId: string;
    sourceAccount: string;
    type: string;
    timestamp: string;
    title: string;
    content: string | null;
    people: string[];
    tags: null;
    rawData: Record<string, unknown>;
    importBatch: string;
    conversationId: string;
  };
  identities: UpsertIdentityOptions[];
}

/**
 * Source-owned message fields shared by initial conversion and later edit
 * reconciliation. Channel context is added separately because it is local
 * normalization metadata rather than part of Discord's message payload.
 */
export function buildDiscordMessageRawData(msg: NormalizedMessage): Record<string, unknown> {
  return {
    id: msg.id,
    type: msg.rawType,
    content: msg.content,
    flags: msg.flags,
    author: {
      id: msg.author.id,
      username: msg.author.name,
      global_name: msg.author.nickname,
      avatar: msg.author.avatarUrl
        ? extractAvatarHash(msg.author.id, msg.author.avatarUrl)
        : null,
      bot: msg.author.isBot || undefined,
    },
    timestamp: msg.timestamp,
    edited_timestamp: msg.timestampEdited,
    attachments: msg.attachments.map((a) => ({
      id: a.id,
      filename: a.fileName,
      size: a.fileSizeBytes,
      url: a.url,
      content_type: a.contentType,
      width: a.width,
      height: a.height,
    })),
    embeds: msg.embeds,
    reactions: msg.reactions.map((r) => ({
      emoji: r.emoji,
      count: r.count,
      users: r.users,
    })),
    mentions: msg.mentions,
    mention_roles: msg.mentionRoles,
    mention_channels: msg.mentionChannels?.map((c) => ({
      id: c.id,
      guild_id: c.guildId,
      type: c.type,
      name: c.name,
    })),
    message_reference: msg.reference
      ? {
          type: msg.reference.type,
          message_id: msg.reference.messageId,
          channel_id: msg.reference.channelId,
          guild_id: msg.reference.guildId,
        }
      : undefined,
    message_snapshots: msg.snapshots,
    referenced_message: msg.referencedMessage
      ? {
          id: msg.referencedMessage.id,
          author: {
            id: msg.referencedMessage.author.id,
            username: msg.referencedMessage.author.name,
          },
          content: msg.referencedMessage.content,
          timestamp: msg.referencedMessage.timestamp,
          attachment_count: msg.referencedMessage.attachments.length,
        }
      : undefined,
    sticker_items: msg.stickerItems?.map((s) => ({
      id: s.id,
      name: s.name,
      format_type: s.formatType,
    })),
    call: msg.call
      ? { participants: msg.call.participants, ended_timestamp: msg.call.endedTimestamp }
      : undefined,
    poll: msg.poll,
    components: msg.components,
    interaction_metadata: msg.interactionMetadata,
    webhook_id: msg.webhookId,
    application_id: msg.applicationId,
    activity: msg.activity
      ? { type: msg.activity.type, party_id: msg.activity.partyId }
      : undefined,
    thread: msg.thread
      ? {
          id: msg.thread.id,
          name: msg.thread.name,
          parent_id: msg.thread.parentId,
          type: msg.thread.type,
          guild_id: msg.thread.guildId,
          owner_id: msg.thread.ownerId,
          last_message_id: msg.thread.lastMessageId,
        }
      : undefined,
  };
}

const discordRenderer = (() => {
  const renderer = getRenderer("discord");
  if (!renderer) {
    throw new Error("Discord renderer is not registered");
  }
  return renderer;
})();

/**
 * Build a ChannelContext from a DiscordChannel and optional guild info.
 */
export function buildChannelContext(
  channel: DiscordChannel,
  guildName?: string
): ChannelContext {
  let name: string;
  if (channel.name) {
    name = channel.name;
  } else if (channel.recipients && channel.recipients.length > 0) {
    name = channel.recipients.map((r) => r.global_name || r.username).join(", ");
  } else {
    name = "(unknown)";
  }

  return {
    id: channel.id,
    type: channel.type,
    name,
    guildId: channel.guild_id,
    guildName,
    category: getCategoryForType(channel.type),
    recipients: channel.recipients,
  };
}

function getCategoryForType(type: number): string {
  if (type === CHANNEL_TYPE.DM) return "DM";
  if (type === CHANNEL_TYPE.GROUP_DM) return "Group";
  return "";
}

/**
 * Convert a NormalizedMessage to a Timeline event.
 *
 * Matches the format from src/platforms/discord/parser.ts for UI compatibility:
 * - Event type: message:dm, message:group, message:guild + subtypes
 * - Title: channel name for DMs/groups, "GuildName #channel" for guilds
 * - People: ["discord:author_id", "discord:recipient_id", ...]
 * - raw_data._channel: channel context for conversation grouping
 */
export function convertMessage(
  msg: NormalizedMessage,
  channel: ChannelContext,
  sourceAccount: string,
  importBatch: string
): ConvertedEvent {
  const isDM = channel.type === CHANNEL_TYPE.DM;
  const isGroup = channel.type === CHANNEL_TYPE.GROUP_DM;
  const isGuild = !!channel.guildId;

  // Base event type
  let eventType: "message:dm" | "message:group" | "message:guild";
  if (isDM) eventType = "message:dm";
  else if (isGroup) eventType = "message:group";
  else eventType = "message:guild";

  const specificType = getDiscordMessageEventType(msg, eventType);

  // Build people array and collect identities
  const identities: UpsertIdentityOptions[] = [];
  const people: string[] = [];

  // Author identity
  identities.push({
    platform: "discord",
    platformId: msg.author.id,
    displayName: msg.author.nickname || msg.author.name,
    username: msg.author.name,
    avatarUrl: msg.author.avatarUrl ?? undefined,
  });
  people.push(formatIdentifier("discord", msg.author.id));

  // Recipient identities (for DM/group channels)
  if (channel.recipients) {
    for (const r of channel.recipients) {
      if (r.id !== msg.author.id) {
        identities.push({
          platform: "discord",
          platformId: r.id,
          displayName: r.global_name || r.username,
          username: r.username,
        });
        people.push(formatIdentifier("discord", r.id));
      }
    }
  }

  // Build raw_data matching the existing parser format
  const rawData: Record<string, unknown> = {
    ...buildDiscordMessageRawData(msg),
    _channel: {
      id: channel.id,
      name: channel.name,
      type: getChannelTypeName(channel.type),
      guild_id: channel.guildId || null,
      guild_name: channel.guildName || null,
      category: channel.category || null,
      recipients: channel.recipients?.map((r) => ({
        id: r.id,
        username: r.username,
        name: r.global_name || r.username,
      })) ?? [],
    },
  };
  const { title, content } = discordRenderer(rawData);
  if (title === null) {
    throw new Error("Discord message raw data is missing _channel.name");
  }

  return {
    event: {
      source: "discord",
      sourceId: msg.id,
      sourceAccount,
      type: specificType,
      timestamp: msg.timestamp,
      title,
      content,
      people,
      tags: null,
      rawData,
      importBatch,
      conversationId: channel.id,
    },
    identities,
  };
}

/**
 * Extract avatar hash from CDN URL.
 * Input: "https://cdn.discordapp.com/avatars/123/abc123.png"
 * Output: "abc123"
 */
function extractAvatarHash(userId: string, avatarUrl: string): string | null {
  const prefix = `https://cdn.discordapp.com/avatars/${userId}/`;
  if (!avatarUrl.startsWith(prefix)) return null;
  const rest = avatarUrl.slice(prefix.length);
  const dotIndex = rest.indexOf(".");
  return dotIndex >= 0 ? rest.slice(0, dotIndex) : rest;
}
