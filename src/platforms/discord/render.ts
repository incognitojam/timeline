import type { EventRenderer } from "../../render/types";
import { getDiscordForwardedText } from "../../shared/discord-forward";

export interface DiscordConversationTitleChannel {
  name: string;
  guildId?: string | null;
  guildName?: string | null;
}

export function formatDiscordConversationTitle(channel: DiscordConversationTitleChannel): string {
  if (channel.guildId) {
    return channel.guildName ? `${channel.guildName} #${channel.name}` : channel.name;
  }
  return channel.name;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export const renderDiscordEvent: EventRenderer = (rawData) => {
  const channel = getRecord(rawData._channel);
  const channelName = getString(channel?.name);
  const title = channelName
    ? formatDiscordConversationTitle({
        name: channelName,
        guildId: getString(channel?.guild_id),
        guildName: getString(channel?.guild_name),
      })
    : null;
  const poll = getRecord(rawData.poll);
  const question = getRecord(poll?.question);
  const content = getString(rawData.content);
  // convertMessage always snapshots sync messages with edited_timestamp,
  // including when it is null (event-converter.ts). importDiscordDMs
  // instead copies the discord-chat archiver's camelCase normalized message
  // JSON and adds _channel (parser.ts); that schema has
  // timestampEdited and never edited_timestamp.
  const isSyncRawData = "edited_timestamp" in rawData;

  return {
    title,
    content: isSyncRawData
      ? content || getDiscordForwardedText(rawData) || getString(question?.text)
      : content,
  };
};
