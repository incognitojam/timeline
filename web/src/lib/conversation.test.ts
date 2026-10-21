import { describe, expect, it } from "vitest";
import {
  computeSenderHeaderIds,
  getConversationContent,
  getDiscordAttachments,
  getForwardedMessageSource,
  getForwardedText,
  getMessageCallInfo,
  getMessageTypeInfo,
  getReactions,
  isDiscordForwardedEvent,
  isPlaceholderContent,
  reverseEventsChronologically,
} from "./conversation";
import type { TimelineEvent } from "./types";

function makeEvent(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    id: 1,
    source: "facebook",
    source_id: "1",
    source_account: null,
    type: "message:dm",
    timestamp: "2024-01-01T00:00:00Z",
    end_timestamp: null,
    duration_ms: null,
    title: null,
    content: null,
    latitude: null,
    longitude: null,
    location_name: null,
    people: null,
    tags: null,
    raw_data: "",
    imported_at: "2024-01-01T00:00:00Z",
    import_batch: null,
    conversation_id: null,
    ...overrides,
  };
}

describe("reverseEventsChronologically", () => {
  it("returns chronological events without mutating query-owned data", () => {
    const first = makeEvent({ id: 1 });
    const second = makeEvent({ id: 2 });
    const cachedEvents = [second, first];

    expect(reverseEventsChronologically(cachedEvents)).toEqual([first, second]);
    expect(reverseEventsChronologically(cachedEvents)).toEqual([first, second]);
    expect(cachedEvents).toEqual([second, first]);
  });
});

describe("message call display", () => {
  it("recognizes scoped Discord call types and derives their duration", () => {
    const event = makeEvent({
      source: "discord",
      source_account: "1",
      type: "message:dm:call",
      timestamp: "2026-01-01T19:10:00Z",
      raw_data: JSON.stringify({
        call: { participants: ["1", "2"], ended_timestamp: "2026-01-01T19:13:12Z" },
      }),
    });

    expect(getMessageTypeInfo(event)).toMatchObject({ label: "Call" });
    expect(getMessageCallInfo(event)).toEqual({ missed: false, durationMs: 192_000 });
  });

  it("marks a Discord call as missed when the synced account did not participate", () => {
    const event = makeEvent({
      source: "discord",
      source_account: "1",
      type: "message:group:call",
      timestamp: "2026-01-01T19:10:00Z",
      raw_data: JSON.stringify({
        call: { participants: ["2"], ended_timestamp: "2026-01-01T19:13:12Z" },
      }),
    });

    expect(getMessageCallInfo(event)).toEqual({ missed: true, durationMs: null });
  });
});

describe("getReactions", () => {
  it("returns null when no raw_data", () => {
    expect(getReactions(makeEvent({}))).toBeNull();
  });

  it("returns null when reactions array is empty", () => {
    expect(getReactions(makeEvent({ raw_data: JSON.stringify({ reactions: [] }) }))).toBeNull();
  });

  it("returns null for unsupported source", () => {
    const event = makeEvent({
      source: "reddit",
      raw_data: JSON.stringify({ reactions: [{ emoji: "👍" }] }),
    });
    expect(getReactions(event)).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    expect(getReactions(makeEvent({ raw_data: "not json" }))).toBeNull();
  });

  it("parses Discord reactions", () => {
    const event = makeEvent({
      source: "discord",
      raw_data: JSON.stringify({
        reactions: [
          { emoji: { name: "👍" }, count: 3 },
          { emoji: { name: "❤️" }, count: 1 },
        ],
      }),
    });
    expect(getReactions(event)).toEqual([
      { emoji: "👍", count: 3 },
      { emoji: "❤️", count: 1 },
    ]);
  });

  it("surfaces Discord reactors as actors when present", () => {
    const event = makeEvent({
      source: "discord",
      raw_data: JSON.stringify({
        reactions: [
          {
            emoji: { name: "👍" },
            count: 2,
            users: [
              { id: "1", name: "Alice" },
              { id: "2", name: "Bob" },
            ],
          },
        ],
      }),
    });
    expect(getReactions(event)).toEqual([
      {
        emoji: "👍",
        count: 2,
        actors: [
          { identifier: "discord:1", name: "Alice" },
          { identifier: "discord:2", name: "Bob" },
        ],
      },
    ]);
  });

  it("skips malformed Discord reaction entries", () => {
    const event = makeEvent({
      source: "discord",
      raw_data: JSON.stringify({
        reactions: [{ emoji: { name: "👍" }, count: 1 }, null],
      }),
    });
    expect(getReactions(event)).toEqual([{ emoji: "👍", count: 1 }]);
  });

  it("surfaces Discord custom emoji metadata for image rendering", () => {
    const event = makeEvent({
      source: "discord",
      raw_data: JSON.stringify({
        reactions: [
          { emoji: { id: "123", name: "party", animated: true }, count: 4 },
        ],
      }),
    });

    expect(getReactions(event)).toEqual([
      {
        emoji: "party",
        count: 4,
        custom: { id: "123", name: "party", animated: true },
      },
    ]);
  });

  it("parses Facebook reactions and groups by emoji", () => {
    const event = makeEvent({
      source: "facebook",
      raw_data: JSON.stringify({
        reactions: [
          { reaction: "😂", actor: "Alice" },
          { reaction: "😂", actor: "Bob" },
          { reaction: "❤️", actor: "Charlie" },
        ],
      }),
    });
    expect(getReactions(event)).toEqual([
      {
        emoji: "😂",
        count: 2,
        actors: [
          { identifier: "facebook:name:Alice", name: "Alice" },
          { identifier: "facebook:name:Bob", name: "Bob" },
        ],
      },
      { emoji: "❤️", count: 1, actors: [{ identifier: "facebook:name:Charlie", name: "Charlie" }] },
    ]);
  });

  it("defaults Facebook reaction emoji to 👍", () => {
    const event = makeEvent({
      source: "facebook",
      raw_data: JSON.stringify({
        reactions: [{ actor: "Alice" }],
      }),
    });
    const result = getReactions(event);
    expect(result).toEqual([
      { emoji: "👍", count: 1, actors: [{ identifier: "facebook:name:Alice", name: "Alice" }] },
    ]);
  });

  it("counts Facebook reactions with missing actors", () => {
    const event = makeEvent({
      source: "facebook",
      raw_data: JSON.stringify({
        reactions: [
          { reaction: "❤️", actor: null },
          { reaction: "❤️", actor: "Alice" },
        ],
      }),
    });
    expect(getReactions(event)).toEqual([
      { emoji: "❤️", count: 2, actors: [{ identifier: "facebook:name:Alice", name: "Alice" }] },
    ]);
  });

  it("skips malformed Facebook reaction entries", () => {
    const event = makeEvent({
      source: "facebook",
      raw_data: JSON.stringify({
        reactions: [{ reaction: "❤️", actor: "Alice" }, null],
      }),
    });
    expect(getReactions(event)).toEqual([
      { emoji: "❤️", count: 1, actors: [{ identifier: "facebook:name:Alice", name: "Alice" }] },
    ]);
  });
});

