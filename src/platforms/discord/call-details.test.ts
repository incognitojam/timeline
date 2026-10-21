import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initDb } from "../../db/schema";
import {
  DISCORD_CALL_DETAIL_REFRESH_LIMIT,
  refreshIncompleteCallDetails,
} from "./call-details";
import type { NormalizedMessage } from "./client";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initDb(db);
});

afterEach(() => db.close());

const ACCOUNT = "user-1";
const CHANNEL = "800000000000000001";

function insertCall(
  messageId: string,
  options: {
    importBatch?: string;
    endedTimestamp?: string;
    omitCall?: boolean;
    timestamp?: string;
  } = {},
): void {
  db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, title,
      people, raw_data, import_batch, conversation_id
    ) VALUES ('discord', ?, ?, 'message:dm:call', ?,
      'Alice', '["discord:alice"]', json(?), ?, ?)
  `).run(
    messageId,
    ACCOUNT,
    options.timestamp ?? "2026-01-01T10:00:00.000Z",
    JSON.stringify({
      call: options.omitCall
        ? undefined
        : {
            participants: [ACCOUNT, "user-2"],
            ended_timestamp: options.endedTimestamp,
          },
      _channel: { id: CHANNEL },
    }),
    options.importBatch ?? "older-batch",
    CHANNEL,
  );
}

function freshCall(messageId: string, endedTimestamp?: string): NormalizedMessage {
  return {
    id: messageId,
    type: "Call",
    timestamp: "2026-01-01T10:00:00.000Z",
    timestampEdited: null,
    content: "",
    author: {
      id: "user-2",
      name: "alice",
      nickname: "Alice",
      isBot: false,
      avatarUrl: null,
    },
    attachments: [],
    embeds: [],
    reactions: [],
    mentions: [],
    call: { participants: [ACCOUNT, "user-2"], endedTimestamp },
    rawType: 3,
  };
}

function storedCall(messageId: string): { participants: string[]; ended_timestamp?: string } {
  const row = db.prepare(
    "SELECT json_extract(raw_data, '$.call') AS call FROM events WHERE source_id = ?",
  ).get(messageId) as { call: string };
  return JSON.parse(row.call);
}

describe("refreshIncompleteCallDetails", () => {
  test("stores the end timestamp supplied after an active call finishes", async () => {
    insertCall("800000000000000101");
    const unavailable = new Set<string>();
    const client = {
      fetchMessage: async (_channelId: string, messageId: string) =>
        freshCall(messageId, "2026-01-01T10:03:12.000Z"),
    };

    const stats = await refreshIncompleteCallDetails(client, db, ACCOUNT, unavailable);

    expect(stats).toEqual({ attempted: 1, updated: 1, pending: 0, unavailable: 0, failed: 0 });
    expect(storedCall("800000000000000101")).toEqual({
      participants: [ACCOUNT, "user-2"],
      ended_timestamp: "2026-01-01T10:03:12.000Z",
    });

    const second = await refreshIncompleteCallDetails(client, db, ACCOUNT, unavailable);
    expect(second.attempted).toBe(0);
  });

  test("recovers the whole call object when the original payload omitted it", async () => {
    insertCall("800000000000000106", { omitCall: true });
    const unavailable = new Set<string>();
    const client = {
      fetchMessage: async (_channelId: string, messageId: string) => freshCall(messageId),
    };

    const stats = await refreshIncompleteCallDetails(client, db, ACCOUNT, unavailable);

    expect(stats).toEqual({ attempted: 1, updated: 1, pending: 1, unavailable: 0, failed: 0 });
    expect(storedCall("800000000000000106")).toEqual({ participants: [ACCOUNT, "user-2"] });
  });

  test("defers calls from the current import batch until the next sync", async () => {
    insertCall("800000000000000102", { importBatch: "current-batch" });
    let requests = 0;
    const client = {
      fetchMessage: async (channelId: string, messageId: string) => {
        requests++;
        return freshCall(messageId);
      },
    };

    const stats = await refreshIncompleteCallDetails(client, db, ACCOUNT, new Set(), {
      currentImportBatch: "current-batch",
    });

    expect(stats.attempted).toBe(0);
    expect(requests).toBe(0);
  });

  test("remembers unavailable calls but retries active calls and transient failures", async () => {
    insertCall("800000000000000103");
    insertCall("800000000000000104");
    insertCall("800000000000000105");
    const unavailable = new Set<string>();
    const failures = new Set(["800000000000000105"]);
    const client = {
      fetchMessage: async (_channelId: string, messageId: string) => {
        if (failures.has(messageId)) throw new Error("temporary failure");
        if (messageId === "800000000000000104") return null;
        return freshCall(messageId);
      },
    };

    const first = await refreshIncompleteCallDetails(client, db, ACCOUNT, unavailable);
    expect(first).toEqual({ attempted: 3, updated: 0, pending: 1, unavailable: 1, failed: 1 });
    expect(unavailable).toEqual(new Set(["800000000000000104"]));

    failures.clear();
    const second = await refreshIncompleteCallDetails(client, db, ACCOUNT, unavailable);
    expect(second).toEqual({ attempted: 2, updated: 0, pending: 2, unavailable: 0, failed: 0 });
    expect(unavailable).toEqual(new Set(["800000000000000104"]));
  });

  test("caps each recovery sweep", async () => {
    for (let index = 0; index <= DISCORD_CALL_DETAIL_REFRESH_LIMIT; index++) {
      insertCall(`800000000000000${String(200 + index).padStart(3, "0")}`);
    }
    const client = {
      fetchMessage: async (_channelId: string, messageId: string) => freshCall(messageId),
    };

    const stats = await refreshIncompleteCallDetails(client, db, ACCOUNT, new Set());

    expect(stats.attempted).toBe(DISCORD_CALL_DETAIL_REFRESH_LIMIT);
  });

  test("prioritizes the oldest incomplete calls", async () => {
    insertCall("800000000000000301", { timestamp: "2026-01-02T10:00:00.000Z" });
    insertCall("800000000000000302", { timestamp: "2026-01-01T10:00:00.000Z" });
    const requests: string[] = [];
    const client = {
      fetchMessage: async (_channelId: string, messageId: string) => {
        requests.push(messageId);
        return freshCall(messageId);
      },
    };

    await refreshIncompleteCallDetails(client, db, ACCOUNT, new Set(), { limit: 1 });

    expect(requests).toEqual(["800000000000000302"]);
  });
});
