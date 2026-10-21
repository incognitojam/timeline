import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initDb } from "../../db/schema";
import { DiscordClient, type PollVoter } from "./client";
import {
  captureExpiredPollVoters,
  POLL_VOTER_CAPTURE_LIMIT,
} from "./poll-voters";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initDb(db);
});

afterEach(() => db.close());

const ACCOUNT = "user-1";
const CHANNEL_ID = "800000000000000001";

function insertPoll(
  sourceId: string,
  poll: Record<string, unknown>,
  timestamp = "2026-01-01T00:00:00.000Z",
): void {
  db.prepare(
    `INSERT INTO events (source, source_id, source_account, type, timestamp, title, raw_data, conversation_id)
     VALUES ('discord', ?, ?, 'message:guild:poll', ?, 'Poll', json(?), ?)`,
  ).run(
    sourceId,
    ACCOUNT,
    timestamp,
    JSON.stringify({ _channel: { id: CHANNEL_ID }, poll }),
    CHANNEL_ID,
  );
}

function storedVoters(sourceId: string): unknown {
  const row = db.prepare(
    "SELECT json_extract(raw_data, '$.poll.voters') AS voters FROM events WHERE source_id = ?",
  ).get(sourceId) as { voters: string | null };
  return row.voters ? JSON.parse(row.voters) : null;
}

function poll(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expiry: "2020-01-01T00:00:00.000Z",
    answers: [
      { answer_id: 1, poll_media: { text: "One" } },
      { answer_id: 2, poll_media: { text: "Two" } },
    ],
    ...overrides,
  };
}

describe("captureExpiredPollVoters", () => {
  test("captures ended and finalized polls but leaves open and captured polls untouched", async () => {
    insertPoll("800000000000000101", poll());
    insertPoll("800000000000000102", poll({ expiry: "2999-01-01T00:00:00.000Z" }));
    insertPoll("800000000000000103", poll({ expiry: null, results: { is_finalized: true } }));
    insertPoll("800000000000000104", poll({ voters: { captured_at: "2026-01-01T00:00:00.000Z", answers: {} } }));
    const calls: Array<{ messageId: string; answerId: number }> = [];
    const client = {
      fetchPollAnswerVoters: async (_channelId: string, messageId: string, answerId: number) => {
        calls.push({ messageId, answerId });
        return answerId === 1
          ? [{ id: "voter-1", name: "Alice", username: "alice", avatar: "aaaa1111" }]
          : [];
      },
    };

    const stats = await captureExpiredPollVoters(client, db, ACCOUNT);

    expect(stats).toEqual({ captured: 2, failed: 0, remaining: 0 });
    expect(calls).toEqual([
      { messageId: "800000000000000101", answerId: 1 },
      { messageId: "800000000000000101", answerId: 2 },
      { messageId: "800000000000000103", answerId: 1 },
      { messageId: "800000000000000103", answerId: 2 },
    ]);
    expect(storedVoters("800000000000000101")).toEqual({
      captured_at: expect.any(String),
      answers: {
        "1": [{ id: "voter-1", name: "Alice", username: "alice", avatar: "aaaa1111" }],
        "2": [],
      },
    });
    expect(storedVoters("800000000000000102")).toBeNull();
    expect(storedVoters("800000000000000104")).toEqual({
      captured_at: "2026-01-01T00:00:00.000Z",
      answers: {},
    });
  });

  test("leaves a poll unmarked when any answer fetch fails", async () => {
    insertPoll("800000000000000201", poll());
    const client = {
      fetchPollAnswerVoters: async (_channelId: string, _messageId: string, answerId: number): Promise<PollVoter[]> => {
        if (answerId === 2) throw new Error("temporary API failure");
        return [{ id: "voter-1", name: "Alice", username: "alice", avatar: null }];
      },
    };

    const stats = await captureExpiredPollVoters(client, db, ACCOUNT);

    expect(stats).toEqual({ captured: 0, failed: 1, remaining: 1 });
    expect(storedVoters("800000000000000201")).toBeNull();
  });

  test("leaves a poll unmarked when a later voter page is inaccessible", async () => {
    insertPoll("800000000000000202", poll({ answers: [{ answer_id: 1, poll_media: { text: "One" } }] }));
    const originalFetch = globalThis.fetch;
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `900000000000000${String(index).padStart(3, "0")}`,
      username: `user-${index}`,
      global_name: null,
      avatar: "aaaa1111",
    }));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      return url.searchParams.has("after")
        ? new Response(null, { status: 403 })
        : new Response(JSON.stringify({ users: firstPage }));
    }) as unknown as typeof fetch;

    try {
      const stats = await captureExpiredPollVoters(new DiscordClient("test-token"), db, ACCOUNT);

      expect(stats).toEqual({ captured: 0, failed: 1, remaining: 1 });
      expect(storedVoters("800000000000000202")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("captures newer polls before older candidates", async () => {
    const olderId = "800000000000000203";
    const newerId = "800000000000000204";
    insertPoll(olderId, poll({ answers: [{ answer_id: 1, poll_media: { text: "One" } }] }), "2026-01-01T00:00:00.000Z");
    insertPoll(newerId, poll({ answers: [{ answer_id: 1, poll_media: { text: "One" } }] }), "2026-01-02T00:00:00.000Z");
    const captured: string[] = [];
    const client = {
      fetchPollAnswerVoters: async (_channelId: string, messageId: string): Promise<PollVoter[]> => {
        captured.push(messageId);
        return [];
      },
    };

    const stats = await captureExpiredPollVoters(client, db, ACCOUNT);

    expect(stats).toEqual({ captured: 2, failed: 0, remaining: 0 });
    expect(captured).toEqual([newerId, olderId]);
  });

  test("caps each sweep at 25 polls", async () => {
    for (let index = 0; index <= POLL_VOTER_CAPTURE_LIMIT; index++) {
      insertPoll(`800000000000000${String(300 + index).padStart(3, "0")}`, poll({ answers: [] }));
    }
    let calls = 0;
    const client = {
      fetchPollAnswerVoters: async (): Promise<PollVoter[]> => {
        calls++;
        return [];
      },
    };

    const stats = await captureExpiredPollVoters(client, db, ACCOUNT);

    expect(stats).toEqual({ captured: POLL_VOTER_CAPTURE_LIMIT, failed: 0, remaining: 1 });
    expect(calls).toBe(0);
  });
});
