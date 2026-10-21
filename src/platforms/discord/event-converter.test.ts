import { describe, test, expect } from "bun:test";
import {
  buildChannelContext,
  convertMessage,
  getMessageAttachments,
  type ChannelContext,
} from "./event-converter";
import {
  CHANNEL_TYPE,
  normalizeMessage,
  type DiscordChannel,
  type DiscordMessage,
  type DiscordMessageSnapshot,
  type NormalizedMessage,
} from "./client";

function baseMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: "1000000000000000000",
    type: "Default",
    rawType: 0,
    timestamp: "2026-04-03T22:12:26.529Z",
    timestampEdited: null,
    content: "",
    author: {
      id: "2000000000000000000",
      name: "alice",
      nickname: "Alice",
      isBot: false,
      avatarUrl: null,
    },
    attachments: [],
    embeds: [],
    reactions: [],
    mentions: [],
    ...overrides,
  };
}

const groupChannel: ChannelContext = {
  id: "3000000000000000000",
  type: CHANNEL_TYPE.GROUP_DM,
  name: "But why?",
  recipients: [
    { id: "2000000000000000000", username: "alice", global_name: "Alice" },
    { id: "2000000000000000001", username: "bob", global_name: "Bob" },
  ],
};

describe("convertMessage", () => {
  test("forwarded message sets :forward type and preserves message_snapshots", () => {
    const snapshot: DiscordMessageSnapshot = {
      message: {
        type: 0,
        content: "Original forwarded text",
        embeds: [],
        attachments: [],
        timestamp: "2026-04-03T21:00:00.000Z",
        edited_timestamp: null,
        flags: 0,
        mentions: [],
      },
    };

    const msg = baseMessage({
      flags: 1 << 14, // HAS_SNAPSHOT
      reference: {
        type: 1, // FORWARD
        messageId: "1000000000000000002",
        channelId: "3000000000000000002",
      },
      snapshots: [snapshot],
    });

    const { event } = convertMessage(msg, groupChannel, "alice", "batch-1");

    expect(event.type).toBe("message:group:forward");
    expect(event.content).toBe("Original forwarded text");
    const raw = event.rawData as Record<string, unknown>;
    expect(raw.flags).toBe(1 << 14);
    expect(raw.message_snapshots).toEqual([snapshot]);
    const ref = raw.message_reference as { type: number; message_id: string };
    expect(ref.type).toBe(1);
    expect(ref.message_id).toBe("1000000000000000002");
  });

  test("forward detected from message_reference.type alone (no flags)", () => {
    const msg = baseMessage({
      reference: { type: 1, messageId: "x", channelId: "y" },
      snapshots: [],
    });

    const { event } = convertMessage(msg, groupChannel, "alice", "batch-1");
    expect(event.type).toBe("message:group:forward");
  });

  test("reply is not treated as forward", () => {
    const msg = baseMessage({
      content: "thanks!",
      reference: { type: 0, messageId: "x", channelId: "y" },
    });

    const { event } = convertMessage(msg, groupChannel, "alice", "batch-1");
    expect(event.type).toBe("message:group");
    const raw = event.rawData as Record<string, unknown>;
    const ref = raw.message_reference as { type: number };
    expect(ref.type).toBe(0);
    expect(raw.message_snapshots).toBeUndefined();
  });

  test("reply snapshot records the referenced message's attachment count", () => {
    const msg = baseMessage({
      content: "nice photo!",
      reference: { type: 0, messageId: "1000000000000000003", channelId: "y" },
      referencedMessage: baseMessage({
        id: "1000000000000000003",
        attachments: [{
          id: "4000000000000000000",
          url: "https://cdn.example.com/photo.png",
          fileName: "photo.png",
          fileSizeBytes: 1234,
          contentType: "image/png",
        }],
      }),
    });

    const { event } = convertMessage(msg, groupChannel, "alice", "batch-1");
    const raw = event.rawData as Record<string, unknown>;
    const referenced = raw.referenced_message as { attachment_count: number };
    expect(referenced.attachment_count).toBe(1);
  });

  test("forward takes precedence over attachment", () => {
    const msg = baseMessage({
      flags: 1 << 14,
      reference: { type: 1, messageId: "x", channelId: "y" },
      attachments: [
        {
          id: "a1",
          url: "https://cdn.discordapp.com/.../cat.png",
          fileName: "cat.png",
          fileSizeBytes: 1000,
        },
      ],
    });

    const { event } = convertMessage(msg, groupChannel, "alice", "batch-1");
    expect(event.type).toBe("message:group:forward");
  });

  test("collects forwarded snapshot attachments for download", () => {
    const msg = baseMessage({
      flags: 1 << 14,
      snapshots: [{
        message: {
          type: 0,
          content: "",
          embeds: [],
          attachments: [{
            id: "snapshot-file",
            filename: "photo.jpg",
            size: 1234,
            url: "https://cdn.discordapp.com/attachments/channel/snapshot-file/photo.jpg",
            proxy_url: "https://media.discordapp.net/attachments/channel/snapshot-file/photo.jpg",
            content_type: "image/jpeg",
            width: 800,
            height: 600,
          }],
          timestamp: "2026-04-03T21:00:00.000Z",
          edited_timestamp: null,
          mentions: [],
        },
      }],
    });

    expect(getMessageAttachments(msg)).toEqual([{
      id: "snapshot-file",
      url: "https://cdn.discordapp.com/attachments/channel/snapshot-file/photo.jpg",
      fileName: "photo.jpg",
      fileSizeBytes: 1234,
      contentType: "image/jpeg",
      width: 800,
      height: 600,
    }]);
  });

  test("converts message and forwarded stickers into downloadable assets", () => {
    const msg = baseMessage({
      stickerItems: [
        { id: "sticker-png", name: "Wave", formatType: 1 },
        { id: "sticker-lottie", name: "Sparkle", formatType: 3 },
      ],
      snapshots: [{
        message: {
          type: 0,
          content: "",
          embeds: [],
          attachments: [],
          sticker_items: [{ id: "sticker-gif", name: "Dance", format_type: 4 }],
          timestamp: "2026-04-03T21:00:00.000Z",
          edited_timestamp: null,
          mentions: [],
        },
      }],
    });

    expect(getMessageAttachments(msg)).toEqual([
      {
        id: "sticker-png",
        url: "https://cdn.discordapp.com/stickers/sticker-png.png",
        fileName: "Wave.png",
        fileSizeBytes: 0,
        contentType: "image/png",
      },
      {
        id: "sticker-lottie",
        url: "https://cdn.discordapp.com/stickers/sticker-lottie.json",
        fileName: "Sparkle.json",
        fileSizeBytes: 0,
        contentType: "application/json",
      },
      {
        id: "sticker-gif",
        url: "https://media.discordapp.net/stickers/sticker-gif.gif",
        fileName: "Dance.gif",
        fileSizeBytes: 0,
        contentType: "image/gif",
      },
    ]);
  });

  test("mention_roles and mention_channels flow through to raw_data", () => {
    const msg = baseMessage({
      content: "hi @Staff",
      mentionRoles: ["4000000000000000000"],
      mentionChannels: [
        {
          id: "5000000000000000000",
          guildId: "6000000000000000000",
          type: 0,
          name: "general",
        },
      ],
    });

    const { event } = convertMessage(msg, groupChannel, "alice", "batch-1");
    const raw = event.rawData as Record<string, unknown>;
    expect(raw.mention_roles).toEqual(["4000000000000000000"]);
    expect(raw.mention_channels).toEqual([
      {
        id: "5000000000000000000",
        guild_id: "6000000000000000000",
        type: 0,
        name: "general",
      },
    ]);
  });

  test("bot slash-command response preserves interaction_metadata and application_id", () => {
    const interactionMetadata = {
      id: "7000000000000000000",
      type: 2,
      user: { id: "2000000000000000000", username: "alice" },
    };

    const msg = baseMessage({
      content: "command result",
      author: {
        id: "8000000000000000000",
        name: "somebot",
        nickname: null,
        isBot: true,
        avatarUrl: null,
      },
      applicationId: "9000000000000000000",
      interactionMetadata,
      webhookId: "8000000000000000000",
    });

    const { event } = convertMessage(msg, groupChannel, "alice", "batch-1");
    const raw = event.rawData as Record<string, unknown>;
    expect(raw.application_id).toBe("9000000000000000000");
    expect(raw.webhook_id).toBe("8000000000000000000");
    expect(raw.interaction_metadata).toEqual(interactionMetadata);
  });

  test("existing fields still populated (regression)", () => {
    const msg = baseMessage({
      content: "hello world",
      attachments: [
        {
          id: "a1",
          url: "https://cdn.discordapp.com/x/y.png",
          fileName: "y.png",
          fileSizeBytes: 42,
        },
      ],
    });

    const { event } = convertMessage(msg, groupChannel, "alice", "batch-1");
    expect(event.type).toBe("message:group:attachment");
    expect(event.content).toBe("hello world");
    expect(event.title).toBe("But why?");
  });

  test("conversationId is set to the channel id", () => {
    const guildChannel: ChannelContext = {
      id: "9100000000000000000",
      type: 0,
      name: "example-project",
      guildId: "9000000000000000000",
      guildName: "Example Guild Archived",
    };

    const { event: dmEvent } = convertMessage(baseMessage(), groupChannel, "alice", "batch-1");
    expect(dmEvent.conversationId).toBe(groupChannel.id);

    const { event: guildEvent } = convertMessage(baseMessage(), guildChannel, "alice", "batch-1");
    expect(guildEvent.conversationId).toBe(guildChannel.id);
    expect(guildEvent.title).toBe("Example Guild Archived #example-project");

    // Renaming the channel changes the title but not the conversationId — the
    // bug fix's whole reason for existing.
    const renamed: ChannelContext = { ...guildChannel, name: "📍 example-project" };
    const { event: renamedEvent } = convertMessage(baseMessage(), renamed, "alice", "batch-1");
    expect(renamedEvent.conversationId).toBe(guildChannel.id);
    expect(renamedEvent.title).toBe("Example Guild Archived #📍 example-project");
    expect(renamedEvent.title).not.toBe(guildEvent.title);
  });

  test("poll message sets :poll type, indexes question as content, preserves poll", () => {
    // Representative API shape: empty content, poll with finalized results.
    const poll = {
      question: { text: "pineapple on pizza" },
      answers: [
        { answer_id: 1, poll_media: { text: "yes", emoji: { id: null, name: "🔴" } } },
        { answer_id: 2, poll_media: { text: "no", emoji: { id: null, name: "🟢" } } },
      ],
      expiry: "2099-04-04T22:12:26.529000+00:00",
      allow_multiselect: false,
      layout_type: 1,
      results: {
        is_finalized: true,
        answer_counts: [{ id: 1, count: 3, me_voted: true }],
      },
    };
    const msg = baseMessage({ poll });

    const { event } = convertMessage(msg, groupChannel, "alice", "batch-1");
    expect(event.type).toBe("message:group:poll");
    expect(event.content).toBe("pineapple on pizza");
    const raw = event.rawData as Record<string, unknown>;
    expect(raw.poll).toEqual(poll);
  });

  test("call events share conversationId with the channel they're in", () => {
    const msg = baseMessage({ rawType: 3 });
    const { event } = convertMessage(msg, groupChannel, "alice", "batch-1");
    expect(event.type).toBe("message:group:call");
    expect(event.title).toBe("But why?");
    expect(event.conversationId).toBe(groupChannel.id);
  });
});

