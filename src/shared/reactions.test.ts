import { describe, expect, test } from "bun:test";
import { normalizeReactions } from "./reactions";

describe("normalizeReactions", () => {
  test("returns null for missing or unsupported reaction data", () => {
    expect(normalizeReactions({ source: "discord", raw_data: null })).toBeNull();
    expect(normalizeReactions({ source: "discord", raw_data: "not json" })).toBeNull();
    expect(
      normalizeReactions({ source: "reddit", raw_data: JSON.stringify({ reactions: [{ emoji: "👍" }] }) }),
    ).toBeNull();
    expect(normalizeReactions({ source: "facebook", raw_data: JSON.stringify({ reactions: [] }) })).toBeNull();
  });

  test("normalizes Discord reactions with custom emoji metadata", () => {
    const reactions = normalizeReactions({
      source: "discord",
      raw_data: JSON.stringify({
        reactions: [
          { emoji: { id: null, name: "👍" }, count: 2 },
          {
            emoji: { id: "123", name: "party", animated: true },
            count: 4,
            users: [
              { id: "1", name: "Alice" },
              { id: "2", name: "Bob" },
            ],
          },
        ],
      }),
    });

    expect(reactions).toEqual([
      { emoji: "👍", count: 2 },
      {
        emoji: "party",
        count: 4,
        actors: [
          { identifier: "discord:1", name: "Alice" },
          { identifier: "discord:2", name: "Bob" },
        ],
        custom: { id: "123", name: "party", animated: true },
      },
    ]);
  });

  test("groups Facebook reactions by emoji while preserving actor names", () => {
    const reactions = normalizeReactions({
      source: "facebook",
      raw_data: JSON.stringify({
        reactions: [
          { reaction: "😂", actor: "Alice" },
          { reaction: "😂", actor: "Bob" },
          { reaction: "❤️", actor: "Charlie" },
          { actor: "Dana" },
        ],
      }),
    });

    expect(reactions).toEqual([
      {
        emoji: "😂",
        count: 2,
        actors: [
          { identifier: "facebook:name:Alice", name: "Alice" },
          { identifier: "facebook:name:Bob", name: "Bob" },
        ],
      },
      { emoji: "❤️", count: 1, actors: [{ identifier: "facebook:name:Charlie", name: "Charlie" }] },
      { emoji: "👍", count: 1, actors: [{ identifier: "facebook:name:Dana", name: "Dana" }] },
    ]);
  });
});