describe("isPlaceholderContent", () => {
  it("returns false for null content", () => {
    expect(isPlaceholderContent(null, "message:dm")).toBe(false);
  });

  it("returns false for regular message text", () => {
    expect(isPlaceholderContent("Hello world", "message:dm")).toBe(false);
  });

  it.each([
    "[photo]",
    "[video]",
    "[sticker]",
    "[gif]",
    "[voice message]",
    "[unsent message]",
    "[shared link]",
    "[Poll data not exported by Facebook]",
  ])("detects media placeholder: %s", (content) => {
    expect(isPlaceholderContent(content, "message:photo")).toBe(true);
  });

  it("is case-insensitive for media placeholders", () => {
    expect(isPlaceholderContent("[PHOTO]", "message:photo")).toBe(true);
  });

  it("detects call duration pattern", () => {
    expect(isPlaceholderContent("2m 30s call", "message:call")).toBe(true);
  });

  it("detects 'call ended' pattern", () => {
    expect(isPlaceholderContent("The video call ended.", "message:call")).toBe(true);
  });

  it("does not match call patterns for non-call types", () => {
    expect(isPlaceholderContent("2m 30s call", "message:dm")).toBe(false);
  });

  it("detects share URL that matches content", () => {
    expect(isPlaceholderContent("https://example.com/post", "message:share", "https://example.com/post")).toBe(true);
  });

  it("detects share URL with trailing slash mismatch", () => {
    expect(isPlaceholderContent("https://example.com/post", "message:share", "https://example.com/post/")).toBe(true);
  });

  it("does not match share when content differs from link", () => {
    expect(isPlaceholderContent("Check this out!", "message:share", "https://example.com")).toBe(false);
  });
});