/**
 * End-to-end fixture test using a synthetic Discord API payload that mirrors
 * the forwarded-message shape. Exercises the full pipeline:
 * raw DiscordMessage → normalizeMessage → convertMessage.
 *
 * All content, timestamps, identifiers, usernames, and URLs are placeholders.
 */
describe("convertMessage (fixture-based)", () => {
  const forwardFixture: DiscordMessage = {
    id: "1000000000000000001",
    type: 0,
    content: "",
    channel_id: "3000000000000000001",
    author: {
      id: "2000000000000000001",
      username: "alice",
      global_name: "Alice",
      discriminator: "0",
      avatar: "avatarhash0000000000000000000001",
    },
    timestamp: "2099-04-03T22:12:26.529000+00:00",
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    flags: 1 << 14, // HAS_SNAPSHOT
    message_reference: {
      type: 1, // FORWARD
      message_id: "1000000000000000002",
      channel_id: "3000000000000000002",
      guild_id: "5000000000000000001",
    },
    message_snapshots: [
      {
        message: {
          type: 0,
          content: "check this link https://example.com/page",
          mentions: [],
          mention_roles: [],
          attachments: [],
          embeds: [
            {
              type: "link",
              url: "https://example.com/page",
              title: "Example page title",
              description: "Example page description",
              thumbnail: {
                url: "https://example.com/thumb.jpg",
                width: 1200,
                height: 630,
              },
            },
          ],
          timestamp: "2099-03-31T10:48:56.225000+00:00",
          edited_timestamp: null,
          flags: 0,
          components: [],
        },
      },
    ],
    components: [],
  };

  const fixtureChannel: DiscordChannel = {
    id: "3000000000000000001",
    type: CHANNEL_TYPE.GROUP_DM,
    name: "But why?",
    recipients: [
      { id: "2000000000000000001", username: "alice", global_name: "Alice" },
      { id: "2000000000000000002", username: "bob", global_name: "Bob" },
      { id: "2000000000000000003", username: "charlie", global_name: "Charlie" },
    ],
  };

  test("forwarded message from real API shape produces :forward event with populated snapshot", () => {
    const normalized = normalizeMessage(forwardFixture);
    const ctx = buildChannelContext(fixtureChannel);

    const { event } = convertMessage(normalized, ctx, "alice", "batch-fixture");

    expect(event.type).toBe("message:group:forward");
    expect(event.title).toBe("But why?");
    expect(event.content).toBe("check this link https://example.com/page");

    const raw = event.rawData as Record<string, unknown>;
    expect(raw.flags).toBe(1 << 14);

    const ref = raw.message_reference as {
      type: number;
      message_id: string;
      channel_id: string;
      guild_id: string;
    };
    expect(ref.type).toBe(1);
    expect(ref.message_id).toBe("1000000000000000002");
    expect(ref.guild_id).toBe("5000000000000000001");

    const snapshots = raw.message_snapshots as DiscordMessageSnapshot[];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].message.content).toBe("check this link https://example.com/page");
    expect(snapshots[0].message.timestamp).toBe("2099-03-31T10:48:56.225000+00:00");
    expect(snapshots[0].message.embeds).toHaveLength(1);
    expect(snapshots[0].message.embeds[0].url).toBe("https://example.com/page");
  });
});
