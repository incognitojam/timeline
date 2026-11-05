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

  describe("Google Messages", () => {
    const participants = [
      { participant_id: "1", number: "+15550100000", is_me: true, visible: true },
      { participant_id: "2", number: "(555) 010-0001", name: "Alice", is_me: false, visible: true },
      { participant_id: "3", number: "+15550100002", is_me: false, visible: true },
    ];
    const reactionsOf = (reactions: unknown[], extra: Record<string, unknown> = { participants }) =>
      normalizeReactions({ source: "google-messages", raw_data: JSON.stringify({ reactions, ...extra }) });

    test("counts and names everyone who reacted with an emoji", () => {
      expect(reactionsOf([{ emoji: "❤️", type: "RED_HEART", participant_ids: ["2", "1", "3"] }])).toEqual([
        {
          emoji: "❤️",
          count: 3,
          actors: [
            { identifier: "phone:5550100001", name: "Alice" },
            { identifier: "phone:+15550100000", name: "You" },
            { identifier: "phone:+15550100002", name: "+15550100002" },
          ],
        },
      ]);
    });

    test("keeps the count for a reactor missing from the conversation's participants", () => {
      expect(reactionsOf([{ emoji: "👍", participant_ids: ["2", "99"] }])).toEqual([
        { emoji: "👍", count: 2, actors: [{ identifier: "phone:5550100001", name: "Alice" }] },
      ]);
    });

    test("merges separate entries for the same emoji", () => {
      expect(
        reactionsOf([
          { emoji: "😂", participant_ids: ["2"] },
          { emoji: "❤️", participant_ids: ["1"] },
          { emoji: "😂", participant_ids: ["3"] },
        ]),
      ).toEqual([
        {
          emoji: "😂",
          count: 2,
          actors: [
            { identifier: "phone:5550100001", name: "Alice" },
            { identifier: "phone:+15550100002", name: "+15550100002" },
          ],
        },
        { emoji: "❤️", count: 1, actors: [{ identifier: "phone:+15550100000", name: "You" }] },
      ]);
    });

    test("reads the bare strings older sidecars emitted as one unnamed reaction each", () => {
      expect(reactionsOf(["😮", "😂"])).toEqual([
        { emoji: "😮", count: 1 },
        { emoji: "😂", count: 1 },
      ]);
    });

    test("labels a custom reaction rather than printing its id, in either shape", () => {
      const id = "5f0c9a52-7d3e-4b18-9c46-2e8a1b7d6f30";
      expect(reactionsOf([id])).toEqual([{ emoji: ":custom:", count: 1, undisplayable: true }]);
      expect(reactionsOf([{ emoji: id, type: "EMOTIFY", participant_ids: ["2"] }])).toEqual([
        { emoji: ":custom:", count: 1, undisplayable: true, actors: [{ identifier: "phone:5550100001", name: "Alice" }] },
      ]);
    });
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
