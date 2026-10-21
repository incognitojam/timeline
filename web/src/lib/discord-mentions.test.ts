import { describe, it, expect } from "vitest";
import {
  discordMentionsToPlainText,
  extractCustomEmojiRefs,
  parseDiscordMentions,
} from "./discord-mentions";

const MENTIONS_RAW = JSON.stringify({
  mentions: [
    { id: "900000000000000001", name: "Alice" },
    { id: "111", username: "bob_user", global_name: "Bob" },
  ],
  mention_channels: [{ id: "777", name: "general" }],
});

describe("parseDiscordMentions", () => {
  it("returns single text segment when there are no mentions", () => {
    const segments = parseDiscordMentions("hello world", null);
    expect(segments).toEqual([{ kind: "text", value: "hello world" }]);
  });

  it("resolves a user mention via raw_data.mentions", () => {
    const segments = parseDiscordMentions(
      "<@900000000000000001> please review the example plan",
      MENTIONS_RAW
    );
    expect(segments).toEqual([
      { kind: "user-mention", id: "900000000000000001", name: "Alice" },
      { kind: "text", value: " please review the example plan" },
    ]);
  });

  it("resolves the legacy <@!id> nickname syntax", () => {
    const segments = parseDiscordMentions("hi <@!111>", MENTIONS_RAW);
    expect(segments).toEqual([
      { kind: "text", value: "hi " },
      { kind: "user-mention", id: "111", name: "Bob" },
    ]);
  });

  it("falls back to a short id when user metadata is missing", () => {
    const segments = parseDiscordMentions("<@999888777666> ping", null);
    expect(segments).toEqual([
      { kind: "user-mention", id: "999888777666", name: "user:9998…" },
      { kind: "text", value: " ping" },
    ]);
  });

  it("resolves a channel mention via raw_data.mention_channels", () => {
    const segments = parseDiscordMentions("see <#777>", MENTIONS_RAW);
    expect(segments).toEqual([
      { kind: "text", value: "see " },
      { kind: "channel-mention", id: "777", name: "general" },
    ]);
  });

  it("emits role mentions without a name when metadata is missing", () => {
    const segments = parseDiscordMentions("<@&12345>", null);
    expect(segments).toEqual([
      { kind: "role-mention", id: "12345", name: undefined },
    ]);
  });

  it("parses static and animated custom emoji", () => {
    const segments = parseDiscordMentions("<:smile:1> and <a:wave:2>", null);
    expect(segments).toEqual([
      { kind: "custom-emoji", id: "1", name: "smile", animated: false },
      { kind: "text", value: " and " },
      { kind: "custom-emoji", id: "2", name: "wave", animated: true },
    ]);
  });

  it("handles multiple mixed tokens in a single message", () => {
    const segments = parseDiscordMentions(
      "<@900000000000000001> ping in <#777>!",
      MENTIONS_RAW
    );
    expect(segments).toEqual([
      { kind: "user-mention", id: "900000000000000001", name: "Alice" },
      { kind: "text", value: " ping in " },
      { kind: "channel-mention", id: "777", name: "general" },
      { kind: "text", value: "!" },
    ]);
  });

  it("accepts a pre-parsed raw_data object", () => {
    const segments = parseDiscordMentions(
      "<@900000000000000001>",
      JSON.parse(MENTIONS_RAW)
    );
    expect(segments).toEqual([
      { kind: "user-mention", id: "900000000000000001", name: "Alice" },
    ]);
  });

  it("prefers a resolver-supplied name over the stored mention name", () => {
    const resolvers = { user: (id: string) => (id === "900000000000000001" ? "Alice (Display)" : null) };
    const segments = parseDiscordMentions(
      "<@900000000000000001>",
      MENTIONS_RAW,
      resolvers
    );
    expect(segments).toEqual([
      { kind: "user-mention", id: "900000000000000001", name: "Alice (Display)" },
    ]);
  });

  it("falls back to stored mention name when resolver returns nothing", () => {
    const resolvers = { user: () => null };
    const segments = parseDiscordMentions(
      "<@900000000000000001>",
      MENTIONS_RAW,
      resolvers
    );
    expect(segments).toEqual([
      { kind: "user-mention", id: "900000000000000001", name: "Alice" },
    ]);
  });

  it("parses a timestamp token, defaulting to the short date/time style", () => {
    expect(parseDiscordMentions("meet at <t:1686682800>", null)).toEqual([
      { kind: "text", value: "meet at " },
      { kind: "timestamp", seconds: 1686682800, style: "f" },
    ]);
  });

  it("parses every documented timestamp style suffix", () => {
    for (const style of ["t", "T", "d", "D", "f", "F", "R"]) {
      expect(parseDiscordMentions(`<t:1686682800:${style}>`, null)).toEqual([
        { kind: "timestamp", seconds: 1686682800, style },
      ]);
    }
  });

  it("parses a pre-epoch timestamp", () => {
    expect(parseDiscordMentions("<t:-86400:D>", null)).toEqual([
      { kind: "timestamp", seconds: -86400, style: "D" },
    ]);
  });

  it("leaves unknown styles and out-of-range values as literal text", () => {
    expect(parseDiscordMentions("<t:1686682800:X>", null)).toEqual([
      { kind: "text", value: "<t:1686682800:X>" },
    ]);
    expect(parseDiscordMentions("<t:99999999999999999:R>", null)).toEqual([
      { kind: "text", value: "<t:99999999999999999:R>" },
    ]);
  });

  it("does not mistake an emoji named t for a timestamp", () => {
    expect(parseDiscordMentions("<a:t:123>", null)).toEqual([
      { kind: "custom-emoji", id: "123", name: "t", animated: true },
    ]);
  });

  it("survives invalid raw_data JSON without throwing", () => {
    const segments = parseDiscordMentions("<@900000000000000001>", "{not json");
    expect(segments).toEqual([
      { kind: "user-mention", id: "900000000000000001", name: "user:9000…" },
    ]);
  });
});

