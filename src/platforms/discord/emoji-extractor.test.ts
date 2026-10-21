import { describe, it, expect } from "bun:test";
import { extractEmojiRefs } from "./emoji-extractor";

describe("extractEmojiRefs", () => {
  it("returns nothing for plain unicode reactions and bare text", () => {
    const refs = extractEmojiRefs({
      content: "hello world",
      reactions: [{ emoji: { id: null, name: "👍" }, count: 3 }],
    });
    expect(refs).toEqual([]);
  });

  it("pulls custom reactions and inline content", () => {
    const refs = extractEmojiRefs({
      content: "lol <:catjam:111>",
      reactions: [
        { emoji: { id: "200", name: "wave", animated: true }, count: 1 },
        { emoji: { id: null, name: "🔥" }, count: 2 },
      ],
    });
    expect(refs).toEqual([
      { id: "200", name: "wave", animated: true },
      { id: "111", name: "catjam", animated: false },
    ]);
  });

  it("uses inline `<a:` content to upgrade reactions missing the animated flag", () => {
    const refs = extractEmojiRefs({
      content: "<a:partyparrot:55>",
      reactions: [{ emoji: { id: "55", name: "partyparrot" }, count: 4 }],
    });
    expect(refs).toEqual([{ id: "55", name: "partyparrot", animated: true }]);
  });

  it("walks referenced_message and message_snapshots content", () => {
    const refs = extractEmojiRefs({
      referenced_message: { content: "reply to <:hi:7>" },
      message_snapshots: [{ message: { content: "fwd <a:dance:9>" } }],
    });
    expect(refs).toEqual([
      { id: "7", name: "hi", animated: false },
      { id: "9", name: "dance", animated: true },
    ]);
  });

  it("dedupes the same emoji appearing in multiple places", () => {
    const refs = extractEmojiRefs({
      content: "<:dup:1> <:dup:1>",
      reactions: [{ emoji: { id: "1", name: "dup" }, count: 1 }],
      referenced_message: { content: "<:dup:1>" },
    });
    expect(refs).toEqual([{ id: "1", name: "dup", animated: false }]);
  });

  it("treats unknown animated state as null when nothing else disambiguates", () => {
    const refs = extractEmojiRefs({
      reactions: [{ emoji: { id: "42", name: "mystery" }, count: 1 }],
    });
    expect(refs).toEqual([{ id: "42", name: "mystery", animated: null }]);
  });

  it("returns [] for non-objects and missing fields", () => {
    expect(extractEmojiRefs(null)).toEqual([]);
    expect(extractEmojiRefs(undefined)).toEqual([]);
    expect(extractEmojiRefs("string")).toEqual([]);
    expect(extractEmojiRefs({})).toEqual([]);
  });
});
