import { describe, it, expect } from "bun:test";
import {
  groupEvents,
  isConversationEventType,
  isReactionEventType,
  SESSION_GAP_MINUTES,
} from "./grouping";
import type { GroupableEvent } from "./types";

// Helper to create test events
function makeEvent(overrides: Partial<GroupableEvent> & { id: number }): GroupableEvent {
  return {
    source: "test",
    type: "test",
    title: null,
    conversation_id: null,
    content: null,
    timestamp: new Date().toISOString(),
    people: null,
    duration_ms: null,
    ...overrides,
  };
}

describe("isConversationEventType", () => {
  it("matches message and phone conversation thread event types", () => {
    expect(isConversationEventType("message:dm")).toBe(true);
    expect(isConversationEventType("opencode:message:user")).toBe(true);
    expect(isConversationEventType("sms:sent")).toBe(true);
    expect(isConversationEventType("mms:received")).toBe(true);
    expect(isConversationEventType("call:incoming")).toBe(true);
  });

  it("does not treat comments or memories as conversation thread event types", () => {
    expect(isConversationEventType("comment")).toBe(false);
    expect(isConversationEventType("group:comment")).toBe(false);
    expect(isConversationEventType("github:issue_comment")).toBe(false);
    expect(isConversationEventType("claude:memory")).toBe(false);
  });
});

describe("isReactionEventType", () => {
  it("matches reaction:* event types only", () => {
    expect(isReactionEventType("reaction:like")).toBe(true);
    expect(isReactionEventType("reaction:love")).toBe(true);
    expect(isReactionEventType("comment")).toBe(false);
    expect(isReactionEventType("post")).toBe(false);
    expect(isReactionEventType("message:dm")).toBe(false);
  });
});