describe("getForwardedText", () => {
  it("identifies only Discord forward event types", () => {
    expect(isDiscordForwardedEvent(makeEvent({
      source: "discord",
      type: "message:guild:forward",
    }))).toBe(true);
    expect(isDiscordForwardedEvent(makeEvent({
      source: "discord",
      type: "message:guild",
    }))).toBe(false);
    expect(isDiscordForwardedEvent(makeEvent({
      source: "facebook",
      type: "message:forward",
    }))).toBe(false);
  });

  it("returns snapshot content for Discord :forward", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:group:forward",
      raw_data: JSON.stringify({
        message_snapshots: [{ message: { content: "the example item is available here..." } }],
      }),
    });
    expect(getForwardedText(event)).toBe("the example item is available here...");
  });

  it("trims surrounding whitespace", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:dm:forward",
      raw_data: JSON.stringify({
        message_snapshots: [{ message: { content: "  hello  " } }],
      }),
    });
    expect(getForwardedText(event)).toBe("hello");
  });

  it("returns null when snapshot content is empty", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:guild:forward",
      raw_data: JSON.stringify({
        message_snapshots: [{ message: { content: "" } }],
      }),
    });
    expect(getForwardedText(event)).toBeNull();
  });

  it("returns null when snapshots are missing", () => {
    const event = makeEvent({ source: "discord", type: "message:group:forward", raw_data: "{}" });
    expect(getForwardedText(event)).toBeNull();
  });

  it("returns null for non-:forward types", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:group",
      raw_data: JSON.stringify({
        message_snapshots: [{ message: { content: "hi" } }],
      }),
    });
    expect(getForwardedText(event)).toBeNull();
  });

  it("returns null for non-discord sources", () => {
    const event = makeEvent({ source: "facebook", type: "message:forward", raw_data: "{}" });
    expect(getForwardedText(event)).toBeNull();
  });

  it("links a resolved forward to its original Timeline conversation", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:group:forward",
      forwarded_from: {
        event_id: 42,
        conversation_id: "original-thread",
        timestamp: "2024-06-12T08:00:00Z",
        source_name: "Example Server",
        source_icon_url: "https://cdn.discordapp.com/icons/server/icon.png?size=128",
      },
    });

    expect(getForwardedMessageSource(event)).toEqual({
      url: "/conversation/discord/original-thread#event-42",
      name: "Example Server",
      iconUrl: "https://cdn.discordapp.com/icons/server/icon.png?size=128",
      timestamp: "2024-06-12T08:00:00Z",
    });
  });

  it("does not link a forward whose original is not indexed", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:group:forward",
    });

    expect(getForwardedMessageSource(event)).toBeNull();
  });

  it("provides snapshot text as canonical conversation content", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:group:forward",
      raw_data: JSON.stringify({
        message_snapshots: [{ message: { content: "Forwarded body" } }],
      }),
    });
    expect(getConversationContent(event)).toBe("Forwarded body");
  });

  it("prefers normalized content when it is populated", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:group:forward",
      content: "Indexed body",
      raw_data: JSON.stringify({
        message_snapshots: [{ message: { content: "Forwarded body" } }],
      }),
    });
    expect(getConversationContent(event)).toBe("Indexed body");
  });
});

describe("getDiscordAttachments", () => {
  it("returns forwarded snapshot attachments", () => {
    const event = makeEvent({
      source: "discord",
      type: "message:group:forward",
      raw_data: JSON.stringify({
        attachments: [],
        message_snapshots: [{
          message: {
            attachments: [{
              id: "file-1",
              filename: "photo.jpg",
              size: 1234,
              url: "https://cdn.discordapp.com/attachments/channel/file-1/photo.jpg",
              content_type: "image/jpeg",
              width: 800,
              height: 600,
            }],
          },
        }],
      }),
    });

    expect(getDiscordAttachments(event)).toEqual([{
      id: "file-1",
      filename: "photo.jpg",
      size: 1234,
      url: "https://cdn.discordapp.com/attachments/channel/file-1/photo.jpg",
      content_type: "image/jpeg",
      width: 800,
      height: 600,
    }]);
  });

  it("returns null for malformed raw data", () => {
    expect(getDiscordAttachments(makeEvent({ source: "discord", raw_data: "{" }))).toBeNull();
  });
});

describe("computeSenderHeaderIds", () => {
  const alice = JSON.stringify(["discord:alice"]);
  const bob = JSON.stringify(["discord:bob"]);

  function message(id: number, people: string, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
    return makeEvent({
      id,
      source: "discord",
      people,
      timestamp: `2024-01-01T0${id}:00:00Z`,
      ...overrides,
    });
  }

  it("headers only the first event of a same-sender run", () => {
    const events = [message(1, alice), message(2, alice), message(3, alice)];
    expect(computeSenderHeaderIds(events)).toEqual(new Set([1]));
  });

  it("headers every event when the sender alternates", () => {
    const events = [message(1, alice), message(2, bob), message(3, alice)];
    expect(computeSenderHeaderIds(events)).toEqual(new Set([1, 2, 3]));
  });

  it("headers the first message of a new date group", () => {
    const events = [
      message(1, alice, { timestamp: "2024-01-01T23:50:00Z" }),
      message(2, alice, { timestamp: "2024-01-01T23:55:00Z" }),
      message(3, alice, { timestamp: "2024-01-03T00:05:00Z" }),
    ];
    expect(computeSenderHeaderIds(events)).toEqual(new Set([1, 3]));
  });

  it("breaks a run on a reply, which carries its own quoted preview", () => {
    const events = [
      message(1, alice),
      message(2, alice, {
        replied_to: {
          event_id: 1,
          conversation_id: "c1",
          author_name: "Alice",
          content: "hi",
          has_attachment: false,
        },
      }),
      message(3, alice),
    ];
    expect(computeSenderHeaderIds(events)).toEqual(new Set([1, 2]));
  });

  it("breaks a run on a message type badge", () => {
    const events = [
      message(1, alice),
      message(2, alice, { type: "message:dm:call" }),
      message(3, alice),
    ];
    expect(computeSenderHeaderIds(events)).toEqual(new Set([1, 2]));
  });

  it("headers forced ids, e.g. events an inline separator is drawn above", () => {
    const events = [message(1, alice), message(2, alice), message(3, alice)];
    expect(computeSenderHeaderIds(events, new Set([3]))).toEqual(new Set([1, 3]));
  });

  it("returns an empty set for no events", () => {
    expect(computeSenderHeaderIds([])).toEqual(new Set());
  });
});
