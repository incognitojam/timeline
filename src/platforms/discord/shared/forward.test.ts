import { describe, expect, it } from "bun:test";
import { type DiscordPoll, type StoredPollVoters, parseDiscordPoll } from "./forward";

type StoredPoll = DiscordPoll & {
  voters?: StoredPollVoters;
};

function buildPoll(overrides: Partial<StoredPoll> = {}): StoredPoll {
  return {
    question: { text: "pineapple on pizza" },
    answers: [
      { answer_id: 1, poll_media: { text: "yes", emoji: { id: null, name: "🔴" } } },
      { answer_id: 2, poll_media: { text: "no", emoji: { id: null, name: "🟢" } } },
    ],
    expiry: "2020-01-02T00:00:00.000Z",
    allow_multiselect: false,
    layout_type: 1,
    results: {
      is_finalized: true,
      answer_counts: [
        { id: 1, count: 3, me_voted: true },
        { id: 2, count: 1, me_voted: false },
      ],
    },
    ...overrides,
  };
}

describe("parseDiscordPoll", () => {
  it("parses serialized raw_data.poll into the structured poll and voters", () => {
    const parsed = parseDiscordPoll(JSON.stringify({
      poll: buildPoll({
        voters: {
          captured_at: "2020-01-02T00:00:00.000Z",
          answers: {
            "1": [{ id: "111", name: "Alice", username: "alice", avatar: null }],
          },
        },
      }),
    }));

    expect(parsed?.poll.question.text).toBe("pineapple on pizza");
    expect(parsed?.poll.answers).toHaveLength(2);
    expect(parsed?.votersByAnswerId.get("1")?.[0]?.name).toBe("Alice");
  });

  it("returns null when raw data has no poll", () => {
    expect(parseDiscordPoll(JSON.stringify({ content: "hello" }))).toBeNull();
  });

  it("returns null for malformed serialized raw data", () => {
    expect(parseDiscordPoll("not json")).toBeNull();
  });

});
