import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initDb } from "../../db/schema";
import {
  type DiscordClient,
  type DiscordPoll,
  dateToSnowflake,
  type NormalizedMessage,
  type NormalizedReaction,
  type ReactionUser,
} from "./client";
import { BAND_PRECHECK_SQL, reactionsEqual, rescanReactionTiers, type TierCursors } from "./tier-rescan";

let db: Database;

function setup(): void {
  db = new Database(":memory:");
  initDb(db);
}

function teardown(): void {
  db.close();
}

beforeEach(setup);
afterEach(teardown);

const ACCOUNT = "test-user-id";

interface InsertEventOptions {
  id: string;
  timestamp: string;
  reactions?: NormalizedReaction[];
  poll?: DiscordPoll;
}

function insertDiscordEvent(opts: InsertEventOptions): number {
  const rawData = {
    id: opts.id,
    content: "hello",
    timestamp: opts.timestamp,
    reactions: opts.reactions ?? [],
    poll: opts.poll,
    other_field: "preserved",
    _channel: { id: "channel-1", guild_id: null },
  };
  const result = db
    .prepare(
      `INSERT INTO events (source, source_id, source_account, type, timestamp, title, raw_data, conversation_id)
       VALUES ('discord', ?, ?, 'message:guild', ?, 'test', ?, 'channel-1')`,
    )
    .run(opts.id, ACCOUNT, opts.timestamp, JSON.stringify(rawData));
  return Number(result.lastInsertRowid);
}

function buildMsg(
  id: string,
  timestamp: string,
  reactions: NormalizedMessage["reactions"] = [],
): NormalizedMessage {
  return {
    id,
    type: "Default",
    rawType: 0,
    timestamp,
    timestampEdited: null,
    content: "hello",
    author: {
      id: "author-1",
      name: "alice",
      nickname: null,
      isBot: false,
      avatarUrl: null,
    },
    attachments: [],
    embeds: [],
    reactions,
    mentions: [],
  };
}

// Minimal fake client. fetchMessagesInRange drives the rescan; the capture
// tier additionally calls fetchAllReactionUsers, which we resolve from an
// optional emoji-name → reactors lookup (defaulting to no reactors).
function fakeClient(
  messagesByChannel: Map<string, NormalizedMessage[]>,
  usersByEmoji?: Record<string, ReactionUser[]>,
): DiscordClient {
  const client = {
    fetchMessagesInRange: async function* (
      channelId: string,
      afterSnowflake: string,
      beforeSnowflake: string,
      handlers?: { onComplete?: () => void },
    ): AsyncGenerator<NormalizedMessage[]> {
      const all = messagesByChannel.get(channelId) ?? [];
      const afterBig = BigInt(afterSnowflake);
      const beforeBig = BigInt(beforeSnowflake);
      const filtered = all.filter((m) => {
        const idBig = BigInt(m.id);
        return idBig > afterBig && idBig < beforeBig;
      });
      if (filtered.length > 0) yield filtered;
      handlers?.onComplete?.();
    },
    checkMessagePresence: async (channelId: string, messageId: string) => {
      const message = (messagesByChannel.get(channelId) ?? []).find((item) => item.id === messageId);
      return message ? { kind: "found" as const, message } : { kind: "missing" as const };
    },
    fetchAllReactionUsers: async (
      _channelId: string,
      _messageId: string,
      reactions: NormalizedReaction[],
    ): Promise<NormalizedReaction[]> =>
      reactions.map((r) => ({ ...r, users: usersByEmoji?.[r.emoji.name] ?? [] })),
  };
  return client as unknown as DiscordClient;
}

function emptyCursors(): TierCursors {
  return { "1h": {}, "6h": {}, "24h": {}, "7d": {} };
}

