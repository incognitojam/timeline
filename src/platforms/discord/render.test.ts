import { describe, expect, test } from "bun:test";
import { renderDiscordEvent } from "./render";

const legacyRawData = {
  id: "message-1",
  type: 0,
  content: "",
  author: {
    id: "alice",
    name: "Alice",
    nickname: "Alice",
  },
  timestamp: "2025-01-01T00:00:00.000Z",
  timestampEdited: null,
  mentions: [],
  attachments: [],
  embeds: [],
  reactions: [],
  _channel: { id: "channel-1", name: "general", type: "GuildTextChat" },
};

const legacyPollResultRawData = {
  ...legacyRawData,
  embeds: [{ type: "poll_result" }],
};

describe("renderDiscordEvent", () => {
  test("renders a guild channel with its guild name from sync raw_data", () => {
    expect(renderDiscordEvent({
      content: "Hello",
      edited_timestamp: null,
      _channel: {
        id: "channel-1",
        name: "general",
        type: "GuildTextChat",
        guild_id: "guild-1",
        guild_name: "Example Server",
        category: null,
        recipients: [],
      },
    })).toEqual({ title: "Example Server #general", content: "Hello" });
  });

  test("renders a guild channel without a guild name from legacy parser raw_data", () => {
    expect(renderDiscordEvent({
      ...legacyRawData,
      content: "Hello",
      _channel: {
        id: "channel-1",
        name: "general",
        type: "GuildTextChat",
        guild_id: "guild-1",
        guild_name: null,
        category: null,
        recipients: [],
      },
    })).toEqual({ title: "general", content: "Hello" });
  });

  test("renders DM and group channel titles", () => {
    expect(renderDiscordEvent({
      content: "Hi Alice",
      edited_timestamp: null,
      _channel: { id: "dm-1", name: "Alice", type: "DirectMessage" },
    })).toEqual({ title: "Alice", content: "Hi Alice" });
    expect(renderDiscordEvent({
      content: "Hi everyone",
      edited_timestamp: null,
      _channel: { id: "group-1", name: "Alice, Bob", type: "GroupDirectMessage" },
    })).toEqual({ title: "Alice, Bob", content: "Hi everyone" });
  });

  test("uses a poll question when message content is empty", () => {
    expect(renderDiscordEvent({
      content: "",
      edited_timestamp: null,
      poll: { question: { text: "Tea or coffee?" } },
      _channel: { id: "channel-1", name: "general", type: "GuildTextChat" },
    })).toEqual({ title: "general", content: "Tea or coffee?" });
  });

  test("uses forwarded snapshot text when wrapper content is empty", () => {
    expect(renderDiscordEvent({
      content: "",
      edited_timestamp: null,
      message_snapshots: [{ message: { content: "Forwarded body" } }],
      _channel: { id: "channel-1", name: "general", type: "GuildTextChat" },
    })).toEqual({ title: "general", content: "Forwarded body" });
  });

  test("preserves empty legacy message content", () => {
    expect(renderDiscordEvent(legacyRawData)).toEqual({ title: "general", content: "" });
  });

  test("does not use a fallback for legacy poll result embeds", () => {
    expect(renderDiscordEvent(legacyPollResultRawData)).toEqual({
      title: "general",
      content: "",
    });
  });
});