describe("groupEvents", () => {
  it("leaves comments and memories as single events", () => {
    const events = [
      makeEvent({
        id: 1,
        source: "facebook",
        type: "comment",
        title: "Public comment",
        timestamp: "2026-01-01T00:00:00Z",
      }),
      makeEvent({
        id: 2,
        source: "claude",
        type: "claude:memory",
        title: "Claude Memory",
        timestamp: "2026-01-01T00:01:00Z",
      }),
    ];

    const groups = groupEvents(events);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.type === "single")).toBe(true);
  });

  describe("facebook reaction grouping", () => {
    it("collapses a burst of reactions into one session card", () => {
      const events = [1, 2, 3, 4].map((id) =>
        makeEvent({
          id,
          source: "facebook",
          type: "reaction:like",
          title: "Liked a comment",
          timestamp: `2024-01-15T12:0${id}:00Z`,
        })
      );

      const groups = groupEvents(events);

      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("session");
      expect(groups[0].source).toBe("facebook");
      expect(groups[0].label).toBe("Reactions");
      expect(groups[0].summary).toBe("4 reactions");
      expect(groups[0].events).toHaveLength(4);
    });

    it("collapses even an isolated reaction, keeping comments as single cards", () => {
      const events = [
        makeEvent({
          id: 1,
          source: "facebook",
          type: "reaction:like",
          timestamp: "2024-01-15T12:00:00Z",
        }),
        makeEvent({
          id: 2,
          source: "facebook",
          type: "comment",
          title: "Commented on a post",
          content: "Nice one",
          timestamp: "2024-01-15T12:05:00Z",
        }),
        // >15min after the first reaction, so it forms its own reaction group
        makeEvent({
          id: 3,
          source: "facebook",
          type: "reaction:like",
          timestamp: "2024-01-15T13:00:00Z",
        }),
      ];

      const groups = groupEvents(events);

      // Two lone reaction cards (still collapsed) + one comment single card
      const reactionGroups = groups.filter((g) => g.label === "Reactions");
      expect(reactionGroups).toHaveLength(2);
      expect(reactionGroups.every((g) => g.type === "session")).toBe(true);
      expect(reactionGroups.every((g) => g.summary === "1 reaction")).toBe(true);

      const commentGroups = groups.filter((g) => g.events[0].type === "comment");
      expect(commentGroups).toHaveLength(1);
      expect(commentGroups[0].type).toBe("single");
    });

    it("leaves non-reaction Facebook types (post, friend:added) as single cards", () => {
      const events = [
        makeEvent({
          id: 1,
          source: "facebook",
          type: "post",
          title: "Shared a photo",
          timestamp: "2024-01-15T12:00:00Z",
        }),
        makeEvent({
          id: 2,
          source: "facebook",
          type: "friend:added",
          title: "Became friends with Alice",
          timestamp: "2024-01-15T12:01:00Z",
        }),
        // A neighbouring reaction must not sweep the post/friend event into a group
        makeEvent({
          id: 3,
          source: "facebook",
          type: "reaction:like",
          timestamp: "2024-01-15T12:02:00Z",
        }),
      ];

      const groups = groupEvents(events);

      const postGroup = groups.find((g) => g.events[0].type === "post");
      const friendGroup = groups.find((g) => g.events[0].type === "friend:added");
      expect(postGroup?.type).toBe("single");
      expect(friendGroup?.type).toBe("single");
      // The reaction still collapses into its own Reactions card
      expect(groups.some((g) => g.label === "Reactions")).toBe(true);
    });
  });

  describe("spotify-friends grouping", () => {
    it("groups events by friend then by time proximity", () => {
      const now = new Date("2024-01-15T12:00:00Z");
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Example Track One by Example Band from Example Album",
          timestamp: now.toISOString(),
          people: JSON.stringify(["spotify:alice"]),
        }),
        makeEvent({
          id: 2,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Example Track Two by Example Band from Example Album",
          timestamp: new Date(now.getTime() + 3 * 60 * 1000).toISOString(), // +3 min
          people: JSON.stringify(["spotify:alice"]),
        }),
        makeEvent({
          id: 3,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Sample Track by Sample Artist from Sample Album",
          timestamp: new Date(now.getTime() + 1 * 60 * 1000).toISOString(), // +1 min
          people: JSON.stringify(["spotify:bob"]),
        }),
      ];

      const groups = groupEvents(events);

      // Should have 2 groups: one for Alice, one for Bob
      expect(groups.length).toBe(2);

      // Find Alice's and Bob's groups
      const aliceGroup = groups.find((g) => g.participants?.includes("spotify:alice"));
      const bobGroup = groups.find((g) => g.participants?.includes("spotify:bob"));

      expect(aliceGroup).toBeDefined();
      expect(bobGroup).toBeDefined();

      // Alice has 2 events grouped together
      expect(aliceGroup!.events.length).toBe(2);
      expect(aliceGroup!.type).toBe("session");
      expect(aliceGroup!.label).toBe("Example Band");
      expect(aliceGroup!.summary).toBe("2 tracks");

      // Bob has 1 event (single)
      expect(bobGroup!.events.length).toBe(1);
      expect(bobGroup!.type).toBe("single");
    });

    it("creates separate sessions when gap exceeds threshold", () => {
      const now = new Date("2024-01-15T12:00:00Z");
      const gapMinutes = SESSION_GAP_MINUTES["spotify-friends"];
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Track 1 by Example Band from Example Album",
          timestamp: now.toISOString(),
          people: JSON.stringify(["spotify:alice"]),
        }),
        makeEvent({
          id: 2,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Track 2 by Example Band from Example Album",
          // Gap exceeds threshold
          timestamp: new Date(now.getTime() + (gapMinutes + 1) * 60 * 1000).toISOString(),
          people: JSON.stringify(["spotify:alice"]),
        }),
      ];

      const groups = groupEvents(events);

      // Should have 2 separate single events due to gap
      expect(groups.length).toBe(2);
      expect(groups.every((g) => g.type === "single")).toBe(true);
    });

    it("generates label with multiple artists", () => {
      const now = new Date("2024-01-15T12:00:00Z");
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Track 1 by Example Band from Example Album",
          timestamp: now.toISOString(),
          people: JSON.stringify(["spotify:alice"]),
        }),
        makeEvent({
          id: 2,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Track 2 by Sample Artist from Sample Album",
          timestamp: new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
          people: JSON.stringify(["spotify:alice"]),
        }),
        makeEvent({
          id: 3,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Track 3 by Demo Musician from Demo Album",
          timestamp: new Date(now.getTime() + 4 * 60 * 1000).toISOString(),
          people: JSON.stringify(["spotify:alice"]),
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].label).toBe("Example Band, Sample Artist & more");
      expect(groups[0].summary).toBe("3 tracks");
    });

    it("generates label with exactly 2 artists without '& more'", () => {
      const now = new Date("2024-01-15T12:00:00Z");
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Track 1 by Example Band from Example Album",
          timestamp: now.toISOString(),
          people: JSON.stringify(["spotify:alice"]),
        }),
        makeEvent({
          id: 2,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Track 2 by Sample Artist from Sample Album",
          timestamp: new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
          people: JSON.stringify(["spotify:alice"]),
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      // With exactly 2 artists, should NOT say "& more"
      expect(groups[0].label).toBe("Example Band and Sample Artist");
    });

    it("generates generic label with 4+ artists", () => {
      const now = new Date("2024-01-15T12:00:00Z");
      const artists = ["Example Band", "Sample Artist", "Demo Musician", "Fictional Group"];
      const events: GroupableEvent[] = artists.map((artist, i) =>
        makeEvent({
          id: i + 1,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: `Track by ${artist} from Album`,
          timestamp: new Date(now.getTime() + i * 60 * 1000).toISOString(),
          people: JSON.stringify(["spotify:alice"]),
        })
      );

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      // 4+ artists uses generic label
      expect(groups[0].label).toBe("Example Band, Sample Artist & more");
    });

    it("handles empty content gracefully", () => {
      const now = new Date("2024-01-15T12:00:00Z");
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: null,
          timestamp: now.toISOString(),
          people: JSON.stringify(["spotify:alice"]),
        }),
        makeEvent({
          id: 2,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: null,
          timestamp: new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
          people: JSON.stringify(["spotify:alice"]),
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      // With no artist info, should fall back to generic label
      expect(groups[0].label).toBe("Listening session");
    });

    it("generates unique IDs for different friends at same timestamp", () => {
      const now = new Date("2024-01-15T12:00:00Z");
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Track 1 by Example Band from Example Album",
          timestamp: now.toISOString(),
          people: JSON.stringify(["spotify:alice"]),
        }),
        makeEvent({
          id: 2,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Track 1 by Sample Artist from Sample Album",
          timestamp: now.toISOString(), // Same timestamp as Alice
          people: JSON.stringify(["spotify:bob"]),
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(2);
      // IDs should be unique even with same timestamp
      const ids = groups.map((g) => g.id);
      expect(new Set(ids).size).toBe(2);
      // IDs should include the person identifier
      expect(ids.some((id) => id.includes("spotify:alice"))).toBe(true);
      expect(ids.some((id) => id.includes("spotify:bob"))).toBe(true);
    });

    it("handles missing people field gracefully", () => {
      const now = new Date("2024-01-15T12:00:00Z");
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Track by Example Band from Example Album",
          timestamp: now.toISOString(),
          people: null,
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].participants).toEqual(["unknown"]);
    });

    it("handles malformed people field (JSON string instead of array)", () => {
      const now = new Date("2024-01-15T12:00:00Z");
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Track by Example Band from Example Album",
          timestamp: now.toISOString(),
          people: JSON.stringify("not-an-array"), // String, not array
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      // Should fall back to "unknown", not return first character "n"
      expect(groups[0].participants).toEqual(["unknown"]);
    });

    it("handles malformed people field (JSON object instead of array)", () => {
      const now = new Date("2024-01-15T12:00:00Z");
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Track by Example Band from Example Album",
          timestamp: now.toISOString(),
          people: JSON.stringify({ user: "alice" }), // Object, not array
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].participants).toEqual(["unknown"]);
    });

    it("handles array with non-string elements", () => {
      const now = new Date("2024-01-15T12:00:00Z");
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "spotify-friends",
          type: "listen:track:friend",
          content: "Track by Example Band from Example Album",
          timestamp: now.toISOString(),
          people: JSON.stringify([123, null, "spotify:alice"]), // Mixed types
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      // Should skip non-strings and use first valid string
      expect(groups[0].participants).toEqual(["unknown"]);
    });
  });

  describe("regular spotify grouping", () => {
    it("groups by time proximity without person separation", () => {
      const now = new Date("2024-01-15T12:00:00Z");
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "spotify",
          type: "listen:track",
          content: "Example Track One by Example Band from Example Album",
          timestamp: now.toISOString(),
        }),
        makeEvent({
          id: 2,
          source: "spotify",
          type: "listen:track",
          content: "Example Track Two by Example Band from Example Album",
          timestamp: new Date(now.getTime() + 5 * 60 * 1000).toISOString(), // +5 min
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].events.length).toBe(2);
      expect(groups[0].label).toBe("Example Band");
    });
  });

  describe("message sources grouping", () => {
    it("groups messages by conversation title", () => {
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "discord",
          type: "message:dm",
          title: "Chat with Alice",
          content: "Hello",
          timestamp: "2024-01-15T12:00:00Z",
        }),
        makeEvent({
          id: 2,
          source: "discord",
          type: "message:dm",
          title: "Chat with Alice",
          content: "Hi there",
          timestamp: "2024-01-15T12:01:00Z",
        }),
        makeEvent({
          id: 3,
          source: "discord",
          type: "message:dm",
          title: "Chat with Bob",
          content: "Hey",
          timestamp: "2024-01-15T12:02:00Z",
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(2);
      const aliceChat = groups.find((g) => g.label === "Chat with Alice");
      const bobChat = groups.find((g) => g.label === "Chat with Bob");

      expect(aliceChat!.events.length).toBe(2);
      expect(aliceChat!.type).toBe("conversation");
      expect(bobChat!.events.length).toBe(1);
    });

    it("keeps same-title conversations separate when conversation_id differs", () => {
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "discord",
          type: "message:group",
          title: "general",
          conversation_id: "111111111111111111",
          timestamp: "2024-01-15T12:00:00Z",
        }),
        makeEvent({
          id: 2,
          source: "discord",
          type: "message:group",
          title: "general",
          conversation_id: "222222222222222222",
          timestamp: "2024-01-15T12:00:00Z",
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(2);
      // Same title and timestamp: ids must still be distinct
      expect(groups[0].id).not.toBe(groups[1].id);
      // The opaque conversation id never becomes the display label
      expect(groups.every((g) => g.label === "general")).toBe(true);
    });

    it("merges renamed conversations that share a conversation_id", () => {
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "discord",
          type: "message:group",
          title: "old-channel-name",
          conversation_id: "333333333333333333",
          timestamp: "2024-01-15T12:00:00Z",
        }),
        makeEvent({
          id: 2,
          source: "discord",
          type: "message:group",
          title: "new-channel-name",
          conversation_id: "333333333333333333",
          timestamp: "2024-01-15T12:01:00Z",
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].events.length).toBe(2);
      expect(groups[0].label).toBe("old-channel-name");
    });

    it("falls back to title grouping when conversation_id is null", () => {
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "facebook",
          type: "message:dm",
          title: "Chat with Alice",
          timestamp: "2024-01-15T12:00:00Z",
        }),
        makeEvent({
          id: 2,
          source: "facebook",
          type: "message:dm",
          title: "Chat with Alice",
          timestamp: "2024-01-15T12:01:00Z",
        }),
        makeEvent({
          id: 3,
          source: "facebook",
          type: "message:dm",
          title: "Chat with Bob",
          timestamp: "2024-01-15T12:02:00Z",
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(2);
      const aliceChat = groups.find((g) => g.label === "Chat with Alice");
      expect(aliceChat!.events.length).toBe(2);
    });

    it("counts a lone AI message without pluralizing", () => {
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "claude-code",
          type: "claude-code:message:user",
          title: "timeline",
          conversation_id: "777777777777777777",
          timestamp: "2024-01-15T09:00:00Z",
        }),
      ];

      const groups = groupEvents(events);

      expect(groups[0].summary).toBe("1 message (1 user, 0 assistant)");
    });

    it("lists only senders as participants, not the whole roster", () => {
      // Facebook puts the sender first and the rest of the thread after it, so
      // a group where only Alice spoke must not also credit Bob and Carol.
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "facebook",
          type: "message:dm",
          title: "Group chat",
          conversation_id: "conv-1",
          timestamp: "2024-01-15T12:00:00Z",
          people: JSON.stringify(["Alice", "Bob", "Carol"]),
        }),
        makeEvent({
          id: 2,
          source: "facebook",
          type: "message:dm",
          title: "Group chat",
          conversation_id: "conv-1",
          timestamp: "2024-01-15T12:01:00Z",
          people: JSON.stringify(["Bob", "Alice", "Carol"]),
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].participants).toEqual(["Alice", "Bob"]);
    });

    it("skips events whose people field is missing, malformed, or empty", () => {
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "discord",
          type: "message:group",
          title: "general",
          conversation_id: "conv-2",
          timestamp: "2024-01-15T12:00:00Z",
          people: null,
        }),
        makeEvent({
          id: 2,
          source: "discord",
          type: "message:group",
          title: "general",
          conversation_id: "conv-2",
          timestamp: "2024-01-15T12:01:00Z",
          people: JSON.stringify({ sender: "discord:1" }),
        }),
        makeEvent({
          id: 3,
          source: "discord",
          type: "message:group",
          title: "general",
          conversation_id: "conv-2",
          timestamp: "2024-01-15T12:02:00Z",
          people: JSON.stringify(["  ", "discord:2"]),
        }),
        makeEvent({
          id: 4,
          source: "discord",
          type: "message:group",
          title: "general",
          conversation_id: "conv-2",
          timestamp: "2024-01-15T12:03:00Z",
          people: JSON.stringify(["discord:3"]),
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].participants).toEqual(["discord:3"]);
    });

    it("splits one conversation into a card per exchange across an idle gap", () => {
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "discord",
          type: "message:dm",
          title: "Chat with Alice",
          conversation_id: "444444444444444444",
          timestamp: "2024-01-15T09:00:00Z",
        }),
        makeEvent({
          id: 2,
          source: "discord",
          type: "message:dm",
          title: "Chat with Alice",
          conversation_id: "444444444444444444",
          timestamp: "2024-01-15T09:30:00Z",
        }),
        makeEvent({
          id: 3,
          source: "discord",
          type: "message:dm",
          title: "Chat with Alice",
          conversation_id: "444444444444444444",
          timestamp: "2024-01-15T21:00:00Z",
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(2);
      expect(groups.every((g) => g.type === "conversation")).toBe(true);
      expect(groups.every((g) => g.label === "Chat with Alice")).toBe(true);
      expect(groups[0].id).not.toBe(groups[1].id);

      const morning = groups.find((g) => g.timeRange.start === "2024-01-15T09:00:00Z");
      expect(morning!.events.length).toBe(2);
      expect(morning!.timeRange.end).toBe("2024-01-15T09:30:00Z");

      const evening = groups.find((g) => g.timeRange.start === "2024-01-15T21:00:00Z");
      expect(evening!.events.length).toBe(1);
      expect(evening!.summary).toBe("1 message");
    });

    it("keeps messages together across a gap under the threshold", () => {
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "discord",
          type: "message:dm",
          title: "Chat with Alice",
          conversation_id: "555555555555555555",
          timestamp: "2024-01-15T09:00:00Z",
        }),
        makeEvent({
          id: 2,
          source: "discord",
          type: "message:dm",
          title: "Chat with Alice",
          conversation_id: "555555555555555555",
          timestamp: "2024-01-15T09:59:00Z",
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].events.length).toBe(2);
    });

    it("renders a thread as one card when splitConversations is off", () => {
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "discord",
          type: "message:dm",
          title: "Chat with Alice",
          conversation_id: "666666666666666666",
          timestamp: "2024-01-15T09:00:00Z",
        }),
        makeEvent({
          id: 2,
          source: "discord",
          type: "message:dm",
          title: "Chat with Alice",
          conversation_id: "666666666666666666",
          timestamp: "2024-01-15T21:00:00Z",
        }),
      ];

      const groups = groupEvents(events, { splitConversations: false });

      expect(groups.length).toBe(1);
      expect(groups[0].events.length).toBe(2);
      expect(groups[0].timeRange.start).toBe("2024-01-15T09:00:00Z");
      expect(groups[0].timeRange.end).toBe("2024-01-15T21:00:00Z");
    });

  });

  describe("single events", () => {
    it("treats unknown sources as single events", () => {
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "unknown-source",
          type: "some-type",
          title: "Event Title",
          timestamp: "2024-01-15T12:00:00Z",
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe("single");
      expect(groups[0].label).toBe("Event Title");
    });
  });

  describe("steam grouping", () => {
    it("groups game:added events with same timestamp into single session", () => {
      const ts = "2026-02-13T16:40:30.187Z";
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "steam", type: "steam:game:added", title: "Puzzle Lab", timestamp: ts }),
        makeEvent({ id: 2, source: "steam", type: "steam:game:added", title: "Physics Lab 2", timestamp: ts }),
        makeEvent({ id: 3, source: "steam", type: "steam:game:added", title: "Team Arena 2", timestamp: ts }),
        makeEvent({ id: 4, source: "steam", type: "steam:game:added", title: "Tactical Arena", timestamp: ts }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe("session");
      expect(groups[0].label).toBe("Puzzle Lab, Physics Lab 2 & 2 more");
      expect(groups[0].summary).toBe("4 games added");
    });

    it("groups achievements by game name", () => {
      const now = new Date("2024-10-21T12:48:00Z");
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "steam", type: "steam:achievement", title: "Steam power (Factory Builder)", timestamp: now.toISOString() }),
        makeEvent({ id: 2, source: "steam", type: "steam:achievement", title: "Research with automation (Factory Builder)", timestamp: new Date(now.getTime() + 3 * 60 * 1000).toISOString() }),
        makeEvent({ id: 3, source: "steam", type: "steam:achievement", title: "Pest control (Factory Builder)", timestamp: new Date(now.getTime() + 9 * 60 * 1000).toISOString() }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe("session");
      expect(groups[0].label).toBe("Factory Builder");
      expect(groups[0].summary).toBe("3 achievements");
    });

    it("shows single achievement as single event", () => {
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "steam", type: "steam:achievement", title: "A New Beginning (Tactical Arena 2)", timestamp: "2024-09-11T21:15:11.000Z" }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe("single");
    });

    it("handles unknown steam event types in mixed session", () => {
      const now = new Date("2024-10-21T12:48:00Z");
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "steam", type: "steam:game:added", title: "Puzzle Lab", timestamp: now.toISOString() }),
        makeEvent({ id: 2, source: "steam", type: "steam:playtime", title: "Puzzle Lab", timestamp: new Date(now.getTime() + 5 * 60 * 1000).toISOString() }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe("session");
      expect(groups[0].label).toBe("Steam");
      expect(groups[0].summary).toBe("1 game added, 1 event");
    });

    it("handles session with only unknown steam event types", () => {
      const now = new Date("2024-10-21T12:48:00Z");
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "steam", type: "steam:playtime", title: "Puzzle Lab", timestamp: now.toISOString() }),
        makeEvent({ id: 2, source: "steam", type: "steam:playtime", title: "Physics Lab 2", timestamp: new Date(now.getTime() + 5 * 60 * 1000).toISOString() }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe("session");
      expect(groups[0].label).toBe("Steam");
      expect(groups[0].summary).toBe("2 events");
    });

    it("keeps steam:session events separate from game:added events", () => {
      const now = new Date("2024-10-21T23:09:00Z");
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "steam", type: "steam:session", title: "Star Explorer", timestamp: now.toISOString(), duration_ms: 3600000 }),
        makeEvent({ id: 2, source: "steam", type: "steam:game:added", title: "Neon City", timestamp: new Date(now.getTime() + 1 * 60 * 1000).toISOString() }),
        makeEvent({ id: 3, source: "steam", type: "steam:game:added", title: "Orbital Factory", timestamp: new Date(now.getTime() + 1 * 60 * 1000).toISOString() }),
      ];

      const groups = groupEvents(events);

      // Session should be separate from the grouped additions
      expect(groups.length).toBe(2);
      const sessionGroup = groups.find(g => g.label === "Star Explorer");
      const addedGroup = groups.find(g => g.events.some(e => e.type === "steam:game:added"));

      expect(sessionGroup).toBeDefined();
      expect(sessionGroup!.type).toBe("single");
      expect(sessionGroup!.events.length).toBe(1);

      expect(addedGroup).toBeDefined();
      expect(addedGroup!.events.length).toBe(2);
      expect(addedGroup!.summary).toBe("2 games added");
    });

    it("renders steam:session as standalone single event", () => {
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "steam", type: "steam:session", title: "Rocket Workshop", timestamp: "2024-10-21T20:27:00Z", duration_ms: 2940000 }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe("single");
      expect(groups[0].label).toBe("Rocket Workshop");
    });

    it("labels achievements from multiple games", () => {
      const now = new Date("2024-10-21T12:48:00Z");
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "steam", type: "steam:achievement", title: "Lab Rat (Puzzle Lab)", timestamp: now.toISOString() }),
        makeEvent({ id: 2, source: "steam", type: "steam:achievement", title: "Wake Up Call (Puzzle Lab 2)", timestamp: new Date(now.getTime() + 5 * 60 * 1000).toISOString() }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].label).toBe("Puzzle Lab and Puzzle Lab 2");
      expect(groups[0].summary).toBe("2 achievements");
    });
  });

  describe("minecraft grouping", () => {
    it("groups nearby minecraft events into a session with type breakdown", () => {
      const now = new Date("2024-07-27T15:00:00Z");
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "minecraft", type: "minecraft:join", title: "paper-1.21", timestamp: now.toISOString() }),
        makeEvent({ id: 2, source: "minecraft", type: "minecraft:chat", title: "paper-1.21", timestamp: new Date(now.getTime() + 1 * 60 * 1000).toISOString() }),
        makeEvent({ id: 3, source: "minecraft", type: "minecraft:chat", title: "paper-1.21", timestamp: new Date(now.getTime() + 2 * 60 * 1000).toISOString() }),
        makeEvent({ id: 4, source: "minecraft", type: "minecraft:death", title: "paper-1.21", timestamp: new Date(now.getTime() + 5 * 60 * 1000).toISOString() }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe("session");
      expect(groups[0].label).toBe("paper-1.21");
      expect(groups[0].summary).toBe("2 messages, 1 death, 1 join");
    });

    it("separates events from different servers even with close timestamps", () => {
      const now = new Date("2024-07-27T15:00:00Z");
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "minecraft", type: "minecraft:chat", title: "paper-1.21", timestamp: now.toISOString() }),
        makeEvent({ id: 2, source: "minecraft", type: "minecraft:chat", title: "paper-1.21", timestamp: new Date(now.getTime() + 1 * 60 * 1000).toISOString() }),
        makeEvent({ id: 3, source: "minecraft", type: "minecraft:chat", title: "vanilla-1.20", timestamp: new Date(now.getTime() + 2 * 60 * 1000).toISOString() }),
        makeEvent({ id: 4, source: "minecraft", type: "minecraft:death", title: "vanilla-1.20", timestamp: new Date(now.getTime() + 3 * 60 * 1000).toISOString() }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(2);
      const paperGroup = groups.find(g => g.label === "paper-1.21");
      const vanillaGroup = groups.find(g => g.label === "vanilla-1.20");

      expect(paperGroup).toBeDefined();
      expect(paperGroup!.events.length).toBe(2);
      expect(paperGroup!.type).toBe("session");

      expect(vanillaGroup).toBeDefined();
      expect(vanillaGroup!.events.length).toBe(2);
      expect(vanillaGroup!.type).toBe("session");
    });

    it("splits sessions when gap exceeds threshold", () => {
      const now = new Date("2024-07-27T15:00:00Z");
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "minecraft", type: "minecraft:chat", title: "paper-1.21", timestamp: now.toISOString() }),
        makeEvent({ id: 2, source: "minecraft", type: "minecraft:chat", title: "paper-1.21", timestamp: new Date(now.getTime() + 20 * 60 * 1000).toISOString() }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(2);
      expect(groups.every(g => g.type === "single")).toBe(true);
    });
  });

  describe("journal grouping", () => {
    it("groups multiple journal:qa events into a single session", () => {
      const ts = "2024-01-15T23:59:00.000Z";
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "journal", type: "journal:qa", title: "What did you do today?", content: "Went for a walk", timestamp: ts }),
        makeEvent({ id: 2, source: "journal", type: "journal:qa", title: "How are you feeling?", content: "Good", timestamp: ts }),
        makeEvent({ id: 3, source: "journal", type: "journal:qa", title: "What are you grateful for?", content: "Sunshine", timestamp: ts }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe("session");
      expect(groups[0].source).toBe("journal");
      expect(groups[0].label).toBe("Journal");
      expect(groups[0].summary).toBe("3 Q&As");
      expect(groups[0].events.length).toBe(3);
    });

    it("includes reflection in summary when present", () => {
      const ts = "2024-01-15T23:59:00.000Z";
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "journal", type: "journal:qa", title: "What did you do?", content: "Coded", timestamp: ts }),
        makeEvent({ id: 2, source: "journal", type: "journal:qa", title: "How do you feel?", content: "Tired", timestamp: ts }),
        makeEvent({ id: 3, source: "journal", type: "journal:reflection", title: "Daily Reflection", content: "A productive day...", timestamp: ts }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe("session");
      expect(groups[0].summary).toBe("2 Q&As + 1 reflection");
    });

    it("keeps single journal event as single", () => {
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "journal", type: "journal:qa", title: "What did you do?", content: "Nothing", timestamp: "2024-01-15T23:59:00.000Z" }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe("single");
    });

    it("does not interfere with other source events", () => {
      const ts = "2024-01-15T23:59:00.000Z";
      const events: GroupableEvent[] = [
        makeEvent({ id: 1, source: "journal", type: "journal:qa", title: "Q1", content: "A1", timestamp: ts }),
        makeEvent({ id: 2, source: "journal", type: "journal:qa", title: "Q2", content: "A2", timestamp: ts }),
        makeEvent({ id: 3, source: "manual", type: "note", title: "A manual note", timestamp: "2024-01-15T12:00:00Z" }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(2);
      const journalGroup = groups.find(g => g.source === "journal");
      const manualGroup = groups.find(g => g.source === "manual");
      expect(journalGroup).toBeDefined();
      expect(journalGroup!.type).toBe("session");
      expect(manualGroup).toBeDefined();
      expect(manualGroup!.type).toBe("single");
    });
  });

  describe("sorting", () => {
    it("sorts groups by start time", () => {
      const events: GroupableEvent[] = [
        makeEvent({
          id: 1,
          source: "unknown",
          type: "test",
          title: "Later",
          timestamp: "2024-01-15T14:00:00Z",
        }),
        makeEvent({
          id: 2,
          source: "unknown",
          type: "test",
          title: "Earlier",
          timestamp: "2024-01-15T10:00:00Z",
        }),
      ];

      const groups = groupEvents(events);

      expect(groups[0].label).toBe("Earlier");
      expect(groups[1].label).toBe("Later");
    });
  });

  describe("swarm check-in grouping", () => {
    const now = new Date("2024-01-15T12:00:00Z");
    function makeCheckin(overrides: Partial<GroupableEvent> & { id: number }): GroupableEvent {
      return makeEvent({
        source: "swarm",
        type: "location:visit",
        ...overrides,
      });
    }

    it("merges check-ins close in both time and space into one visit", () => {
      const events = [
        makeCheckin({
          id: 1,
          title: "Checked in at Central Station",
          location_name: "Central Station",
          latitude: 50.0,
          longitude: 0.0,
          timestamp: now.toISOString(),
        }),
        makeCheckin({
          id: 2,
          title: "Checked in at Platform 2",
          location_name: "Platform 2",
          // ~55m away, 30s later — a nested-venue check-in
          latitude: 50.0005,
          longitude: 0.0,
          timestamp: new Date(now.getTime() + 30 * 1000).toISOString(),
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].type).toBe("session");
      expect(groups[0].label).toBe("Central Station · Platform 2");
      expect(groups[0].summary).toBe("2 check-ins");
    });

    it("keeps check-ins close in time but far apart as separate visits", () => {
      const events = [
        makeCheckin({
          id: 1,
          location_name: "Central Station",
          latitude: 50.0,
          longitude: 0.0,
          timestamp: now.toISOString(),
        }),
        makeCheckin({
          id: 2,
          location_name: "Riverside Station",
          // ~5.5km away, 10 min later — a journey hop, not a nested venue
          latitude: 50.05,
          longitude: 0.0,
          timestamp: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(2);
      expect(groups.every((g) => g.type === "single")).toBe(true);
    });

    it("does not merge check-ins missing coordinates", () => {
      const events = [
        makeCheckin({
          id: 1,
          location_name: "Central Station",
          latitude: 50.0,
          longitude: 0.0,
          timestamp: now.toISOString(),
        }),
        makeCheckin({
          id: 2,
          location_name: null,
          latitude: null,
          longitude: null,
          timestamp: new Date(now.getTime() + 30 * 1000).toISOString(),
        }),
      ];

      const groups = groupEvents(events);

      expect(groups.length).toBe(2);
      expect(groups.every((g) => g.type === "single")).toBe(true);
    });

    it("labels three or more venues as first venue plus a count", () => {
      const events = [0, 1, 2].map((i) =>
        makeCheckin({
          id: i + 1,
          location_name: ["Central Station", "Platform 2", "Coffee Kiosk"][i],
          latitude: 50.0 + i * 0.0002,
          longitude: 0.0,
          timestamp: new Date(now.getTime() + i * 60 * 1000).toISOString(),
        }),
      );

      const groups = groupEvents(events);

      expect(groups.length).toBe(1);
      expect(groups[0].label).toBe("Central Station · 2 more");
      expect(groups[0].summary).toBe("3 check-ins");
    });
  });
});