describe("rescanReactionTiers", () => {
  test("first encounter: records threshold, makes no API call", async () => {
    const cursors = emptyCursors();
    const client = fakeClient(new Map());

    const stats = await rescanReactionTiers(
      client,
      db,
      cursors,
      ["channel-1"],
      { "channel-1": dateToSnowflake(new Date()) },
      ACCOUNT,
    );

    expect(stats.channelsChecked).toBe(0);
    expect(stats.channelsSkipped).toBe(4); // skipped at each tier
    expect(cursors["1h"]["channel-1"]).toBeDefined();
    expect(cursors["6h"]["channel-1"]).toBeDefined();
    expect(cursors["24h"]["channel-1"]).toBeDefined();
    expect(cursors["7d"]["channel-1"]).toBeDefined();
  });

  test("self-seeds a tier bucket missing from the cursors map", async () => {
    // A cursors map missing the 6h bucket entirely — the shape you'd get on the
    // first sync after a new tier joins TIERS. The rescan must seed it and
    // first-encounter, not throw on an undefined bucket.
    const cursors: TierCursors = { "24h": {}, "7d": {} };
    const client = fakeClient(new Map());

    const stats = await rescanReactionTiers(
      client,
      db,
      cursors,
      ["channel-1"],
      { "channel-1": dateToSnowflake(new Date()) },
      ACCOUNT,
    );

    expect(stats.channelsSkipped).toBe(4); // incl. the seeded 1h + 6h tiers
    expect(cursors["1h"]["channel-1"]).toBeDefined();
    expect(cursors["6h"]["channel-1"]).toBeDefined();
  });

  test("new earlier tier repairs the gap from an existing later-tier cursor", async () => {
    const messageTs = new Date(Date.now() - 2 * 3600_000);
    const messageId = dateToSnowflake(messageTs);
    insertDiscordEvent({ id: messageId, timestamp: messageTs.toISOString() });

    const cursors: TierCursors = {
      "6h": { "channel-1": dateToSnowflake(new Date(Date.now() - 7 * 3600_000)) },
      "24h": { "channel-1": dateToSnowflake(new Date()) },
      "7d": { "channel-1": dateToSnowflake(new Date()) },
    };
    const messages = new Map<string, NormalizedMessage[]>([
      [
        "channel-1",
        [buildMsg(messageId, messageTs.toISOString(), [{ emoji: { id: null, name: "👍" }, count: 1 }])],
      ],
    ]);

    const stats = await rescanReactionTiers(
      fakeClient(messages, { "👍": [{ id: "user-2", name: "Bob" }] }),
      db,
      cursors,
      ["channel-1"],
      { "channel-1": messageId },
      ACCOUNT,
    );

    expect(stats.reactionsUpdated).toBe(1);
    const row = db.prepare(
      "SELECT json_extract(raw_data, '$.reactions') AS reactions FROM events WHERE source_id = ?",
    ).get(messageId) as { reactions: string };
    expect(JSON.parse(row.reactions)).toEqual([
      {
        emoji: { id: null, name: "👍" },
        count: 1,
        users: [{ id: "user-2", name: "Bob" }],
      },
    ]);
  });

  test("skips channel with no high-water cursor", async () => {
    const cursors: TierCursors = {
      "6h": {},
      "24h": { "channel-1": dateToSnowflake(new Date(Date.now() - 25 * 3600_000)) },
      "7d": {},
    };
    const client = fakeClient(new Map());

    const stats = await rescanReactionTiers(client, db, cursors, ["channel-1"], {}, ACCOUNT);

    expect(stats.channelsChecked).toBe(0);
    expect(stats.messagesReFetched).toBe(0);
  });

  test("capture tier re-fetches band, stores reactions + reactors, records observation", async () => {
    const messageTs = new Date(Date.now() - 26 * 3600_000); // ~26h old → crosses 24h only
    const messageId = dateToSnowflake(messageTs);
    insertDiscordEvent({
      id: messageId,
      timestamp: messageTs.toISOString(),
      reactions: [{ emoji: { id: null, name: "👍" }, count: 1 }], // stored initial count
    });

    // Simulate: 24h cursor is 30h ago, so the message has just crossed the 24h threshold.
    const cursors: TierCursors = {
      "6h": { "channel-1": dateToSnowflake(new Date(Date.now() - 7 * 3600_000)) },
      "24h": { "channel-1": dateToSnowflake(new Date(Date.now() - 30 * 3600_000)) },
      "7d": { "channel-1": dateToSnowflake(new Date(Date.now() - 8 * 24 * 3600_000)) },
    };

    // Channel high-water = messageId (we've seen this message)
    const channelHigh = { "channel-1": messageId };

    // API now reports 3 reactions (was 1 at initial sync); the capture tier
    // additionally fetches who reacted.
    const apiReactions = [{ emoji: { id: null, name: "👍" }, count: 3 }];
    const reactors: ReactionUser[] = [
      { id: "u1", name: "Alice" },
      { id: "u2", name: "Bob" },
      { id: "u3", name: "Carol" },
    ];
    const messagesByChannel = new Map<string, NormalizedMessage[]>();
    messagesByChannel.set("channel-1", [buildMsg(messageId, messageTs.toISOString(), apiReactions)]);

    const client = fakeClient(messagesByChannel, { "👍": reactors });
    const stats = await rescanReactionTiers(client, db, cursors, ["channel-1"], channelHigh, ACCOUNT);

    expect(stats.channelsChecked).toBeGreaterThan(0);
    expect(stats.messagesReFetched).toBeGreaterThanOrEqual(1);
    expect(stats.reactionsUpdated).toBeGreaterThanOrEqual(1);
    expect(stats.observationsRecorded).toBeGreaterThanOrEqual(1);

    // raw_data.reactions reflects the API count AND the captured reactors.
    const row = db
      .prepare(
        "SELECT json_extract(raw_data, '$.reactions') AS r, json_extract(raw_data, '$.other_field') AS other FROM events WHERE source_id = ?",
      )
      .get(messageId) as { r: string; other: string };
    expect(JSON.parse(row.r)).toEqual([
      { emoji: { id: null, name: "👍" }, count: 3, users: reactors },
    ]);
    expect(row.other).toBe("preserved");

    // 24h tier observation row exists with total_count = 3
    const obs = db
      .prepare(
        "SELECT total_count, tier FROM discord_reaction_observations WHERE tier = '24h'",
      )
      .all() as Array<{ total_count: number; tier: string }>;
    expect(obs.length).toBe(1);
    expect(obs[0].total_count).toBe(3);
  });

  test("24h tier: unchanged count with stored users → no fetch/write, users preserved", async () => {
    // Authors are captured at first sync now. When the count is unchanged at
    // 24h, we must NOT refetch or write (the old behavior did an unconditional
    // capture here) — the stored users stay intact.
    const messageTs = new Date(Date.now() - 26 * 3600_000); // crosses 24h only
    const messageId = dateToSnowflake(messageTs);
    const stored: ReactionUser[] = [
      { id: "u1", name: "Alice" },
      { id: "u2", name: "Bob" },
    ];
    insertDiscordEvent({
      id: messageId,
      timestamp: messageTs.toISOString(),
      reactions: [{ emoji: { id: null, name: "👍" }, count: 2, users: stored }],
    });

    const cursors: TierCursors = {
      "6h": { "channel-1": dateToSnowflake(new Date(Date.now() - 7 * 3600_000)) },
      "24h": { "channel-1": dateToSnowflake(new Date(Date.now() - 30 * 3600_000)) },
      "7d": { "channel-1": dateToSnowflake(new Date(Date.now() - 8 * 24 * 3600_000)) },
    };
    const channelHigh = { "channel-1": messageId };

    let fetchCalls = 0;
    const messagesByChannel = new Map<string, NormalizedMessage[]>();
    messagesByChannel.set("channel-1", [
      buildMsg(messageId, messageTs.toISOString(), [{ emoji: { id: null, name: "👍" }, count: 2 }]),
    ]);
    const client = fakeClient(messagesByChannel);
    const countingClient = {
      ...client,
      fetchAllReactionUsers: (...args: Parameters<DiscordClient["fetchAllReactionUsers"]>) => {
        fetchCalls++;
        return client.fetchAllReactionUsers(...args);
      },
    } as unknown as DiscordClient;

    const stats = await rescanReactionTiers(countingClient, db, cursors, ["channel-1"], channelHigh, ACCOUNT);

    expect(fetchCalls).toBe(0);
    expect(stats.reactionsUpdated).toBe(0);
    const row = db
      .prepare("SELECT json_extract(raw_data, '$.reactions') AS r FROM events WHERE source_id = ?")
      .get(messageId) as { r: string };
    expect(JSON.parse(row.r)).toEqual([
      { emoji: { id: null, name: "👍" }, count: 2, users: stored },
    ]);
  });

  test("24h tier: changed count with NO stored users → captures users", async () => {
    // A message that first gains reactions after the initial sync arrives at
    // 24h with a changed count and no stored users. The refresh tier must
    // capture authors it never had (storedHasUsers is not required).
    const messageTs = new Date(Date.now() - 26 * 3600_000); // crosses 24h only
    const messageId = dateToSnowflake(messageTs);
    insertDiscordEvent({
      id: messageId,
      timestamp: messageTs.toISOString(),
      reactions: [], // no reactions (and no users) at initial sync
    });

    const cursors: TierCursors = {
      "6h": { "channel-1": dateToSnowflake(new Date(Date.now() - 7 * 3600_000)) },
      "24h": { "channel-1": dateToSnowflake(new Date(Date.now() - 30 * 3600_000)) },
      "7d": { "channel-1": dateToSnowflake(new Date(Date.now() - 8 * 24 * 3600_000)) },
    };
    const channelHigh = { "channel-1": messageId };

    const reactors: ReactionUser[] = [{ id: "u1", name: "Alice" }];
    const messagesByChannel = new Map<string, NormalizedMessage[]>();
    messagesByChannel.set("channel-1", [
      buildMsg(messageId, messageTs.toISOString(), [{ emoji: { id: null, name: "👍" }, count: 1 }]),
    ]);

    const stats = await rescanReactionTiers(
      fakeClient(messagesByChannel, { "👍": reactors }),
      db,
      cursors,
      ["channel-1"],
      channelHigh,
      ACCOUNT,
    );

    expect(stats.reactionsUpdated).toBe(1);
    const row = db
      .prepare("SELECT json_extract(raw_data, '$.reactions') AS r FROM events WHERE source_id = ?")
      .get(messageId) as { r: string };
    expect(JSON.parse(row.r)).toEqual([
      { emoji: { id: null, name: "👍" }, count: 1, users: reactors },
    ]);
  });

  test("6h tier: changed count with no stored users → captures users", async () => {
    const messageTs = new Date(Date.now() - 7 * 3600_000); // crosses 6h only
    const messageId = dateToSnowflake(messageTs);
    insertDiscordEvent({
      id: messageId,
      timestamp: messageTs.toISOString(),
      reactions: [{ emoji: { id: null, name: "👍" }, count: 1 }],
    });

    // 6h band just crossed; 24h/7d thresholds are older than the cursor → skip.
    const eightHoursAgo = dateToSnowflake(new Date(Date.now() - 8 * 3600_000));
    const cursors: TierCursors = {
      "6h": { "channel-1": eightHoursAgo },
      "24h": { "channel-1": eightHoursAgo },
      "7d": { "channel-1": eightHoursAgo },
    };
    const channelHigh = { "channel-1": messageId };

    const reactors: ReactionUser[] = [
      { id: "u1", name: "Alice" },
      { id: "u2", name: "Bob" },
    ];
    const messagesByChannel = new Map<string, NormalizedMessage[]>();
    messagesByChannel.set("channel-1", [
      buildMsg(messageId, messageTs.toISOString(), [{ emoji: { id: null, name: "👍" }, count: 2 }]),
    ]);

    const stats = await rescanReactionTiers(
      fakeClient(messagesByChannel, { "👍": reactors }),
      db,
      cursors,
      ["channel-1"],
      channelHigh,
      ACCOUNT,
    );

    expect(stats.reactionsUpdated).toBe(1);
    const row = db
      .prepare("SELECT json_extract(raw_data, '$.reactions') AS r FROM events WHERE source_id = ?")
      .get(messageId) as { r: string };
    expect(JSON.parse(row.r)).toEqual([
      { emoji: { id: null, name: "👍" }, count: 2, users: reactors },
    ]);
  });

  test("7d tier: changed count with no stored users → counts-only, no author capture", async () => {
    // 7d does not refresh authors on change. With no stored users, a changed
    // count writes the new counts only — no author fetch.
    const messageTs = new Date(Date.now() - 7.5 * 24 * 3600_000); // crosses 7d only
    const messageId = dateToSnowflake(messageTs);
    insertDiscordEvent({
      id: messageId,
      timestamp: messageTs.toISOString(),
      reactions: [{ emoji: { id: null, name: "👍" }, count: 1 }],
    });

    const now = dateToSnowflake(new Date());
    const cursors: TierCursors = {
      "6h": { "channel-1": now },
      "24h": { "channel-1": now },
      "7d": { "channel-1": dateToSnowflake(new Date(Date.now() - 8 * 24 * 3600_000)) },
    };
    const channelHigh = { "channel-1": messageId };

    let fetchCalls = 0;
    const messagesByChannel = new Map<string, NormalizedMessage[]>();
    messagesByChannel.set("channel-1", [
      buildMsg(messageId, messageTs.toISOString(), [{ emoji: { id: null, name: "👍" }, count: 3 }]),
    ]);
    const client = fakeClient(messagesByChannel, { "👍": [{ id: "u1", name: "Alice" }] });
    const countingClient = {
      ...client,
      fetchAllReactionUsers: (...args: Parameters<DiscordClient["fetchAllReactionUsers"]>) => {
        fetchCalls++;
        return client.fetchAllReactionUsers(...args);
      },
    } as unknown as DiscordClient;

    const stats = await rescanReactionTiers(countingClient, db, cursors, ["channel-1"], channelHigh, ACCOUNT);

    expect(fetchCalls).toBe(0);
    expect(stats.reactionsUpdated).toBe(1);
    const row = db
      .prepare("SELECT json_extract(raw_data, '$.reactions') AS r FROM events WHERE source_id = ?")
      .get(messageId) as { r: string };
    // Counts updated, no users attached.
    expect(JSON.parse(row.r)).toEqual([{ emoji: { id: null, name: "👍" }, count: 3 }]);
  });

  test("no observation row when API returns 0 reactions", async () => {
    const messageTs = new Date(Date.now() - 26 * 3600_000);
    const messageId = dateToSnowflake(messageTs);
    insertDiscordEvent({ id: messageId, timestamp: messageTs.toISOString() });

    const cursors: TierCursors = {
      "6h": { "channel-1": dateToSnowflake(new Date(Date.now() - 7 * 3600_000)) },
      "24h": { "channel-1": dateToSnowflake(new Date(Date.now() - 30 * 3600_000)) },
      "7d": { "channel-1": dateToSnowflake(new Date(Date.now() - 8 * 24 * 3600_000)) },
    };
    const channelHigh = { "channel-1": messageId };

    const messagesByChannel = new Map<string, NormalizedMessage[]>();
    messagesByChannel.set("channel-1", [buildMsg(messageId, messageTs.toISOString(), [])]);

    const client = fakeClient(messagesByChannel);
    await rescanReactionTiers(client, db, cursors, ["channel-1"], channelHigh, ACCOUNT);

    const obsCount = db
      .prepare("SELECT COUNT(*) AS c FROM discord_reaction_observations")
      .get() as { c: number };
    expect(obsCount.c).toBe(0);
  });

  test("cursor advances to threshold after successful pass", async () => {
    const messageTs = new Date(Date.now() - 26 * 3600_000);
    const messageId = dateToSnowflake(messageTs);
    insertDiscordEvent({ id: messageId, timestamp: messageTs.toISOString() });

    const oldCursor = dateToSnowflake(new Date(Date.now() - 30 * 3600_000));
    const cursors: TierCursors = {
      "6h": { "channel-1": dateToSnowflake(new Date(Date.now() - 7 * 3600_000)) },
      "24h": { "channel-1": oldCursor },
      "7d": { "channel-1": dateToSnowflake(new Date(Date.now() - 8 * 24 * 3600_000)) },
    };
    const channelHigh = { "channel-1": messageId };

    const messagesByChannel = new Map<string, NormalizedMessage[]>();
    messagesByChannel.set("channel-1", [buildMsg(messageId, messageTs.toISOString())]);

    await rescanReactionTiers(
      fakeClient(messagesByChannel),
      db,
      cursors,
      ["channel-1"],
      channelHigh,
      ACCOUNT,
    );

    // Cursor should have moved forward; it should no longer equal the old cursor.
    expect(cursors["24h"]["channel-1"]).not.toBe(oldCursor);
    expect(BigInt(cursors["24h"]["channel-1"])).toBeGreaterThan(BigInt(oldCursor));
  });

  test("non-capture tier skips UPDATE when stored reactions equal API reactions", async () => {
    // ~7h old so the message crosses only the 6h tier, which does not capture
    // authors — exercises the cascade-avoidance skip in isolation.
    const messageTs = new Date(Date.now() - 7 * 3600_000);
    const messageId = dateToSnowflake(messageTs);
    const reactions = [{ emoji: { id: null, name: "👍" }, count: 2 }];
    insertDiscordEvent({ id: messageId, timestamp: messageTs.toISOString(), reactions });

    // All cursors at 8h ago: the 6h band has just crossed it, while the 24h
    // and 7d thresholds are older than the cursor, so those tiers skip.
    const eightHoursAgo = dateToSnowflake(new Date(Date.now() - 8 * 3600_000));
    const cursors: TierCursors = {
      "6h": { "channel-1": eightHoursAgo },
      "24h": { "channel-1": eightHoursAgo },
      "7d": { "channel-1": eightHoursAgo },
    };
    const channelHigh = { "channel-1": messageId };

    const messagesByChannel = new Map<string, NormalizedMessage[]>();
    // API returns identical reactions
    messagesByChannel.set("channel-1", [buildMsg(messageId, messageTs.toISOString(), reactions)]);

    const stats = await rescanReactionTiers(
      fakeClient(messagesByChannel),
      db,
      cursors,
      ["channel-1"],
      channelHigh,
      ACCOUNT,
    );

    // Message was fetched, but no UPDATE ran because reactions matched and the
    // 6h tier does not capture authors.
    expect(stats.messagesReFetched).toBeGreaterThanOrEqual(1);
    expect(stats.reactionsUpdated).toBe(0);

    // Observation still recorded so we have a per-tier snapshot for trajectory analysis.
    const obs = db
      .prepare("SELECT total_count FROM discord_reaction_observations WHERE tier = '6h'")
      .all() as Array<{ total_count: number }>;
    expect(obs.length).toBe(1);
    expect(obs[0].total_count).toBe(2);
  });

  test("non-capture tier preserves earlier-captured authors on an unchanged set", async () => {
    // ~7.5d old → crosses only the 7d tier. The message already carries users
    // captured at 24h; an unchanged 7d pass must not clobber them.
    const messageTs = new Date(Date.now() - 7.5 * 24 * 3600_000);
    const messageId = dateToSnowflake(messageTs);
    const captured: ReactionUser[] = [{ id: "u1", name: "Alice" }];
    insertDiscordEvent({
      id: messageId,
      timestamp: messageTs.toISOString(),
      reactions: [{ emoji: { id: null, name: "👍" }, count: 1, users: captured }],
    });

    const now = dateToSnowflake(new Date());
    const cursors: TierCursors = {
      "6h": { "channel-1": now },
      "24h": { "channel-1": now },
      "7d": { "channel-1": dateToSnowflake(new Date(Date.now() - 8 * 24 * 3600_000)) },
    };
    const channelHigh = { "channel-1": messageId };

    // The message fetch reports the same single reaction and (as always) no users.
    const messagesByChannel = new Map<string, NormalizedMessage[]>();
    messagesByChannel.set("channel-1", [
      buildMsg(messageId, messageTs.toISOString(), [{ emoji: { id: null, name: "👍" }, count: 1 }]),
    ]);

    const stats = await rescanReactionTiers(
      fakeClient(messagesByChannel),
      db,
      cursors,
      ["channel-1"],
      channelHigh,
      ACCOUNT,
    );

    expect(stats.reactionsUpdated).toBe(0); // nothing changed → no clobbering write
    const row = db
      .prepare("SELECT json_extract(raw_data, '$.reactions') AS r FROM events WHERE source_id = ?")
      .get(messageId) as { r: string };
    expect(JSON.parse(row.r)).toEqual([
      { emoji: { id: null, name: "👍" }, count: 1, users: captured },
    ]);
  });

  test("non-capture tier refreshes authors when a late count change arrives", async () => {
    // ~7.5d old → crosses only the 7d tier. The count grew after 24h, so the
    // write would otherwise drop the captured users; instead we re-fetch them.
    const messageTs = new Date(Date.now() - 7.5 * 24 * 3600_000);
    const messageId = dateToSnowflake(messageTs);
    insertDiscordEvent({
      id: messageId,
      timestamp: messageTs.toISOString(),
      reactions: [{ emoji: { id: null, name: "👍" }, count: 1, users: [{ id: "u1", name: "Alice" }] }],
    });

    const now = dateToSnowflake(new Date());
    const cursors: TierCursors = {
      "6h": { "channel-1": now },
      "24h": { "channel-1": now },
      "7d": { "channel-1": dateToSnowflake(new Date(Date.now() - 8 * 24 * 3600_000)) },
    };
    const channelHigh = { "channel-1": messageId };

    const messagesByChannel = new Map<string, NormalizedMessage[]>();
    messagesByChannel.set("channel-1", [
      buildMsg(messageId, messageTs.toISOString(), [{ emoji: { id: null, name: "👍" }, count: 3 }]),
    ]);
    const refreshed: ReactionUser[] = [
      { id: "u1", name: "Alice" },
      { id: "u2", name: "Bob" },
      { id: "u3", name: "Carol" },
    ];

    const stats = await rescanReactionTiers(
      fakeClient(messagesByChannel, { "👍": refreshed }),
      db,
      cursors,
      ["channel-1"],
      channelHigh,
      ACCOUNT,
    );

    expect(stats.reactionsUpdated).toBe(1);
    const row = db
      .prepare("SELECT json_extract(raw_data, '$.reactions') AS r FROM events WHERE source_id = ?")
      .get(messageId) as { r: string };
    expect(JSON.parse(row.r)).toEqual([
      { emoji: { id: null, name: "👍" }, count: 3, users: refreshed },
    ]);
  });

  test("refreshes changed poll counts while preserving voters, skips when identical", async () => {
    const buildPoll = (count: number, finalized: boolean): DiscordPoll => ({
      question: { text: "pineapple on pizza" },
      answers: [{ answer_id: 1, poll_media: { text: "yes" } }],
      expiry: "2026-04-04T00:00:00.000Z",
      allow_multiselect: false,
      layout_type: 1,
      results: {
        is_finalized: finalized,
        answer_counts: count > 0 ? [{ id: 1, count, me_voted: false }] : [],
      },
    });

    const messageTs = new Date(Date.now() - 26 * 3600_000); // crosses 24h only
    const messageId = dateToSnowflake(messageTs);
    insertDiscordEvent({
      id: messageId,
      timestamp: messageTs.toISOString(),
      poll: buildPoll(0, false), // captured at initial sync, before any votes
    });
    const capturedVoters = {
      captured_at: "2026-04-05T00:00:00.000Z",
      answers: { "1": [{ id: "voter-1", name: "Alice" }] },
    };
    db.prepare(
      "UPDATE events SET raw_data = json_set(raw_data, '$.poll.voters', json(?)) WHERE source_id = ?",
    ).run(JSON.stringify(capturedVoters), messageId);

    const cursors: TierCursors = {
      "6h": { "channel-1": dateToSnowflake(new Date(Date.now() - 7 * 3600_000)) },
      "24h": { "channel-1": dateToSnowflake(new Date(Date.now() - 30 * 3600_000)) },
      "7d": { "channel-1": dateToSnowflake(new Date(Date.now() - 8 * 24 * 3600_000)) },
    };
    const channelHigh = { "channel-1": messageId };

    const freshPoll = buildPoll(4, true);
    const msg = buildMsg(messageId, messageTs.toISOString());
    msg.poll = freshPoll;
    const messagesByChannel = new Map<string, NormalizedMessage[]>();
    messagesByChannel.set("channel-1", [msg]);

    const stats = await rescanReactionTiers(
      fakeClient(messagesByChannel),
      db,
      cursors,
      ["channel-1"],
      channelHigh,
      ACCOUNT,
    );

    expect(stats.pollsUpdated).toBe(1);
    const row = db
      .prepare(
        "SELECT json_extract(raw_data, '$.poll') AS p, json_extract(raw_data, '$.other_field') AS other FROM events WHERE source_id = ?",
      )
      .get(messageId) as { p: string; other: string };
    expect(JSON.parse(row.p)).toEqual({ ...freshPoll, voters: capturedVoters });
    expect(row.other).toBe("preserved");

    // Second pass with identical aggregate data: no write.
    const cursors2: TierCursors = {
      "6h": { "channel-1": dateToSnowflake(new Date(Date.now() - 7 * 3600_000)) },
      "24h": { "channel-1": dateToSnowflake(new Date(Date.now() - 30 * 3600_000)) },
      "7d": { "channel-1": dateToSnowflake(new Date(Date.now() - 8 * 24 * 3600_000)) },
    };
    const stats2 = await rescanReactionTiers(
      fakeClient(messagesByChannel),
      db,
      cursors2,
      ["channel-1"],
      channelHigh,
      ACCOUNT,
    );
    expect(stats2.pollsUpdated).toBe(0);
    const preserved = db
      .prepare("SELECT json_extract(raw_data, '$.poll.voters') AS voters FROM events WHERE source_id = ?")
      .get(messageId) as { voters: string };
    expect(JSON.parse(preserved.voters)).toEqual(capturedVoters);
  });

  test("emoji_counts JSON includes custom emoji with ID", async () => {
    const messageTs = new Date(Date.now() - 26 * 3600_000);
    const messageId = dateToSnowflake(messageTs);
    insertDiscordEvent({ id: messageId, timestamp: messageTs.toISOString() });

    const cursors: TierCursors = {
      "6h": { "channel-1": dateToSnowflake(new Date(Date.now() - 7 * 3600_000)) },
      "24h": { "channel-1": dateToSnowflake(new Date(Date.now() - 30 * 3600_000)) },
      "7d": { "channel-1": dateToSnowflake(new Date(Date.now() - 8 * 24 * 3600_000)) },
    };
    const channelHigh = { "channel-1": messageId };

    const reactions = [
      { emoji: { id: null, name: "🔥" }, count: 2 },
      { emoji: { id: "999", name: "custom_emoji" }, count: 1 },
    ];
    const messagesByChannel = new Map<string, NormalizedMessage[]>();
    messagesByChannel.set("channel-1", [buildMsg(messageId, messageTs.toISOString(), reactions)]);

    await rescanReactionTiers(
      fakeClient(messagesByChannel),
      db,
      cursors,
      ["channel-1"],
      channelHigh,
      ACCOUNT,
    );

    const obs = db
      .prepare("SELECT total_count, emoji_counts FROM discord_reaction_observations WHERE tier = '24h'")
      .get() as { total_count: number; emoji_counts: string };
    expect(obs.total_count).toBe(3);
    expect(JSON.parse(obs.emoji_counts)).toEqual({ "🔥": 2, "custom_emoji:999": 1 });
  });

  test("preserves stored authors when a refresh fetch returns no users", async () => {
    // ~7.5d old → crosses only the 7d tier with stored users and a changed
    // count. The users fetch yields [] (per-emoji 4xx are converted to empty,
    // e.g. a deleted custom emoji); a count > 0 always has reactors, so the
    // stored authors must be carried forward, not erased.
    const messageTs = new Date(Date.now() - 7.5 * 24 * 3600_000);
    const messageId = dateToSnowflake(messageTs);
    const captured: ReactionUser[] = [{ id: "u1", name: "Alice" }];
    insertDiscordEvent({
      id: messageId,
      timestamp: messageTs.toISOString(),
      reactions: [{ emoji: { id: "999", name: "custom" }, count: 1, users: captured }],
    });

    const now = dateToSnowflake(new Date());
    const cursors: TierCursors = {
      "6h": { "channel-1": now },
      "24h": { "channel-1": now },
      "7d": { "channel-1": dateToSnowflake(new Date(Date.now() - 8 * 24 * 3600_000)) },
    };
    const channelHigh = { "channel-1": messageId };

    const messagesByChannel = new Map<string, NormalizedMessage[]>();
    messagesByChannel.set("channel-1", [
      buildMsg(messageId, messageTs.toISOString(), [{ emoji: { id: "999", name: "custom" }, count: 3 }]),
    ]);

    // fakeClient with no usersByEmoji entry -> fetch resolves users: []
    const stats = await rescanReactionTiers(
      fakeClient(messagesByChannel),
      db,
      cursors,
      ["channel-1"],
      channelHigh,
      ACCOUNT,
    );

    expect(stats.reactionsUpdated).toBe(1); // count change still written
    const row = db
      .prepare("SELECT json_extract(raw_data, '$.reactions') AS r FROM events WHERE source_id = ?")
      .get(messageId) as { r: string };
    expect(JSON.parse(row.r)).toEqual([
      { emoji: { id: "999", name: "custom" }, count: 3, users: captured },
    ]);
  });
});

