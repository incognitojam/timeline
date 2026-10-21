import { describe, expect, test } from "bun:test";
import {
  formatBinaryBytes,
  formatPreciseDuration,
  getAttachmentDescription,
  getDiscordCallDescription,
  getDiscordStickerDescription,
  getEmbedsDescription,
  getReactionsDescription,
  getReactionSummary,
} from "./format";

describe("formatPreciseDuration", () => {
  test("omits zero components while retaining second-level precision", () => {
    expect(formatPreciseDuration(3_600_000)).toBe("1h");
    expect(formatPreciseDuration(3_671_000)).toBe("1h 1m 11s");
    expect(formatPreciseDuration(120_000)).toBe("2m");
    expect(formatPreciseDuration(11_000)).toBe("11s");
    expect(formatPreciseDuration(500)).toBe("0s");
    expect(formatPreciseDuration(0)).toBe("0s");
  });
});

describe("formatBinaryBytes", () => {
  test("formats bytes without scaling", () => {
    expect(formatBinaryBytes(0)).toBe("0 B");
    expect(formatBinaryBytes(1023)).toBe("1023 B");
  });

  test("scales binary units by magnitude", () => {
    expect(formatBinaryBytes(498156)).toBe("486.5 KiB");
    expect(formatBinaryBytes(1024 ** 2)).toBe("1.0 MiB");
    expect(formatBinaryBytes(32856540774)).toBe("30.6 GiB");
  });

  test("rejects invalid byte counts", () => {
    expect(() => formatBinaryBytes(-1)).toThrow("Cannot format invalid byte count: -1");
    expect(() => formatBinaryBytes(Number.NaN)).toThrow("Cannot format invalid byte count: NaN");
  });
});

describe("getAttachmentDescription", () => {
  test("describes Google Messages media parts whether or not they were fetched", () => {
    const event = {
      source: "google-messages",
      raw_data: JSON.stringify({
        media: [
          { media_id: "a", name: "IMG_1.jpg", mime_type: "image/jpeg", status: "stored" },
          { media_id: "b", mime_type: "audio/mpeg", status: "unavailable" },
          { media_id: "c", name: "contact.vcf", mime_type: "text/x-vcard", status: "failed" },
        ],
      }),
    };
    expect(getAttachmentDescription(event)).toBe("[photo] [audio] [file: contact.vcf]");
  });

  test("returns null for a Google Messages text without media", () => {
    expect(getAttachmentDescription({ source: "google-messages", raw_data: JSON.stringify({ text: "hi" }) })).toBeNull();
  });
});

describe("getEmbedsDescription", () => {
  test("formats textual embed title and description", () => {
    const event = {
      raw_data: JSON.stringify({
        embeds: [
          {
            type: "link",
            url: "https://example.com/post",
            title: "Example post",
            description: "A useful description",
            provider: { name: "Example" },
            thumbnail: { url: "https://example.com/thumb.jpg" },
          },
        ],
      }),
    };

    expect(getEmbedsDescription(event)).toBe("[embed: Example post — A useful description]");
  });

  test("skips URL-only and media-only embeds", () => {
    const event = {
      raw_data: JSON.stringify({
        embeds: [
          { type: "link", url: "https://example.com/only-url" },
          {
            type: "link",
            url: "https://example.com/thumbnail",
            thumbnail: { url: "https://example.com/thumb.jpg" },
          },
        ],
      }),
    };

    expect(getEmbedsDescription(event)).toBeNull();
  });

  test("joins multiple textual embed markers with spaces", () => {
    const event = {
      raw_data: JSON.stringify({
        embeds: [
          { title: "First link" },
          { title: "Second link", description: "Second description" },
        ],
      }),
    };

    expect(getEmbedsDescription(event)).toBe(
      "[embed: First link] [embed: Second link — Second description]",
    );
  });

  test("ignores non-array embed fields without dropping the embed", () => {
    const event = {
      raw_data: JSON.stringify({
        embeds: [{ title: "Good title", fields: "not-an-array" }],
      }),
    };

    expect(getEmbedsDescription(event)).toBe("[embed: Good title]");
  });

  test("ignores malformed field entries without dropping other embeds", () => {
    const event = {
      raw_data: JSON.stringify({
        embeds: [
          { title: "First OK" },
          { title: "Second bad", fields: [null] },
        ],
      }),
    };

    expect(getEmbedsDescription(event)).toBe("[embed: First OK] [embed: Second bad]");
  });

  test("includes forwarded-message embeds from snapshots", () => {
    const event = {
      raw_data: JSON.stringify({
        message_snapshots: [
          {
            message: {
              embeds: [
                {
                  author: { name: "Example Author" },
                  title: "Forwarded link",
                  description: "Forwarded description",
                },
              ],
            },
          },
        ],
      }),
    };

    expect(getEmbedsDescription(event)).toBe(
      "[embed: Example Author — Forwarded link — Forwarded description]",
    );
  });

  test("collapses multiline descriptions, truncates them, and renders fields", () => {
    const longDescription = `First line\n${"details ".repeat(60)}last line`;
    const event = {
      raw_data: JSON.stringify({
        embeds: [
          {
            title: "Long post",
            description: longDescription,
            fields: [
              { name: "Status", value: "Ready\nnow" },
              { name: "Empty", value: "" },
            ],
          },
        ],
      }),
    };

    const description = getEmbedsDescription(event);
    if (!description) throw new Error("expected embed description");
    expect(description.includes("\n")).toBe(false);
    expect(description.startsWith("[embed: Long post — First line details details")).toBe(true);
    expect(description).toContain("... — Status: Ready now]");
  });
});

