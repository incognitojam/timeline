import { Database } from "../../db/sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initDb } from "../../db/schema";
import { COUNT_POLL_VOTER_CANDIDATES, FIND_POLL_VOTER_CANDIDATES, PENDING_POLL_VOTERS_INDEX, PENDING_POLL_VOTERS_WHERE } from "./poll-voter-queries";
import type { PollVoter } from "./shared/forward";
import { DiscordClient, DiscordAuthenticationError, PollVotersUnavailableError } from "./client";
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

  test("records unavailable when a later voter page is inaccessible", async () => {
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

      expect(stats).toEqual({ captured: 0, failed: 1, remaining: 0 });
      expect(storedVoters("800000000000000202")).toEqual({ status: "unavailable", reason: "Discord returned HTTP 403", http_status: 403, recorded_at: expect.any(String) });
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

  test("both queries use the pending index without a temporary sort", () => {
  for (const [sql, params] of [
    [FIND_POLL_VOTER_CANDIDATES, [ACCOUNT, new Date().toISOString(), 25]],
    [COUNT_POLL_VOTER_CANDIDATES, [ACCOUNT, new Date().toISOString()]],
  ] as const) {
    const plan = db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
    expect(plan.some(row => row.detail.includes(PENDING_POLL_VOTERS_INDEX))).toBe(true);
    expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
  }
 });

 test("polls on ordinary message types age into eligibility without a write and leave the index after capture", async () => {
  insertPoll("legacy", poll({ expiry: "2026-01-02T00:00:00.000Z" }));
  db.exec("UPDATE events SET type = 'message:guild'");
  const find = db.query(FIND_POLL_VOTER_CANDIDATES);
  expect(find.all(ACCOUNT, "2026-01-01T00:00:00.000Z", 25)).toHaveLength(0);
  expect(find.all(ACCOUNT, "2026-01-03T00:00:00.000Z", 25)).toHaveLength(1);
  let requests = 0;
  const client = { fetchPollAnswerVoters: async () => { requests++; return []; } };
  expect(await captureExpiredPollVoters(client, db, ACCOUNT)).toEqual({ captured: 1, failed: 0, remaining: 0 });
  expect(db.query(`SELECT source_id FROM events INDEXED BY ${PENDING_POLL_VOTERS_INDEX} WHERE ${PENDING_POLL_VOTERS_WHERE}`).all()).toHaveLength(0);
  expect(await captureExpiredPollVoters(client, db, ACCOUNT)).toEqual({ captured: 0, failed: 0, remaining: 0 });
  expect(requests).toBe(2);
 });

});

test("malformed archived payloads remain stored without breaking index initialization or sweeps", async () => {
  db.exec(`DROP INDEX ${PENDING_POLL_VOTERS_INDEX}`);
  db.exec("INSERT INTO events(source,source_id,source_account,type,raw_data) VALUES('discord','malformed','user-1','message:dm','not json')");
  initDb(db);
  db.exec("INSERT INTO events(source,source_id,source_account,type,raw_data) VALUES('discord','also-malformed','user-1','message:dm','{')");
  const stats = await captureExpiredPollVoters({ fetchPollAnswerVoters: async () => { throw new Error("must not request malformed payloads"); } }, db, ACCOUNT);
  expect(stats).toEqual({ captured: 0, failed: 0, remaining: 0 });
  expect(db.query("SELECT raw_data FROM events WHERE source_id='malformed'").get()).toEqual({raw_data: "not json"});
});

for (const permanent of [true, false]) {
  test(`25 ${permanent ? "permanent" : "transient"} failures do not starve an older poll`, async () => {
    insertPoll("older", poll(), "2025-01-01T00:00:00.000Z");
    for (let i = 0; i < 25; i++) insertPoll(`newer-${i}`, poll());
    const requested: string[] = [];
    const client = { fetchPollAnswerVoters: async (_channel: string, id: string) => {
      requested.push(id);
      if (id.startsWith("newer")) throw permanent ? new PollVotersUnavailableError(403) : new Error("temporary failure");
      return [];
    } };
    expect(await captureExpiredPollVoters(client, db, ACCOUNT)).toEqual({captured: 0, failed: 25, remaining: permanent ? 1 : 26});
    requested.length = 0;
    await captureExpiredPollVoters(client, db, ACCOUNT);
    expect(requested[0]).toBe("older");
    expect(storedVoters("older")).toEqual({ captured_at: expect.any(String), answers: {"1": [], "2": []} });
    if (permanent) {
      expect(requested).toEqual(["older", "older"]);
      requested.length = 0;
      await captureExpiredPollVoters(client, db, ACCOUNT);
      expect(requested).toEqual([]);
    }
  });
}

test("aborting does not complete or defer a poll", async () => {
  insertPoll("abort", poll());
  await expect(captureExpiredPollVoters({ fetchPollAnswerVoters: async () => { throw new DOMException("cancelled", "AbortError"); } }, db, ACCOUNT)).rejects.toThrow("cancelled");
  expect(storedVoters("abort")).toBeNull();
  expect(db.query("SELECT json_extract(raw_data, '$.poll.voter_attempted_at') AS attempted FROM events").get()).toEqual({attempted: null});
});

test("initialization upgrades the old pending index to support fair retries", () => {
  db.exec(`DROP INDEX ${PENDING_POLL_VOTERS_INDEX}`);
  db.exec(`CREATE INDEX ${PENDING_POLL_VOTERS_INDEX} ON events(source_account, timestamp DESC, source_id) WHERE ${PENDING_POLL_VOTERS_WHERE}`);
  initDb(db);
  const plan = db.query(`EXPLAIN QUERY PLAN ${FIND_POLL_VOTER_CANDIDATES}`).all(ACCOUNT, new Date().toISOString(), 25) as {detail: string}[];
  expect(plan.some(row => row.detail.includes("TEMP B-TREE"))).toBe(false);
});

test("a rejected token stops the sweep without marking any polls", async () => {
  insertPoll("first", poll()); insertPoll("second", poll());
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return new Response(null, {status: 401}); }) as unknown as typeof fetch;
  try {
    await expect(captureExpiredPollVoters(new DiscordClient("test-token"), db, ACCOUNT)).rejects.toBeInstanceOf(DiscordAuthenticationError);
    expect(requests).toBe(1);
    expect(storedVoters("first")).toBeNull(); expect(storedVoters("second")).toBeNull();
    expect(db.query("SELECT count(*) AS n FROM events WHERE json_extract(raw_data, '$.poll.voter_attempted_at') IS NOT NULL").get()).toEqual({n: 0});
  } finally { globalThis.fetch = original; }
});