describe("rescan local band precheck", () => {
  // Wraps fakeClient to count fetchMessagesInRange calls, so tests can assert
  // the precheck skipped (or allowed) the API fetch itself.
  function countingClient(
    messagesByChannel: Map<string, NormalizedMessage[]>,
  ): { client: DiscordClient; calls: () => number } {
    const inner = fakeClient(messagesByChannel);
    let count = 0;
    const client = {
      ...inner,
      fetchMessagesInRange: (
        channelId: string,
        after: string,
        before: string,
        handlers?: { onComplete?: () => void; onUnavailable?: (status: 403 | 404) => void },
      ) => {
        count++;
        return inner.fetchMessagesInRange(channelId, after, before, handlers);
      },
    };
    return { client: client as unknown as DiscordClient, calls: () => count };
  }

  // Only the 24h tier has a band to check (30h-old cursor); park the other
  // tiers' cursors at now so they skip via the threshold comparison.
  function cursorsWith24hBand(): TierCursors {
    const now = dateToSnowflake(new Date());
    return {
      "6h": { "channel-1": now },
      "24h": { "channel-1": dateToSnowflake(new Date(Date.now() - 30 * 3600_000)) },
      "7d": { "channel-1": now },
    };
  }

  test("skips the API fetch and advances the cursor when the local band is empty", async () => {
    // The channel's high-water is newer than the cursor (so the old skip does
    // not apply), but the only message is 1h old — far above the 24h band.
    const cursors = cursorsWith24hBand();
    const oldCursor = cursors["24h"]["channel-1"];
    const channelHigh = { "channel-1": dateToSnowflake(new Date(Date.now() - 3600_000)) };
    const { client, calls } = countingClient(new Map());

    const stats = await rescanReactionTiers(client, db, cursors, ["channel-1"], channelHigh, ACCOUNT);

    expect(calls()).toBe(0);
    expect(stats.channelsChecked).toBe(0);
    expect(stats.channelsSkippedEmptyBand).toBe(1);
    expect(BigInt(cursors["24h"]["channel-1"])).toBeGreaterThan(BigInt(oldCursor));
  });

  test("fetches when a stored event sits inside the band", async () => {
    const messageTs = new Date(Date.now() - 26 * 3600_000); // inside the 30h→24h band
    const messageId = dateToSnowflake(messageTs);
    insertDiscordEvent({ id: messageId, timestamp: messageTs.toISOString() });

    const cursors = cursorsWith24hBand();
    const channelHigh = { "channel-1": messageId };
    const messagesByChannel = new Map<string, NormalizedMessage[]>();
    messagesByChannel.set("channel-1", [buildMsg(messageId, messageTs.toISOString())]);
    const { client, calls } = countingClient(messagesByChannel);

    const stats = await rescanReactionTiers(client, db, cursors, ["channel-1"], channelHigh, ACCOUNT);

    expect(calls()).toBe(1);
    expect(stats.channelsChecked).toBe(1);
    expect(stats.channelsSkippedEmptyBand).toBe(0);
    expect(stats.messagesReFetched).toBe(1);
  });

  test("finds in-band rows stored with the legacy '+00:00' timestamp tail", async () => {
    // Legacy Discord rows carry ".ssssss+00:00" or second-precision "+00:00"
    // tails, while band edges are toISOString() "Z" format. An in-band row in
    // the legacy shape must still defeat the precheck — this is the regression
    // guard for BAND_PRECHECK_MARGIN_MS.
    const messageTs = new Date(Date.now() - 26 * 3600_000);
    const messageId = dateToSnowflake(messageTs);
    const legacyTail = messageTs.toISOString().replace(/\.\d+Z$/, "+00:00"); // no fraction
    insertDiscordEvent({ id: messageId, timestamp: legacyTail });

    const cursors = cursorsWith24hBand();
    const channelHigh = { "channel-1": messageId };
    const { client, calls } = countingClient(new Map());

    const stats = await rescanReactionTiers(client, db, cursors, ["channel-1"], channelHigh, ACCOUNT);

    expect(calls()).toBe(1);
    expect(stats.channelsSkippedEmptyBand).toBe(0);
  });

  test("is conservative at the band edge: a row just outside the band still allows the fetch", async () => {
    // 1s younger than the 24h threshold — outside the true band but inside the
    // ±2s precheck margin. The fetch runs (and finds nothing); it must never
    // be the precheck that drops an edge row.
    const edgeTs = new Date(Date.now() - 24 * 3600_000 + 1000);
    insertDiscordEvent({ id: dateToSnowflake(edgeTs), timestamp: edgeTs.toISOString() });

    const cursors = cursorsWith24hBand();
    const channelHigh = { "channel-1": dateToSnowflake(edgeTs) };
    const { client, calls } = countingClient(new Map());

    const stats = await rescanReactionTiers(client, db, cursors, ["channel-1"], channelHigh, ACCOUNT);

    expect(calls()).toBe(1);
    expect(stats.channelsChecked).toBe(1);
    expect(stats.messagesReFetched).toBe(0);
  });

  test("precheck query uses the conversation_id partial index", () => {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${BAND_PRECHECK_SQL}`)
      .all("acct", "channel-1", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z") as Array<{
        detail: string;
      }>;
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("idx_events_conversation_id");
    expect(details).not.toContain("SCAN events");
  });
});

describe("rescan deletion reconciliation", () => {
  function deletionFixture(): { messageId: string; cursors: TierCursors; originalCursor: string } {
    const messageTs = new Date(Date.now() - 26 * 3600_000);
    const messageId = dateToSnowflake(messageTs);
    insertDiscordEvent({ id: messageId, timestamp: messageTs.toISOString() });
    const originalCursor = dateToSnowflake(new Date(Date.now() - 30 * 3600_000));
    const now = dateToSnowflake(new Date());
    return {
      messageId,
      originalCursor,
      cursors: {
        "6h": { "channel-1": now },
        "24h": { "channel-1": originalCursor },
        "7d": { "channel-1": now },
      },
    };
  }

  test("tombstones only after a clean range traversal and confirmed absence", async () => {
    const fixture = deletionFixture();
    const visibleMessage = buildMsg(
      dateToSnowflake(new Date(Date.now() - 25 * 3600_000)),
      new Date(Date.now() - 25 * 3600_000).toISOString(),
    );
    const stats = await rescanReactionTiers(
      fakeClient(new Map([["channel-1", [visibleMessage]]])),
      db,
      fixture.cursors,
      ["channel-1"],
      { "channel-1": fixture.messageId },
      ACCOUNT,
    );

    expect(stats.deletionConfirmations).toBe(1);
    expect(stats.messagesTombstoned).toBe(1);
    const row = db.prepare(
      "SELECT source_deleted_observed_at, content FROM events WHERE source_id = ?",
    ).get(fixture.messageId) as { source_deleted_observed_at: string | null; content: string | null };
    expect(row.source_deleted_observed_at).not.toBeNull();
    expect(row.content).toBeNull();
    expect(fixture.cursors["24h"]["channel-1"]).not.toBe(fixture.originalCursor);
  });

  test("does not tombstone or advance when confirmation is unavailable", async () => {
    const fixture = deletionFixture();
    const base = fakeClient(new Map());
    const client = {
      ...base,
      checkMessagePresence: async () => ({ kind: "unavailable" as const, status: 404 as const }),
    } as unknown as DiscordClient;

    const stats = await rescanReactionTiers(
      client,
      db,
      fixture.cursors,
      ["channel-1"],
      { "channel-1": fixture.messageId },
      ACCOUNT,
    );

    expect(stats.messagesTombstoned).toBe(0);
    expect(db.prepare("SELECT source_deleted_observed_at FROM events WHERE source_id = ?").get(fixture.messageId)).toEqual({
      source_deleted_observed_at: null,
    });
    expect(fixture.cursors["24h"]["channel-1"]).toBe(fixture.originalCursor);
  });

  test("does not trust 200 empty responses without a visible-message control", async () => {
    const fixture = deletionFixture();

    const stats = await rescanReactionTiers(
      fakeClient(new Map()),
      db,
      fixture.cursors,
      ["channel-1"],
      { "channel-1": fixture.messageId },
      ACCOUNT,
    );

    expect(stats.messagesTombstoned).toBe(0);
    expect(fixture.cursors["24h"]["channel-1"]).toBe(fixture.originalCursor);
  });

  test("commits no tombstones when a later confirmation fails", async () => {
    const fixture = deletionFixture();
    const secondTs = new Date(Date.now() - 27 * 3600_000);
    const secondId = dateToSnowflake(secondTs);
    insertDiscordEvent({ id: secondId, timestamp: secondTs.toISOString() });
    const visibleMessage = buildMsg(
      dateToSnowflake(new Date(Date.now() - 25 * 3600_000)),
      new Date(Date.now() - 25 * 3600_000).toISOString(),
    );
    const base = fakeClient(new Map([["channel-1", [visibleMessage]]]));
    let confirmations = 0;
    const client = {
      ...base,
      checkMessagePresence: async () => {
        confirmations++;
        return confirmations === 1
          ? { kind: "missing" as const }
          : { kind: "unavailable" as const, status: 403 as const };
      },
    } as unknown as DiscordClient;

    const stats = await rescanReactionTiers(
      client,
      db,
      fixture.cursors,
      ["channel-1"],
      { "channel-1": fixture.messageId },
      ACCOUNT,
    );

    expect(stats.messagesTombstoned).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE source_deleted_observed_at IS NOT NULL").get()).toEqual({ n: 0 });
    expect(fixture.cursors["24h"]["channel-1"]).toBe(fixture.originalCursor);
  });

  test("fully enriches a message recovered by around confirmation", async () => {
    const fixture = deletionFixture();
    const base = fakeClient(new Map());
    const found = buildMsg(fixture.messageId, new Date(Date.now() - 26 * 3600_000).toISOString(), [
      { emoji: { id: null, name: "👍" }, count: 2 },
    ]);
    const client = {
      ...base,
      fetchMessagesInRange: async function* (
        _channelId: string,
        _after: string,
        _before: string,
        handlers?: { onComplete?: () => void },
      ): AsyncGenerator<NormalizedMessage[]> {
        handlers?.onComplete?.();
      },
      checkMessagePresence: async () => ({ kind: "found" as const, message: found }),
    } as unknown as DiscordClient;

    const stats = await rescanReactionTiers(
      client,
      db,
      fixture.cursors,
      ["channel-1"],
      { "channel-1": fixture.messageId },
      ACCOUNT,
    );

    expect(stats.reactionsUpdated).toBe(1);
    expect(stats.observationsRecorded).toBe(1);
    expect(fixture.cursors["24h"]["channel-1"]).not.toBe(fixture.originalCursor);
  });

  test("does not confirm absence after an incomplete traversal", async () => {
    const fixture = deletionFixture();
    let confirmations = 0;
    const base = fakeClient(new Map());
    const client = {
      ...base,
      fetchMessagesInRange: async function* (): AsyncGenerator<NormalizedMessage[]> {
        // Returning without onComplete simulates a 403/404 terminal result.
      },
      checkMessagePresence: async () => {
        confirmations++;
        return { kind: "missing" as const };
      },
    } as unknown as DiscordClient;

    await rescanReactionTiers(
      client,
      db,
      fixture.cursors,
      ["channel-1"],
      { "channel-1": fixture.messageId },
      ACCOUNT,
    );

    expect(confirmations).toBe(0);
    expect(fixture.cursors["24h"]["channel-1"]).toBe(fixture.originalCursor);
  });
});

describe("reactionsEqual", () => {
  test("identical arrays", () => {
    const a = [{ emoji: { id: null, name: "👍" }, count: 1 }];
    const b = [{ emoji: { id: null, name: "👍" }, count: 1 }];
    expect(reactionsEqual(a, b)).toBe(true);
  });

  test("different counts", () => {
    const a = [{ emoji: { id: null, name: "👍" }, count: 1 }];
    const b = [{ emoji: { id: null, name: "👍" }, count: 2 }];
    expect(reactionsEqual(a, b)).toBe(false);
  });

  test("different emoji set", () => {
    const a = [{ emoji: { id: null, name: "👍" }, count: 1 }];
    const b = [{ emoji: { id: null, name: "❤️" }, count: 1 }];
    expect(reactionsEqual(a, b)).toBe(false);
  });

  test("order-independent", () => {
    const a = [
      { emoji: { id: null, name: "👍" }, count: 1 },
      { emoji: { id: null, name: "❤️" }, count: 2 },
    ];
    const b = [
      { emoji: { id: null, name: "❤️" }, count: 2 },
      { emoji: { id: null, name: "👍" }, count: 1 },
    ];
    expect(reactionsEqual(a, b)).toBe(true);
  });

  test("custom emoji disambiguated by ID", () => {
    const a = [{ emoji: { id: "999", name: "same" }, count: 1 }];
    const b = [{ emoji: { id: "888", name: "same" }, count: 1 }];
    expect(reactionsEqual(a, b)).toBe(false);
  });

  test("empty arrays", () => {
    expect(reactionsEqual([], [])).toBe(true);
  });
});