describe("extractCustomEmojiRefs", () => {
  it("returns refs for static and animated emoji with the right flags", () => {
    expect(extractCustomEmojiRefs("hi <:smile:1> bye <a:wave:2>")).toEqual([
      { id: "1", name: "smile", animated: false },
      { id: "2", name: "wave", animated: true },
    ]);
  });

  it("dedupes by id, preferring animated when seen", () => {
    expect(
      extractCustomEmojiRefs("<:foo:1> first then <a:foo:1> animated"),
    ).toEqual([{ id: "1", name: "foo", animated: true }]);
  });

  it("returns an empty array for non-matching content", () => {
    expect(extractCustomEmojiRefs("plain text only")).toEqual([]);
    expect(extractCustomEmojiRefs("")).toEqual([]);
  });
});

describe("discordMentionsToPlainText", () => {
  it("collapses user, channel, role and emoji segments to plain text", () => {
    const out = discordMentionsToPlainText(
      "<@900000000000000001> in <#777> tagging <@&55> <:smile:1>",
      MENTIONS_RAW
    );
    expect(out).toBe("@Alice in #general tagging @role:55 :smile:");
  });

  it("returns the original string when no mentions are present", () => {
    expect(discordMentionsToPlainText("hello", null)).toBe("hello");
  });

  it("renders timestamps absolutely in UTC by default, per style", () => {
    expect(discordMentionsToPlainText("at <t:1686682800:t>", null)).toBe("at 19:00");
    expect(discordMentionsToPlainText("at <t:1686682800:T>", null)).toBe("at 19:00:00");
    expect(discordMentionsToPlainText("on <t:1686682800:d>", null)).toBe("on 2023-06-13");
    expect(discordMentionsToPlainText("on <t:1686682800:D>", null)).toBe("on 2023-06-13");
    expect(discordMentionsToPlainText("on <t:1686682800:F>", null)).toBe("on 2023-06-13 19:00");
  });

  it("renders a relative timestamp absolutely, so exports stay stable", () => {
    expect(discordMentionsToPlainText("starts <t:1686682800:R>", null)).toBe(
      "starts 2023-06-13 19:00",
    );
  });

  it("renders timestamps in the requested timezone", () => {
    expect(
      discordMentionsToPlainText("at <t:1686682800:f>", null, undefined, {
        timeZone: "America/New_York",
      }),
    ).toBe("at 2023-06-13 15:00");
  });
});
