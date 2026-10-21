export {
  DiscordClient,
  snowflakeToDate,
  dateToSnowflake,
  decrementSnowflake,
  incrementSnowflake,
  getChannelTypeName,
  isThreadType,
  CHANNEL_TYPE,
  THREAD_CHANNEL_TYPES,
  type DiscordUser,
  type DiscordAttachment,
  type DiscordEmbed,
  type DiscordReaction,
  type DiscordGuildEmoji,
  type DiscordMessage,
  type DiscordThread,
  type DiscordChannel,
  type DiscordChannelRecipient,
  type NormalizedMessage,
  type NormalizedReaction,
  type ReactionUser,
} from "./client";

export {
  groupIntoSessions,
  fetchSessionContext,
  type Session,
  type SessionContextOptions,
} from "./sparse";

export {
  convertMessage,
  buildChannelContext,
  type ChannelContext,
  type ConvertedEvent,
} from "./event-converter";

export { downloadAndStoreAttachments } from "./attachment-downloader";

export { extractEmojiRefs, type EmojiRef } from "./emoji-extractor";

export {
  upsertEmojiRefs,
  downloadPendingEmojis,
  downloadEmoji,
  fetchEmojiOnDemand,
  type DownloadResult as EmojiDownloadResult,
} from "./emoji-downloader";