describe("getDiscordCallDescription", () => {
  test("formats completed calls from Discord raw data", () => {
    expect(getDiscordCallDescription({
      source: "discord",
      type: "message:group:call",
      source_account: "1",
      timestamp: "2026-01-01T19:10:00Z",
      raw_data: JSON.stringify({ call: { participants: ["1", "2"], ended_timestamp: "2026-01-01T19:13:12Z" } }),
    })).toBe("[call: 3m 12s]");
  });

  test("marks calls as missed when the account did not participate", () => {
    expect(getDiscordCallDescription({
      source: "discord",
      type: "message:dm:call",
      source_account: "1",
      timestamp: "2026-01-01T19:10:00Z",
      raw_data: JSON.stringify({ call: { participants: ["2"], ended_timestamp: "2026-01-01T19:13:12Z" } }),
    })).toBe("[missed call]");
  });

  test("labels calls without an end timestamp as missing their duration", () => {
    expect(getDiscordCallDescription({
      source: "discord",
      type: "message:dm:call",
      source_account: "1",
      timestamp: "2026-01-01T19:10:00Z",
      raw_data: JSON.stringify({ call: { participants: ["1"], ended_timestamp: null } }),
    })).toBe("[call: answered; duration unavailable]");
  });

  test("uses the end timestamp even when participant metadata is absent", () => {
    expect(getDiscordCallDescription({
      source: "discord",
      type: "message:dm:call",
      source_account: "1",
      timestamp: "2026-01-01T19:10:00Z",
      raw_data: JSON.stringify({ call: { ended_timestamp: "2026-01-01T19:13:12Z" } }),
    })).toBe("[call: 3m 12s]");
  });
});

describe("getDiscordStickerDescription", () => {
  test("formats stickers from Discord event data", () => {
    expect(getDiscordStickerDescription({
      source: "discord",
      raw_data: JSON.stringify({
        sticker_items: [{ name: "Wave" }, {}, null],
      }),
    })).toBe("[sticker: Wave] [sticker]");
  });

  test("formats stickers from forwarded-message snapshots", () => {
    expect(getDiscordStickerDescription({
      source: "discord",
      raw_data: JSON.stringify({
        message_snapshots: [{ message: { sticker_items: [{ name: "Forwarded Wave" }] } }],
      }),
    })).toBe("[sticker: Forwarded Wave]");
  });
});

describe("getReactionSummary", () => {
  test("summarizes valid Discord reactions and skips unsupported entries", () => {
    const event = {
      source: "discord",
      raw_data: JSON.stringify({
        reactions: [
          { emoji: { id: null, name: "👍" }, count: 1 },
          { emoji: { id: "5", name: "pepe" }, count: 2 },
          { emoji: { id: null }, count: 1 },
          { emoji: { id: null, name: "👎" }, count: 0 },
        ],
      }),
    };

    expect(getReactionSummary(event)).toEqual({
      description: "[reactions: 👍 ×1; :pepe: ×2]",
      reactionEntries: 4,
      summarizedEntries: 2,
      skippedEntries: 2,
      abortsCurrentConsumer: false,
    });
    expect(getReactionsDescription(event)).toBe("[reactions: 👍 ×1; :pepe: ×2]");
  });

  test("includes known Discord reactors", () => {
    const event = {
      source: "discord",
      raw_data: JSON.stringify({
        reactions: [
          {
            emoji: { id: null, name: "👍" },
            count: 2,
            users: [
              { id: "1", name: "Alice" },
              { id: "2", name: "Bob" },
            ],
          },
          {
            emoji: { id: "5", name: "pepe" },
            count: 3,
            users: [
              { id: "3", name: "Eve" },
            ],
          },
        ],
      }),
    };

    expect(getReactionsDescription(event)).toBe("[reactions: 👍 Alice, Bob; :pepe: ×3 (Eve)]");
  });

  test("models null Discord reaction entries as skipped", () => {
    const event = {
      source: "discord",
      raw_data: JSON.stringify({
        reactions: [{ emoji: { id: null, name: "👍" }, count: 1 }, null],
      }),
    };

    expect(getReactionSummary(event)).toEqual({
      description: "[reactions: 👍 ×1]",
      reactionEntries: 2,
      summarizedEntries: 1,
      skippedEntries: 1,
      abortsCurrentConsumer: false,
    });
    expect(getReactionsDescription(event)).toBe("[reactions: 👍 ×1]");
  });

  test("counts Facebook reactions with missing actors", () => {
    const event = {
      source: "facebook",
      raw_data: JSON.stringify({
        reactions: [
          { reaction: "❤️", actor: null },
          { reaction: "❤️", actor: "Alice" },
        ],
      }),
    };

    expect(getReactionSummary(event)).toEqual({
      description: "[reactions: ❤️ ×2 (Alice)]",
      reactionEntries: 2,
      summarizedEntries: 2,
      skippedEntries: 0,
      abortsCurrentConsumer: false,
    });
  });

  test("models null Facebook reaction entries as skipped", () => {
    const event = {
      source: "facebook",
      raw_data: JSON.stringify({
        reactions: [{ reaction: "❤️", actor: "Alice" }, null],
      }),
    };

    expect(getReactionSummary(event)).toEqual({
      description: "[reactions: ❤️ Alice]",
      reactionEntries: 2,
      summarizedEntries: 1,
      skippedEntries: 1,
      abortsCurrentConsumer: false,
    });
    expect(getReactionsDescription(event)).toBe("[reactions: ❤️ Alice]");
  });
});
