import { afterAll, beforeAll, describe, test, expect } from "bun:test";
import { randomUUID } from "crypto";
import { mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  discordSyncSource,
  forgetKnownGuildThread,
  freshGuildMetaName,
  isForbiddenChannelCached,
  isForbiddenThreadSearchParentCached,
  loadKnownGuildThreadIds,
  migrateRescanCursors,
  shouldProbeKnownThread,
  shouldRunActiveThreadFullSweep,
  type DiscordApiSyncState,
  type LegacyRescanCursorFields,
} from "./sync";
import { deleteSyncState, getAppStateDb, getSyncState, setSyncState } from "../../db/app-state";
import {
  CHANNEL_TYPE,
  dateToSnowflake,
  setDiscordClientSleepForTests,
} from "./client";
import { getDb, initDb } from "../../db/schema";

// Sync tests fully mock fetch, so the DiscordClient's retry/rate-limit backoff
// should never fire. But if a real request ever escapes the mock (cross-test
// shared globalThis.fetch state), a real Discord 429 carries `Retry-After: 3600`
// and fetchWithRetry would block on a one-hour setTimeout. Neutralise that timer
// for the whole file so no sync test can ever await a real hour-scale sleep;
// this changed a CI run that hung for 3604905ms into a fast, deterministic run.
beforeAll(() => setDiscordClientSleepForTests(async () => {}));
afterAll(() => setDiscordClientSleepForTests(null));

function baseState(overrides: Partial<DiscordApiSyncState> = {}): DiscordApiSyncState {
  return {
    userId: "user-1",
    username: "alice",
    channelCursors: {},
    guildSparseCursors: {},
    threadsDiscoveredGuilds: [],
    knownDMChannelIds: [],
    backfilledDMChannelIds: [],
    ...overrides,
  };
}

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string" || input instanceof URL) return new URL(input);
  return new URL(input.url);
}

function mockFetch(handler: (input: RequestInfo | URL) => Promise<Response>): typeof fetch {
  return handler as unknown as typeof fetch;
}

function discordMessage(id: string, channelId: string, timestamp = "2026-06-22T12:00:00.000Z") {
  return {
    id,
    type: 0,
    content: "hello",
    channel_id: channelId,
    author: {
      id: "user-1",
      username: "alice",
      global_name: "Alice",
      discriminator: "0",
      avatar: null,
    },
    timestamp,
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    reactions: [],
    pinned: false,
  };
}

// Legacy state shape: sync state plus the per-tier fields that predated the
// unified map (see LegacyRescanCursorFields in discord.ts).
type LegacyState = DiscordApiSyncState & LegacyRescanCursorFields;

describe("migrateRescanCursors", () => {
  test("returns an empty map aliased to state on fresh state", () => {
    const state = baseState();

    const cursors = migrateRescanCursors(state);

    // Migration only folds legacy fields; per-tier buckets are seeded later by
    // rescanReactionTiers, so a fresh state yields an empty — but aliased — map.
    expect(cursors).toEqual({});
    expect(state.rescanCursors).toBe(cursors);
  });

  test("folds legacy per-tier fields into the unified map and drops them", () => {
    const state: LegacyState = baseState();
    state.rescanCursors24h = { "chan-a": "111" };
    state.rescanCursors7d = { "chan-b": "222" };
    state.rescanCursors30d = { "chan-c": "333" };

    const cursors = migrateRescanCursors(state);

    expect(cursors["24h"]).toEqual({ "chan-a": "111" });
    expect(cursors["7d"]).toEqual({ "chan-b": "222" });
    // 30d was retired from TIERS, so its legacy cursors are dropped, not carried.
    expect(cursors["30d"]).toBeUndefined();
    // Legacy fields removed so setSyncState stops serializing them.
    expect(state.rescanCursors24h).toBeUndefined();
    expect(state.rescanCursors7d).toBeUndefined();
    expect(state.rescanCursors30d).toBeUndefined();
  });

  test("prunes unified buckets for tiers retired from TIERS", () => {
    const state = baseState({
      rescanCursors: {
        "24h": { "chan-a": "111" },
        "30d": { "chan-c": "333" },
      },
    });

    const cursors = migrateRescanCursors(state);

    expect(cursors["24h"]).toEqual({ "chan-a": "111" });
    expect(cursors["30d"]).toBeUndefined();
  });

  test("keeps the unified bucket when a stale legacy field also exists", () => {
    const state: LegacyState = baseState({
      rescanCursors: { "24h": { "chan-a": "999" } },
    });
    state.rescanCursors24h = { "chan-a": "111", "chan-z": "222" };

    const cursors = migrateRescanCursors(state);

    expect(cursors["24h"]).toEqual({ "chan-a": "999" });
    expect(state.rescanCursors24h).toBeUndefined();
  });

  test("is idempotent and preserves already-migrated buckets", () => {
    const state = baseState({ rescanCursors: { "24h": { "chan-a": "999" } } });

    const first = migrateRescanCursors(state);
    const second = migrateRescanCursors(state);

    expect(second).toBe(first);
    expect(second["24h"]).toEqual({ "chan-a": "999" });
  });
});

describe("discord full guild thread discovery gates", () => {
  test("captures guild emoji inventory during full guild sync", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    const guildId = "940000000000000900";
    const emojiA = "940000000000000901";
    const emojiB = "940000000000000902";
    const staleEmoji = "940000000000000903";

    deleteSyncState(appDb, "discord-api");
    const db = getDb();
    initDb(db);
    db.prepare("DELETE FROM discord_guild_emojis WHERE guild_id = ?").run(guildId);
    db.prepare("DELETE FROM discord_emojis WHERE emoji_id IN (?, ?, ?)").run(emojiA, emojiB, staleEmoji);
    db.prepare(`
      INSERT INTO discord_guild_emojis (
        guild_id, emoji_id, name, animated, raw_data
      ) VALUES (?, ?, 'stale', 0, json('{}'))
    `).run(guildId, staleEmoji);
    db.close();

    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);

      if (url.hostname === "cdn.discordapp.com") {
        return new Response(null, { status: 404 });
      }
      if (url.pathname.endsWith("/users/@me")) {
        return responseJson({ id: "user-1", username: "alice" });
      }
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith(`/guilds/${guildId}`)) {
        return responseJson({ id: guildId, name: "Emoji Guild", icon: null });
      }
      if (url.pathname.endsWith(`/guilds/${guildId}/emojis`)) {
        return responseJson([
          {
            id: emojiA,
            name: "party",
            animated: false,
            available: true,
            managed: false,
            require_colons: true,
            user: {
              id: "uploader-1",
              username: "upload_alice",
              global_name: "Upload Alice",
              discriminator: "0",
              avatar: "avatarhash",
            },
          },
          {
            id: emojiB,
            name: "dance",
            animated: true,
            available: true,
            managed: false,
            require_colons: true,
          },
        ]);
      }
      if (url.pathname.endsWith(`/guilds/${guildId}/channels`)) {
        return responseJson([]);
      }
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: {
          sources: {
            discord: {
              guilds: { [guildId]: { mode: "full" } },
            },
          },
        },
      });

      const readDb = getDb();
      const currentRows = readDb
        .prepare(`
          SELECT emoji_id, name, animated, uploader_id, uploader_display_name, uploader_avatar_url, deleted_at
          FROM discord_guild_emojis
          WHERE guild_id = ? AND emoji_id IN (?, ?)
          ORDER BY emoji_id
        `)
        .all(guildId, emojiA, emojiB) as Array<{
          emoji_id: string;
          name: string;
          animated: number;
          uploader_id: string | null;
          uploader_display_name: string | null;
          uploader_avatar_url: string | null;
          deleted_at: string | null;
        }>;
      const stale = readDb
        .prepare("SELECT deleted_at FROM discord_guild_emojis WHERE guild_id = ? AND emoji_id = ?")
        .get(guildId, staleEmoji) as { deleted_at: string | null } | null;
      readDb.close();

      expect(result.success).toBe(true);
      expect(currentRows).toEqual([
        {
          emoji_id: emojiA,
          name: "party",
          animated: 0,
          uploader_id: "uploader-1",
          uploader_display_name: "Upload Alice",
          uploader_avatar_url: "https://cdn.discordapp.com/avatars/uploader-1/avatarhash.png?size=128",
          deleted_at: null,
        },
        {
          emoji_id: emojiB,
          name: "dance",
          animated: 1,
          uploader_id: null,
          uploader_display_name: null,
          uploader_avatar_url: null,
          deleted_at: null,
        },
      ]);
      expect(stale?.deleted_at).toBeString();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });

  test("uses fresh sweep and forbidden caches to decide what can be skipped", () => {
    const now = Date.parse("2026-06-22T12:00:00Z");
    const fresh = new Date(now - 23 * 60 * 60 * 1000).toISOString();
    const stale = new Date(now - 25 * 60 * 60 * 1000).toISOString();

    expect(
      shouldRunActiveThreadFullSweep(
        baseState({ activeThreadFullSweepAt: { "guild-1": fresh } }),
        "guild-1",
        now,
      ),
    ).toBe(false);
    expect(
      shouldRunActiveThreadFullSweep(
        baseState({ activeThreadFullSweepAt: { "guild-1": stale } }),
        "guild-1",
        now,
      ),
    ).toBe(true);
    expect(
      isForbiddenChannelCached(
        baseState({ forbiddenChannelIds: { "chan-1": fresh } }),
        "chan-1",
        now,
      ),
    ).toBe(true);
    expect(
      isForbiddenThreadSearchParentCached(
        baseState({ forbiddenThreadSearchParentIds: { "parent-1": stale } }),
        "parent-1",
        now,
      ),
    ).toBe(false);
  });

  test("probes known threads while skipping parent search when full sweep is fresh", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    const calls: string[] = [];
    deleteSyncState(appDb, "discord-api");
    setSyncState(appDb, "discord-api", baseState({
      channelCursors: {
        "100000000000000001": "100000000000000100",
        "200000000000000001": "200000000000000100",
      },
      threadsDiscoveredGuilds: ["guild-1"],
      activeThreadFullSweepAt: { "guild-1": new Date().toISOString() },
    }));
    const db = getDb();
    initDb(db);
    db.prepare(`
      INSERT OR IGNORE INTO events (
        source, source_id, source_account, type, timestamp,
        title, content, people, tags, raw_data, import_batch, conversation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, json(?), ?, ?)
    `).run(
      "discord",
      "200000000000000100",
      "user-1",
      "message:guild",
      "2026-06-21T12:00:00.000Z",
      "Guild #thread",
      "old",
      "[]",
      null,
      JSON.stringify({
        _channel: {
          id: "200000000000000001",
          name: "thread",
          type: "GuildPublicThread",
          guild_id: "guild-1",
          guild_name: "Guild",
          category: null,
        },
      }),
      "test",
      "200000000000000001",
    );
    db.close();
    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);

      if (url.pathname.endsWith("/users/@me")) {
        return responseJson({ id: "user-1", username: "alice" });
      }
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith("/guilds/guild-1")) {
        return responseJson({ id: "guild-1", name: "Guild", icon: null });
      }
      if (url.pathname.endsWith("/guilds/guild-1/channels")) {
        return responseJson([
          {
            id: "100000000000000001",
            type: CHANNEL_TYPE.GUILD_TEXT,
            name: "general",
            last_message_id: "100000000000000100",
          },
        ]);
      }
      if (url.pathname.endsWith("/channels/200000000000000001")) {
        return responseJson({
          id: "200000000000000001",
          type: CHANNEL_TYPE.PUBLIC_THREAD,
          name: "thread",
          guild_id: "guild-1",
          parent_id: "100000000000000001",
          last_message_id: "200000000000000200",
        });
      }
      if (url.pathname.endsWith("/channels/200000000000000001/messages")) {
        const after = url.searchParams.get("after");
        return responseJson(after === "200000000000000100"
          ? [discordMessage("200000000000000200", "200000000000000001")]
          : []);
      }
      if (url.pathname.endsWith("/threads/search")) {
        throw new Error("fresh full sweep should not search threads");
      }
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: {
          sources: {
            discord: {
              guilds: { "guild-1": { mode: "full" } },
            },
          },
        },
      });
      const metadata = result.metadata as {
        phaseTimings: Record<string, {
          routeCounts: Record<string, number>;
          routeDurationMs: Record<string, number>;
        }>;
        optimization: { knownThreadsChecked: number; knownThreadsSkipped: number };
      };
      const nextState = getSyncState<DiscordApiSyncState>(appDb, "discord-api");

      expect(result.success).toBe(true);
      expect(result.eventsAdded).toBe(1);
      expect(calls.some((call) => call.includes("/threads/search"))).toBe(false);
      expect(calls.some((call) => call.includes("/channels/200000000000000001?"))).toBe(true);
      expect(nextState?.channelCursors["200000000000000001"]).toBe("200000000000000200");
      expect(nextState?.knownGuildThreadIds?.["guild-1"]).toContain("200000000000000001");
      expect(metadata.phaseTimings["full-guilds"].routeCounts["/channels/:id"]).toBe(1);
      expect(metadata.phaseTimings["full-guilds"].routeCounts["/channels/:id/messages?after"]).toBe(2);
      expect(metadata.phaseTimings["full-guilds"].routeDurationMs).toBeDefined();
      expect(metadata.optimization.knownThreadsChecked).toBe(1);
      expect(metadata.optimization.knownThreadsSkipped).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });

  test("caches forbidden known thread probes", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    const calls: string[] = [];
    deleteSyncState(appDb, "discord-api");
    setSyncState(appDb, "discord-api", baseState({
      channelCursors: {
        "300000000000000001": "300000000000000100",
        "400000000000000001": "400000000000000100",
      },
      threadsDiscoveredGuilds: ["guild-2"],
      knownGuildThreadIds: { "guild-2": ["400000000000000001"] },
      activeThreadFullSweepAt: { "guild-2": new Date().toISOString() },
    }));
    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);

      if (url.pathname.endsWith("/users/@me")) {
        return responseJson({ id: "user-1", username: "alice" });
      }
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith("/guilds/guild-2")) {
        return responseJson({ id: "guild-2", name: "Guild", icon: null });
      }
      if (url.pathname.endsWith("/guilds/guild-2/channels")) {
        return responseJson([
          {
            id: "300000000000000001",
            type: CHANNEL_TYPE.GUILD_TEXT,
            name: "general",
            last_message_id: "300000000000000100",
          },
        ]);
      }
      if (url.pathname.endsWith("/channels/400000000000000001")) {
        return responseJson(null, 403);
      }
      if (url.pathname.endsWith("/threads/search")) {
        throw new Error("fresh full sweep should not search threads");
      }
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: {
          sources: {
            discord: {
              guilds: { "guild-2": { mode: "full" } },
            },
          },
        },
      });
      const metadata = result.metadata as {
        optimization: { forbiddenChannelsMarked: number; knownThreadsChecked: number };
      };
      const nextState = getSyncState<DiscordApiSyncState>(appDb, "discord-api");

      expect(result.success).toBe(true);
      expect(calls.some((call) => call.includes("/threads/search"))).toBe(false);
      expect(nextState?.knownGuildThreadIds?.["guild-2"]).toContain("400000000000000001");
      expect(typeof nextState?.forbiddenChannelIds?.["400000000000000001"]).toBe("string");
      expect(metadata.optimization.knownThreadsChecked).toBe(1);
      expect(metadata.optimization.forbiddenChannelsMarked).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });

  test("prunes missing known thread probes", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    const calls: string[] = [];
    deleteSyncState(appDb, "discord-api");
    setSyncState(appDb, "discord-api", baseState({
      channelCursors: {
        "500000000000000001": "500000000000000100",
        "600000000000000001": "600000000000000100",
      },
      threadsDiscoveredGuilds: ["guild-3"],
      knownGuildThreadIds: { "guild-3": ["600000000000000001"] },
      rescanCursors: { "24h": { "600000000000000001": "600000000000000050" } },
      activeThreadFullSweepAt: { "guild-3": new Date().toISOString() },
    }));
    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);

      if (url.pathname.endsWith("/users/@me")) {
        return responseJson({ id: "user-1", username: "alice" });
      }
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith("/guilds/guild-3")) {
        return responseJson({ id: "guild-3", name: "Guild", icon: null });
      }
      if (url.pathname.endsWith("/guilds/guild-3/channels")) {
        return responseJson([
          {
            id: "500000000000000001",
            type: CHANNEL_TYPE.GUILD_TEXT,
            name: "general",
            last_message_id: "500000000000000100",
          },
        ]);
      }
      if (url.pathname.endsWith("/channels/600000000000000001")) {
        return responseJson(null, 404);
      }
      if (url.pathname.endsWith("/threads/search")) {
        throw new Error("fresh full sweep should not search threads");
      }
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: {
          sources: {
            discord: {
              guilds: { "guild-3": { mode: "full" } },
            },
          },
        },
      });
      const metadata = result.metadata as {
        optimization: { knownThreadsChecked: number };
      };
      const nextState = getSyncState<DiscordApiSyncState>(appDb, "discord-api");

      expect(result.success).toBe(true);
      expect(calls.some((call) => call.includes("/threads/search"))).toBe(false);
      expect(nextState?.knownGuildThreadIds?.["guild-3"] ?? []).not.toContain("600000000000000001");
      expect(nextState?.channelCursors["600000000000000001"]).toBeUndefined();
      expect(nextState?.rescanCursors?.["24h"]?.["600000000000000001"]).toBeUndefined();
      expect(metadata.optimization.knownThreadsChecked).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });

  test("caches message-fetch 403s by channel", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    const calls: string[] = [];
    deleteSyncState(appDb, "discord-api");
    setSyncState(appDb, "discord-api", baseState({
      channelCursors: { "parent-1": "100" },
      threadsDiscoveredGuilds: ["guild-1"],
      activeThreadFullSweepAt: { "guild-1": new Date().toISOString() },
    }));
    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      calls.push(url.pathname);

      if (url.pathname.endsWith("/users/@me")) {
        return responseJson({ id: "user-1", username: "alice" });
      }
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith("/guilds/guild-1")) {
        return responseJson({ id: "guild-1", name: "Guild", icon: null });
      }
      if (url.pathname.endsWith("/guilds/guild-1/channels")) {
        return responseJson([
          {
            id: "parent-1",
            type: CHANNEL_TYPE.GUILD_TEXT,
            name: "general",
            last_message_id: "200",
          },
        ]);
      }
      if (url.pathname.endsWith("/channels/parent-1/messages")) {
        return responseJson(null, 403);
      }
      if (url.pathname.endsWith("/channels/parent-1/threads/search")) {
        throw new Error("forbidden parent should not search threads");
      }
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: {
          sources: {
            discord: {
              guilds: { "guild-1": { mode: "full" } },
            },
          },
        },
      });
      const nextState = getSyncState<DiscordApiSyncState>(appDb, "discord-api");
      const metadata = result.metadata as {
        optimization: { forbiddenChannelsMarked: number; knownThreadsChecked: number };
      };

      expect(result.success).toBe(true);
      expect(typeof nextState?.forbiddenChannelIds?.["parent-1"]).toBe("string");
      expect(calls.some((call) => call.includes("/threads/search"))).toBe(false);
      expect(metadata.optimization.forbiddenChannelsMarked).toBe(1);
      expect(metadata.optimization.knownThreadsChecked).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });

  test("caches active-thread search 403s by parent channel", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    deleteSyncState(appDb, "discord-api");
    setSyncState(appDb, "discord-api", baseState({
      channelCursors: { "parent-1": "100" },
      threadsDiscoveredGuilds: ["guild-1"],
      activeThreadFullSweepAt: { "guild-1": "2026-06-20T00:00:00.000Z" },
    }));
    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);

      if (url.pathname.endsWith("/users/@me")) {
        return responseJson({ id: "user-1", username: "alice" });
      }
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith("/guilds/guild-1")) {
        return responseJson({ id: "guild-1", name: "Guild", icon: null });
      }
      if (url.pathname.endsWith("/guilds/guild-1/channels")) {
        return responseJson([
          {
            id: "parent-1",
            type: CHANNEL_TYPE.GUILD_TEXT,
            name: "general",
            last_message_id: "200",
          },
        ]);
      }
      if (url.pathname.endsWith("/channels/parent-1/messages")) return responseJson([]);
      if (url.pathname.endsWith("/channels/parent-1/threads/search")) {
        return responseJson(null, 403);
      }
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: {
          sources: {
            discord: {
              guilds: { "guild-1": { mode: "full" } },
            },
          },
        },
      });
      const nextState = getSyncState<DiscordApiSyncState>(appDb, "discord-api");
      const metadata = result.metadata as {
        optimization: { forbiddenThreadSearchParentsMarked: number };
      };

      expect(result.success).toBe(true);
      expect(typeof nextState?.forbiddenThreadSearchParentIds?.["parent-1"]).toBe("string");
      expect(metadata.optimization.forbiddenThreadSearchParentsMarked).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });
});

describe("discordSyncSource auth telemetry", () => {
  test("includes phase and HTTP metadata when current user fetch fails", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    deleteSyncState(appDb, "discord-api");
    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async () => new Response(null, { status: 401 }));

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: { sources: { discord: {} } },
      });
      const metadata = result.metadata as {
        phaseTimings: Record<string, { requests: number }>;
        http: { totalRequests: number; statusCounts: Record<string, number> };
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to get current Discord user - check token");
      expect(metadata.phaseTimings.auth.requests).toBe(1);
      expect(metadata.http.totalRequests).toBe(1);
      expect(metadata.http.statusCounts["401"]).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });

  test("includes phase and HTTP metadata when cached account differs", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    deleteSyncState(appDb, "discord-api");
    setSyncState(appDb, "discord-api", baseState({ userId: "old-user", username: "old" }));
    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async () =>
      new Response(JSON.stringify({ id: "new-user", username: "new" }), { status: 200 }));

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: { sources: { discord: {} } },
      });
      const metadata = result.metadata as {
        phaseTimings: Record<string, { requests: number }>;
        http: { totalRequests: number; statusCounts: Record<string, number> };
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain("Discord account changed");
      expect(metadata.phaseTimings.auth.requests).toBe(1);
      expect(metadata.http.totalRequests).toBe(1);
      expect(metadata.http.statusCounts["200"]).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });
});

describe("loadKnownGuildThreadIds", () => {
  function insertThreadEvent(
    db: ReturnType<typeof getDb>,
    guildId: string,
    threadId: string,
  ): void {
    db.prepare(`
      INSERT OR IGNORE INTO events (
        source, source_id, source_account, type, timestamp,
        title, content, people, tags, raw_data, import_batch, conversation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, json(?), ?, ?)
    `).run(
      "discord",
      threadId,
      "user-1",
      "message:guild",
      "2026-06-21T12:00:00.000Z",
      "thread",
      "msg",
      "[]",
      null,
      JSON.stringify({ _channel: { id: threadId, type: "GuildPublicThread", guild_id: guildId } }),
      "test",
      threadId,
    );
  }

  test("bootstraps the thread index from events when a guild has no entry", () => {
    const db = getDb();
    initDb(db);
    const guildId = "gate-guild-bootstrap";
    const threadId = "900000000000000001";
    insertThreadEvent(db, guildId, threadId);

    const state = baseState({ channelCursors: { [threadId]: "1" } });
    const result = loadKnownGuildThreadIds(db, state, guildId);

    expect(result).toEqual([threadId]);
    // The scan result is persisted so later syncs reuse it.
    expect(state.knownGuildThreadIds?.[guildId]).toEqual([threadId]);
  });

  test("skips the events scan once a guild has an entry", () => {
    const db = getDb();
    initDb(db);
    const guildId = "gate-guild-gated";
    const known = "900000000000000010";
    const newlyInDb = "900000000000000011";
    // A thread exists in events (with a cursor) but is NOT in the persisted
    // index. The old code would re-scan and pick it up; the gate must not.
    insertThreadEvent(db, guildId, newlyInDb);

    const state = baseState({
      channelCursors: { [known]: "1", [newlyInDb]: "1" },
      knownGuildThreadIds: { [guildId]: [known] },
    });
    const result = loadKnownGuildThreadIds(db, state, guildId);

    expect(result).toEqual([known]);
    expect(result).not.toContain(newlyInDb);
  });

  test("records an empty entry for a guild with no thread events so it stops re-scanning", () => {
    const db = getDb();
    initDb(db);
    const guildId = "gate-guild-empty";

    const state = baseState();
    const result = loadKnownGuildThreadIds(db, state, guildId);

    expect(result).toEqual([]);
    // Marked migrated (defined, not undefined) — next sync skips the scan.
    expect(state.knownGuildThreadIds?.[guildId]).toEqual([]);
  });

  test("pruning the last known thread keeps the migrated marker so the scan stays gated", () => {
    const db = getDb();
    initDb(db);
    const guildId = "gate-guild-prune";
    const threadId = "900000000000000020";
    // A thread exists in events with a cursor; the old code would re-scan and
    // pick it up if the guild key were deleted.
    insertThreadEvent(db, guildId, threadId);

    const state = baseState({
      channelCursors: { [threadId]: "1" },
      knownGuildThreadIds: { [guildId]: [threadId] },
      threadProbeAt: { [threadId]: "2026-06-22T12:00:00.000Z" },
    });

    forgetKnownGuildThread(state, guildId, threadId);

    // Empty entry retained (not deleted) — distinguishes "migrated, no threads"
    // from "not bootstrapped yet".
    expect(state.knownGuildThreadIds?.[guildId]).toEqual([]);
    expect(state.threadProbeAt?.[threadId]).toBeUndefined();
    // ...so the next load skips the events scan and does not re-pick the thread.
    expect(loadKnownGuildThreadIds(db, state, guildId)).toEqual([]);
  });
});

describe("shouldProbeKnownThread", () => {
  const now = Date.parse("2026-06-22T12:00:00Z");
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const cursorAgedBy = (ageMs: number) => dateToSnowflake(new Date(now - ageMs));
  const probedAgo = (ageMs: number) => new Date(now - ageMs).toISOString();

  test("probes a thread active in the last day on every sync", () => {
    const state = baseState({
      channelCursors: { t: cursorAgedBy(1 * HOUR) },
      threadProbeAt: { t: probedAgo(60 * 1000) },
    });
    expect(shouldProbeKnownThread(state, "t", now)).toBe(true);
  });

  test("probes a week-band thread every 4h", () => {
    const state = baseState({ channelCursors: { t: cursorAgedBy(3 * DAY) } });

    state.threadProbeAt = { t: probedAgo(3 * HOUR) };
    expect(shouldProbeKnownThread(state, "t", now)).toBe(false);

    state.threadProbeAt = { t: probedAgo(5 * HOUR) };
    expect(shouldProbeKnownThread(state, "t", now)).toBe(true);
  });

  test("probes a dormant thread daily", () => {
    const state = baseState({ channelCursors: { t: cursorAgedBy(30 * DAY) } });

    state.threadProbeAt = { t: probedAgo(23 * HOUR) };
    expect(shouldProbeKnownThread(state, "t", now)).toBe(false);

    state.threadProbeAt = { t: probedAgo(25 * HOUR) };
    expect(shouldProbeKnownThread(state, "t", now)).toBe(true);
  });

  test("probes when there is no probe timestamp or no cursor", () => {
    expect(
      shouldProbeKnownThread(baseState({ channelCursors: { t: cursorAgedBy(30 * DAY) } }), "t", now),
    ).toBe(true);
    expect(shouldProbeKnownThread(baseState(), "t", now)).toBe(true);
  });
});

describe("known thread probe backoff", () => {
  test("defers the probe for a dormant thread probed recently", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    const calls: string[] = [];
    const threadId = "700000000000000001";
    deleteSyncState(appDb, "discord-api");
    setSyncState(appDb, "discord-api", baseState({
      channelCursors: {
        "710000000000000001": "710000000000000100",
        // Ancient snowflake -> dormant tier (daily probe cadence)
        [threadId]: "700000000000000100",
      },
      threadsDiscoveredGuilds: ["guild-4"],
      knownGuildThreadIds: { "guild-4": [threadId] },
      threadProbeAt: { [threadId]: new Date().toISOString() },
      activeThreadFullSweepAt: { "guild-4": new Date().toISOString() },
    }));
    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);

      if (url.pathname.endsWith("/users/@me")) {
        return responseJson({ id: "user-1", username: "alice" });
      }
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith("/guilds/guild-4")) {
        return responseJson({ id: "guild-4", name: "Guild", icon: null });
      }
      if (url.pathname.endsWith("/guilds/guild-4/channels")) {
        return responseJson([
          {
            id: "710000000000000001",
            type: CHANNEL_TYPE.GUILD_TEXT,
            name: "general",
            last_message_id: "710000000000000100",
          },
        ]);
      }
      if (url.pathname.endsWith(`/channels/${threadId}`)) {
        throw new Error("recently probed dormant thread must not be probed again");
      }
      if (url.pathname.endsWith("/threads/search")) {
        throw new Error("fresh full sweep should not search threads");
      }
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: {
          sources: {
            discord: {
              guilds: { "guild-4": { mode: "full" } },
            },
          },
        },
      });
      const metadata = result.metadata as {
        optimization: { knownThreadsChecked: number; knownThreadsDeferred: number };
      };

      expect(result.success).toBe(true);
      expect(calls.some((call) => call.includes(`/channels/${threadId}?`))).toBe(false);
      expect(metadata.optimization.knownThreadsChecked).toBe(0);
      expect(metadata.optimization.knownThreadsDeferred).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });
});

describe("guild metadata TTL", () => {
  const now = Date.parse("2026-06-22T12:00:00Z");
  const HOUR = 60 * 60 * 1000;

  test("freshGuildMetaName returns the cached name only while fresh", () => {
    const meta = (ageMs: number) => ({
      guildMetaAt: { g: { name: "Guild", at: new Date(now - ageMs).toISOString() } },
    });

    expect(freshGuildMetaName(baseState(meta(23 * HOUR)), "g", now)).toBe("Guild");
    expect(freshGuildMetaName(baseState(meta(25 * HOUR)), "g", now)).toBeNull();
    expect(freshGuildMetaName(baseState(), "g", now)).toBeNull();
  });

  test("skips guild + emoji fetches while meta is fresh, refreshes once stale", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    const guildId = "820000000000000001";
    const calls: string[] = [];
    deleteSyncState(appDb, "discord-api");
    setSyncState(appDb, "discord-api", baseState({
      guildMetaAt: {
        [guildId]: { name: "Cached Guild", at: new Date().toISOString() },
        // Not in the sync config — must be pruned from state by the sync.
        "830000000000000001": { name: "Gone Guild", at: new Date().toISOString() },
      },
    }));
    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);

      if (url.pathname.endsWith("/users/@me")) {
        return responseJson({ id: "user-1", username: "alice" });
      }
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith(`/guilds/${guildId}/channels`)) return responseJson([]);
      // /guilds/:id and /guilds/:id/emojis intentionally unhandled: reaching
      // them means the TTL skip failed (the calls assertion catches it too).
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: {
          sources: {
            discord: {
              guilds: { [guildId]: { mode: "full", skip_discovery: true } },
            },
          },
        },
      });
      const metadata = result.metadata as {
        optimization: { guildMetaSkipped: number };
      };
      const nextState = getSyncState<DiscordApiSyncState>(appDb, "discord-api");

      expect(result.success).toBe(true);
      expect(calls.some((c) => c.startsWith(`/api/v10/guilds/${guildId}?`) || c.endsWith(`/guilds/${guildId}?`))).toBe(false);
      expect(calls.some((c) => c.includes(`/guilds/${guildId}/emojis`))).toBe(false);
      expect(calls.some((c) => c.includes(`/guilds/${guildId}/channels`))).toBe(true);
      expect(metadata.optimization.guildMetaSkipped).toBe(1);
      // Unconfigured guild's cached meta pruned; configured guild's kept.
      expect(nextState?.guildMetaAt?.["830000000000000001"]).toBeUndefined();
      expect(nextState?.guildMetaAt?.[guildId]?.name).toBe("Cached Guild");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });

  test("does not cache when the emoji inventory fetch fails", async () => {
    // fetchGuild succeeds but /guilds/:id/emojis is unavailable: the guild
    // must not be cached, so the inventory retries next sync instead of
    // waiting out the 24h TTL.
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    const guildId = "850000000000000001";
    deleteSyncState(appDb, "discord-api");
    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);

      if (url.pathname.endsWith("/users/@me")) {
        return responseJson({ id: "user-1", username: "alice" });
      }
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith(`/guilds/${guildId}`)) {
        return responseJson({ id: guildId, name: "Emoji-less Guild", icon: null });
      }
      if (url.pathname.endsWith(`/guilds/${guildId}/emojis`)) {
        return responseJson(null, 403);
      }
      if (url.pathname.endsWith(`/guilds/${guildId}/channels`)) return responseJson([]);
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: {
          sources: {
            discord: {
              guilds: { [guildId]: { mode: "full", skip_discovery: true } },
            },
          },
        },
      });
      const nextState = getSyncState<DiscordApiSyncState>(appDb, "discord-api");

      expect(result.success).toBe(true);
      expect(nextState?.guildMetaAt?.[guildId]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });

  test("populates the cache from the API when no fresh meta exists", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    const guildId = "840000000000000001";
    const calls: string[] = [];
    deleteSyncState(appDb, "discord-api");
    setSyncState(appDb, "discord-api", baseState({
      guildMetaAt: {
        // Stale (25h) — must be refreshed, not served from cache.
        [guildId]: { name: "Old Name", at: new Date(Date.now() - 25 * HOUR).toISOString() },
      },
    }));
    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      calls.push(url.pathname);

      if (url.pathname.endsWith("/users/@me")) {
        return responseJson({ id: "user-1", username: "alice" });
      }
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith(`/guilds/${guildId}`)) {
        return responseJson({ id: guildId, name: "Fresh Name", icon: null });
      }
      if (url.pathname.endsWith(`/guilds/${guildId}/emojis`)) return responseJson([]);
      if (url.pathname.endsWith(`/guilds/${guildId}/channels`)) return responseJson([]);
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: {
          sources: {
            discord: {
              guilds: { [guildId]: { mode: "full", skip_discovery: true } },
            },
          },
        },
      });
      const metadata = result.metadata as {
        optimization: { guildMetaSkipped: number };
      };
      const nextState = getSyncState<DiscordApiSyncState>(appDb, "discord-api");

      expect(result.success).toBe(true);
      expect(calls.some((c) => c.endsWith(`/guilds/${guildId}`))).toBe(true);
      expect(calls.some((c) => c.endsWith(`/guilds/${guildId}/emojis`))).toBe(true);
      expect(metadata.optimization.guildMetaSkipped).toBe(0);
      expect(nextState?.guildMetaAt?.[guildId]?.name).toBe("Fresh Name");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });
});

describe("initial reaction author capture", () => {
  const channelId = "700000000000000001";
  const messageId = "700000000000000100";

  // The backend tests share a persistent DB, and INSERT OR IGNORE would no-op
  // a message already inserted by a sibling test — clear it so each test sees a
  // fresh insert (result.changes > 0, which is what triggers author capture).
  function clearMessage() {
    const db = getDb();
    initDb(db);
    db.prepare("DELETE FROM events WHERE source = 'discord' AND source_id = ?").run(messageId);
    db.close();
  }

  // A DM channel listing that surfaces one message with a single 👍 reaction.
  // `messageTs` controls the message age, which gates author capture.
  // `reactionsStatus` overrides the reactions-users route response status
  // (405 = a hard failure fetchWithRetry does not retry, so tests stay fast).
  function runInitialSync(messageTs: string, reactionsStatus = 200) {
    const reactors: Array<{ id: string; global_name: string; username: string }> = [
      { id: "u2", global_name: "Bob", username: "bob" },
      { id: "u3", global_name: "Carol", username: "carol" },
    ];
    const calls: string[] = [];

    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      calls.push(url.pathname);

      if (url.pathname.endsWith("/users/@me")) {
        return responseJson({ id: "user-1", username: "alice" });
      }
      if (url.pathname.endsWith("/users/@me/channels")) {
        return responseJson([
          {
            id: channelId,
            type: CHANNEL_TYPE.DM,
            last_message_id: messageId,
            recipients: [{ id: "u2", username: "bob", global_name: "Bob" }],
          },
        ]);
      }
      if (url.pathname.endsWith(`/channels/${channelId}/messages`)) {
        const after = url.searchParams.get("after");
        // Return the message on the first page; empty once we page past it.
        if (after && BigInt(after) >= BigInt(messageId)) return responseJson([]);
        return responseJson([
          {
            ...discordMessage(messageId, channelId, messageTs),
            reactions: [{ count: 2, me: false, emoji: { id: null, name: "👍" } }],
          },
        ]);
      }
      // Reaction users for the 👍 (path carries the encoded emoji).
      if (url.pathname.includes(`/channels/${channelId}/messages/${messageId}/reactions/`)) {
        if (reactionsStatus !== 200) return responseJson(null, reactionsStatus);
        return responseJson(reactors);
      }
      return responseJson(null, 404);
    });

    return { calls, reactors };
  }

  test("captures reactors for a young message: one reactions request, stored + observed", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    deleteSyncState(appDb, "discord-api");
    clearMessage();
    process.env.DISCORD_TOKEN = "test-token";

    // 1h old → within the 24h capture gate.
    const messageTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { calls } = runInitialSync(messageTs);

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: { sources: { discord: {} } },
      });

      expect(result.success).toBe(true);
      expect(result.eventsAdded).toBe(1);

      // Exactly one reactions-users request (one emoji, single page).
      const reactionCalls = calls.filter((c) =>
        c.includes(`/channels/${channelId}/messages/${messageId}/reactions/`),
      );
      expect(reactionCalls.length).toBe(1);

      const db = getDb();
      const row = db
        .prepare(
          "SELECT json_extract(raw_data, '$.reactions') AS r FROM events WHERE source = 'discord' AND source_id = ?",
        )
        .get(messageId) as { r: string };
      expect(JSON.parse(row.r)).toEqual([
        {
          emoji: { id: null, name: "👍" },
          count: 2,
          users: [
            { id: "u2", name: "Bob" },
            { id: "u3", name: "Carol" },
          ],
        },
      ]);

      // The initial observation (counts only) was recorded.
      const eventRow = db
        .prepare("SELECT id FROM events WHERE source = 'discord' AND source_id = ?")
        .get(messageId) as { id: number };
      const obs = db
        .prepare(
          "SELECT total_count, tier FROM discord_reaction_observations WHERE event_id = ? AND tier = 'initial'",
        )
        .get(eventRow.id) as { total_count: number; tier: string } | undefined;
      expect(obs?.total_count).toBe(2);
      db.close();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });

  test("does NOT fetch reactors for a message older than the 24h gate", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    deleteSyncState(appDb, "discord-api");
    clearMessage();
    process.env.DISCORD_TOKEN = "test-token";

    // 26h old → past the 24h capture gate.
    const messageTs = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    const { calls } = runInitialSync(messageTs);

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: { sources: { discord: {} } },
      });

      expect(result.success).toBe(true);
      expect(result.eventsAdded).toBe(1);

      // No reactions-users request for the aged-out message.
      const reactionCalls = calls.filter((c) =>
        c.includes(`/channels/${channelId}/messages/${messageId}/reactions/`),
      );
      expect(reactionCalls.length).toBe(0);

      const db = getDb();
      const row = db
        .prepare(
          "SELECT json_extract(raw_data, '$.reactions') AS r FROM events WHERE source = 'discord' AND source_id = ?",
        )
        .get(messageId) as { r: string };
      // Counts stored, no users (author capture skipped).
      expect(JSON.parse(row.r)).toEqual([{ emoji: { id: null, name: "👍" }, count: 2 }]);
      db.close();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });

  test("a hard failure on the reactions route does not abort the sync", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    deleteSyncState(appDb, "discord-api");
    clearMessage();
    process.env.DISCORD_TOKEN = "test-token";

    // Young message (inside the capture gate) whose reactions-users fetch
    // hard-fails (405 is not retried) — the sync must continue: message
    // stored with counts only, run reported successful.
    const messageTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { calls } = runInitialSync(messageTs, 405);

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: { sources: { discord: {} } },
      });

      expect(result.success).toBe(true);
      expect(result.eventsAdded).toBe(1);

      // The fetch was attempted (gate passed) but failed.
      const reactionCalls = calls.filter((c) =>
        c.includes(`/channels/${channelId}/messages/${messageId}/reactions/`),
      );
      expect(reactionCalls.length).toBe(1);

      const db = getDb();
      const row = db
        .prepare(
          "SELECT json_extract(raw_data, '$.reactions') AS r FROM events WHERE source = 'discord' AND source_id = ?",
        )
        .get(messageId) as { r: string };
      // Counts survive; users absent until a 6h/24h tier change re-attempts.
      expect(JSON.parse(row.r)).toEqual([{ emoji: { id: null, name: "👍" }, count: 2 }]);
      db.close();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) {
        delete process.env.DISCORD_TOKEN;
      } else {
        process.env.DISCORD_TOKEN = originalToken;
      }
      deleteSyncState(appDb, "discord-api");
    }
  });
});

describe("initial sticker attachment capture", () => {
  const channelId = "805000000000000001";
  const messageId = "805000000000000100";
  const stickerId = "805000000000000200";

  function clearMessage() {
    const db = getDb();
    initDb(db);
    db.prepare("DELETE FROM events WHERE source = 'discord' AND source_id = ?").run(messageId);
    db.close();
  }

  test("stores a newly synced sticker through the attachment pipeline", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const originalMediaPath = process.env.TIMELINE_MEDIA_PATH;
    const appDb = getAppStateDb();
    const mediaDir = join(tmpdir(), `timeline-discord-sticker-initial-${randomUUID()}`);
    let stickerFetches = 0;

    deleteSyncState(appDb, "discord-api");
    clearMessage();
    await mkdir(mediaDir, { recursive: true });
    process.env.DISCORD_TOKEN = "test-token";
    process.env.TIMELINE_MEDIA_PATH = mediaDir;
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);

      if (url.pathname.endsWith("/users/@me")) {
        return responseJson({ id: "user-1", username: "alice" });
      }
      if (url.pathname.endsWith("/users/@me/channels")) {
        return responseJson([
          {
            id: channelId,
            type: CHANNEL_TYPE.DM,
            last_message_id: messageId,
            recipients: [{ id: "user-2", username: "bob", global_name: "Bob" }],
          },
        ]);
      }
      if (url.pathname.endsWith(`/channels/${channelId}/messages`)) {
        const after = url.searchParams.get("after");
        if (after && BigInt(after) >= BigInt(messageId)) return responseJson([]);
        return responseJson([
          {
            ...discordMessage(messageId, channelId, new Date().toISOString()),
            content: "",
            sticker_items: [{ id: stickerId, name: "Synthetic Cheer", format_type: 1 }],
          },
        ]);
      }
      if (url.hostname === "cdn.discordapp.com" && url.pathname === `/stickers/${stickerId}.png`) {
        stickerFetches++;
        return new Response("sticker-data", { headers: { "Content-Type": "image/png" } });
      }
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({
        verbose: false,
        config: { sources: { discord: {} } },
      });

      expect(result.success).toBe(true);
      expect(result.eventsAdded).toBe(1);
      expect(stickerFetches).toBe(1);

      const db = getDb();
      const row = db
        .prepare(
          `SELECT e.type, a.source_id, a.filename, a.mime_type, a.status, a.storage_path
           FROM events e
           JOIN attachments a ON a.event_id = e.id
           WHERE e.source = 'discord' AND e.source_id = ?`,
        )
        .get(messageId) as {
        type: string;
        source_id: string;
        filename: string;
        mime_type: string;
        status: string;
        storage_path: string;
      };
      db.close();
      expect(row).toEqual({
        type: "message:dm:sticker",
        source_id: stickerId,
        filename: "Synthetic Cheer.png",
        mime_type: "image/png",
        status: "stored",
        storage_path: expect.any(String),
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = originalToken;
      if (originalMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
      else process.env.TIMELINE_MEDIA_PATH = originalMediaPath;
      clearMessage();
      deleteSyncState(appDb, "discord-api");
      await rm(mediaDir, { recursive: true, force: true });
    }
  });
});

describe("Discord attachment recovery sweep", () => {
  const channelId = "810000000000000001";

  function seedEvent(
    messageId: string,
    attachmentIds: string[],
    timestamp = new Date().toISOString(),
    sourceAccount = "user-1",
  ): number {
    const db = getDb();
    initDb(db);
    const rawData = {
      _channel: { id: channelId },
      attachments: attachmentIds.map((id) => ({
        id,
        filename: `${id}.png`,
        size: 4,
        url: `https://cdn.discordapp.com/attachments/${channelId}/${id}/expired.png`,
        content_type: "image/png",
      })),
    };
    const inserted = db
      .prepare(
        `INSERT INTO events (source, source_id, source_account, type, timestamp, raw_data)
         VALUES ('discord', ?, ?, 'message:dm', ?, ?)`,
      )
      .run(messageId, sourceAccount, timestamp, JSON.stringify(rawData));
    const eventId = Number(inserted.lastInsertRowid);
    db.close();
    return eventId;
  }

  function seedForwardedEvent(messageId: string, attachmentId: string): number {
    const db = getDb();
    initDb(db);
    const attachment = {
      id: attachmentId,
      filename: `${attachmentId}.png`,
      size: 4,
      url: `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/expired.png`,
      content_type: "image/png",
    };
    const rawData = {
      _channel: { id: channelId },
      attachments: [],
      message_snapshots: [{ message: { content: "", attachments: [attachment] } }],
    };
    const inserted = db
      .prepare(
        `INSERT INTO events (source, source_id, source_account, type, timestamp, raw_data)
         VALUES ('discord', ?, 'user-1', 'message:dm:forward', ?, ?)`,
      )
      .run(messageId, new Date().toISOString(), JSON.stringify(rawData));
    const eventId = Number(inserted.lastInsertRowid);
    db.close();
    return eventId;
  }

  function seedStickerEvent(
    messageId: string,
    stickerId: string,
    timestamp: string,
  ): number {
    const db = getDb();
    initDb(db);
    const rawData = {
      _channel: { id: channelId },
      attachments: [],
      sticker_items: [{ id: stickerId, name: "Synthetic Wave", format_type: 1 }],
    };
    const inserted = db.prepare(
      `INSERT INTO events (source, source_id, source_account, type, timestamp, raw_data)
       VALUES ('discord', ?, 'user-1', 'message:dm:sticker', ?, ?)`,
    ).run(messageId, timestamp, JSON.stringify(rawData));
    const eventId = Number(inserted.lastInsertRowid);
    db.close();
    return eventId;
  }

  function clearMessages(messageIds: string[]) {
    const db = getDb();
    initDb(db);
    for (const messageId of messageIds) {
      db.prepare("DELETE FROM events WHERE source = 'discord' AND source_id = ?").run(messageId);
    }
    db.close();
  }

  function attachmentFromApi(id: string) {
    return {
      id,
      filename: `${id}.png`,
      size: 4,
      url: `https://cdn.discordapp.com/attachments/${channelId}/${id}/fresh.png`,
      content_type: "image/png",
    };
  }

  test("backfills recent sticker assets directly from the stable CDN", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const originalMediaPath = process.env.TIMELINE_MEDIA_PATH;
    const appDb = getAppStateDb();
    const messageId = "810000000000000111";
    const stickerId = "810000000000000213";
    const mediaDir = join(tmpdir(), `timeline-discord-sticker-${randomUUID()}`);
    let messageRecoveryFetches = 0;

    deleteSyncState(appDb, "discord-api");
    clearMessages([messageId]);
    const eventId = seedStickerEvent(
      messageId,
      stickerId,
      new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
    );

    await mkdir(mediaDir, { recursive: true });
    process.env.DISCORD_TOKEN = "test-token";
    process.env.TIMELINE_MEDIA_PATH = mediaDir;
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/@me")) return responseJson({ id: "user-1", username: "alice" });
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith(`/channels/${channelId}/messages`)) {
        messageRecoveryFetches++;
        return responseJson(null, 404);
      }
      if (url.hostname === "cdn.discordapp.com" && url.pathname === `/stickers/${stickerId}.png`) {
        return new Response("sticker-data", { headers: { "Content-Type": "image/png" } });
      }
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({ verbose: false, config: { sources: { discord: {} } } });
      expect(result.success).toBe(true);
      expect(result.metadata?.attachmentRecoveryAttempted).toBe(1);
      expect(result.metadata?.attachmentRecoveryStored).toBe(1);
      expect(messageRecoveryFetches).toBe(0);

      const checkDb = getDb();
      const row = checkDb.prepare(
        "SELECT source_id, filename, mime_type, status FROM attachments WHERE event_id = ?",
      ).get(eventId);
      checkDb.close();
      expect(row).toEqual({
        source_id: stickerId,
        filename: "Synthetic Wave.png",
        mime_type: "image/png",
        status: "stored",
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = originalToken;
      if (originalMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
      else process.env.TIMELINE_MEDIA_PATH = originalMediaPath;
      clearMessages([messageId]);
      deleteSyncState(appDb, "discord-api");
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  test("retries only failed and row-less siblings from mixed attachment messages", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const originalMediaPath = process.env.TIMELINE_MEDIA_PATH;
    const appDb = getAppStateDb();
    const failedMessageId = "810000000000000106";
    const rowLessMessageId = "810000000000000107";
    const storedFailedId = "810000000000000206";
    const failedId = "810000000000000207";
    const storedRowLessId = "810000000000000208";
    const rowLessId = "810000000000000209";
    const mediaDir = join(tmpdir(), `timeline-discord-retry-${randomUUID()}`);
    const downloadedIds: string[] = [];
    const recoveredMessageIds: string[] = [];

    deleteSyncState(appDb, "discord-api");
    clearMessages([failedMessageId, rowLessMessageId]);
    const failedEventId = seedEvent(failedMessageId, [storedFailedId, failedId]);
    const rowLessEventId = seedEvent(rowLessMessageId, [storedRowLessId, rowLessId]);
    const db = getDb();
    initDb(db);
    db.prepare(
      `INSERT INTO attachments (event_id, source, source_id, filename, status)
       VALUES (?, 'discord', ?, ?, ?)`,
    ).run(failedEventId, storedFailedId, `${storedFailedId}.png`, "stored");
    db.prepare(
      `INSERT INTO attachments (event_id, source, source_id, filename, status)
       VALUES (?, 'discord', ?, ?, ?)`,
    ).run(failedEventId, failedId, `${failedId}.png`, "failed");
    db.prepare(
      `INSERT INTO attachments (event_id, source, source_id, filename, status)
       VALUES (?, 'discord', ?, ?, ?)`,
    ).run(rowLessEventId, storedRowLessId, `${storedRowLessId}.png`, "stored");
    db.close();

    await mkdir(mediaDir, { recursive: true });
    process.env.DISCORD_TOKEN = "test-token";
    process.env.TIMELINE_MEDIA_PATH = mediaDir;
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/@me")) return responseJson({ id: "user-1", username: "alice" });
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith(`/channels/${channelId}/messages`)) {
        const messageId = url.searchParams.get("around");
        if (messageId) recoveredMessageIds.push(messageId);
        if (messageId === failedMessageId) {
          return responseJson([
            {
              ...discordMessage(failedMessageId, channelId),
              attachments: [attachmentFromApi(storedFailedId), attachmentFromApi(failedId)],
            },
          ]);
        }
        if (messageId === rowLessMessageId) {
          return responseJson([
            {
              ...discordMessage(rowLessMessageId, channelId),
              attachments: [attachmentFromApi(storedRowLessId), attachmentFromApi(rowLessId)],
            },
          ]);
        }
      }
      if (url.hostname === "cdn.discordapp.com") {
        const id = url.pathname.split("/").at(-2);
        if (id) downloadedIds.push(id);
        return new Response("data");
      }
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({ verbose: false, config: { sources: { discord: {} } } });
      expect(result.success).toBe(true);
      expect(result.metadata?.attachmentRecoveryAttempted).toBe(2);
      expect(result.metadata?.attachmentRecoveryStored).toBe(2);
      expect(recoveredMessageIds.sort()).toEqual([failedMessageId, rowLessMessageId]);
      expect(downloadedIds.sort()).toEqual([failedId, rowLessId]);

      const checkDb = getDb();
      const rows = checkDb
        .prepare(
          `SELECT source_id, status FROM attachments
           WHERE event_id IN (?, ?) ORDER BY source_id`,
        )
        .all(failedEventId, rowLessEventId) as Array<{ source_id: string; status: string }>;
      checkDb.close();
      expect(rows).toEqual([
        { source_id: storedFailedId, status: "stored" },
        { source_id: failedId, status: "stored" },
        { source_id: storedRowLessId, status: "stored" },
        { source_id: rowLessId, status: "stored" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = originalToken;
      if (originalMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
      else process.env.TIMELINE_MEDIA_PATH = originalMediaPath;
      clearMessages([failedMessageId, rowLessMessageId]);
      deleteSyncState(appDb, "discord-api");
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  test("retries a row-less forwarded snapshot attachment", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const originalMediaPath = process.env.TIMELINE_MEDIA_PATH;
    const appDb = getAppStateDb();
    const messageId = "810000000000000110";
    const attachmentId = "810000000000000212";
    const mediaDir = join(tmpdir(), `timeline-discord-retry-${randomUUID()}`);

    deleteSyncState(appDb, "discord-api");
    clearMessages([messageId]);
    const eventId = seedForwardedEvent(messageId, attachmentId);

    await mkdir(mediaDir, { recursive: true });
    process.env.DISCORD_TOKEN = "test-token";
    process.env.TIMELINE_MEDIA_PATH = mediaDir;
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/@me")) return responseJson({ id: "user-1", username: "alice" });
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith(`/channels/${channelId}/messages`)) {
        return responseJson([{
          ...discordMessage(messageId, channelId),
          flags: 1 << 14,
          attachments: [],
          message_snapshots: [{
            message: {
              content: "",
              attachments: [attachmentFromApi(attachmentId)],
            },
          }],
        }]);
      }
      if (url.hostname === "cdn.discordapp.com") return new Response("data");
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({ verbose: false, config: { sources: { discord: {} } } });
      expect(result.success).toBe(true);
      expect(result.metadata?.attachmentRecoveryAttempted).toBe(1);
      expect(result.metadata?.attachmentRecoveryStored).toBe(1);

      const checkDb = getDb();
      const row = checkDb
        .prepare("SELECT source_id, status FROM attachments WHERE event_id = ?")
        .get(eventId) as { source_id: string; status: string };
      checkDb.close();
      expect(row).toEqual({ source_id: attachmentId, status: "stored" });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = originalToken;
      if (originalMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
      else process.env.TIMELINE_MEDIA_PATH = originalMediaPath;
      clearMessages([messageId]);
      deleteSyncState(appDb, "discord-api");
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  test("does not recover candidates belonging to another Discord account", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const originalMediaPath = process.env.TIMELINE_MEDIA_PATH;
    const appDb = getAppStateDb();
    const ownMessageId = "810000000000000108";
    const otherMessageId = "810000000000000109";
    const ownAttachmentId = "810000000000000210";
    const otherAttachmentId = "810000000000000211";
    const mediaDir = join(tmpdir(), `timeline-discord-retry-${randomUUID()}`);
    const recoveredMessageIds: string[] = [];

    deleteSyncState(appDb, "discord-api");
    clearMessages([ownMessageId, otherMessageId]);
    const ownEventId = seedEvent(ownMessageId, [ownAttachmentId]);
    const otherEventId = seedEvent(otherMessageId, [otherAttachmentId], new Date().toISOString(), "user-2");
    const db = getDb();
    initDb(db);
    db.prepare(
      `INSERT INTO attachments (event_id, source, source_id, filename, status)
       VALUES (?, 'discord', ?, ?, 'failed')`,
    ).run(ownEventId, ownAttachmentId, `${ownAttachmentId}.png`);
    db.prepare(
      `INSERT INTO attachments (event_id, source, source_id, filename, status)
       VALUES (?, 'discord', ?, ?, 'failed')`,
    ).run(otherEventId, otherAttachmentId, `${otherAttachmentId}.png`);
    db.close();

    await mkdir(mediaDir, { recursive: true });
    process.env.DISCORD_TOKEN = "test-token";
    process.env.TIMELINE_MEDIA_PATH = mediaDir;
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/@me")) return responseJson({ id: "user-1", username: "alice" });
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith(`/channels/${channelId}/messages`)) {
        const messageId = url.searchParams.get("around");
        if (messageId) recoveredMessageIds.push(messageId);
        return responseJson([
          { ...discordMessage(ownMessageId, channelId), attachments: [attachmentFromApi(ownAttachmentId)] },
        ]);
      }
      if (url.hostname === "cdn.discordapp.com") return new Response("data");
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({ verbose: false, config: { sources: { discord: {} } } });
      expect(result.success).toBe(true);
      expect(result.metadata?.attachmentRecoveryAttempted).toBe(1);
      expect(result.metadata?.attachmentRecoveryStored).toBe(1);
      expect(recoveredMessageIds).toEqual([ownMessageId]);

      const checkDb = getDb();
      const otherStatus = checkDb
        .prepare("SELECT status FROM attachments WHERE event_id = ? AND source_id = ?")
        .get(otherEventId, otherAttachmentId) as { status: string };
      checkDb.close();
      expect(otherStatus.status).toBe("failed");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = originalToken;
      if (originalMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
      else process.env.TIMELINE_MEDIA_PATH = originalMediaPath;
      clearMessages([ownMessageId, otherMessageId]);
      deleteSyncState(appDb, "discord-api");
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  test("retries failed rows and downloads messages interrupted before attachment rows", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const originalMediaPath = process.env.TIMELINE_MEDIA_PATH;
    const appDb = getAppStateDb();
    const failedMessageId = "810000000000000101";
    const missingRowsMessageId = "810000000000000102";
    const failedAttachmentId = "810000000000000201";
    const missingRowsAttachmentId = "810000000000000202";
    const mediaDir = join(tmpdir(), `timeline-discord-retry-${randomUUID()}`);

    deleteSyncState(appDb, "discord-api");
    clearMessages([failedMessageId, missingRowsMessageId]);
    const failedEventId = seedEvent(failedMessageId, [failedAttachmentId]);
    const missingRowsEventId = seedEvent(missingRowsMessageId, [missingRowsAttachmentId]);
    const db = getDb();
    initDb(db);
    db.prepare(
      `INSERT INTO attachments (event_id, source, source_id, filename, status)
       VALUES (?, 'discord', ?, ?, 'failed')`,
    ).run(failedEventId, failedAttachmentId, `${failedAttachmentId}.png`);
    db.close();

    await mkdir(mediaDir, { recursive: true });
    process.env.DISCORD_TOKEN = "test-token";
    process.env.TIMELINE_MEDIA_PATH = mediaDir;
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/@me")) return responseJson({ id: "user-1", username: "alice" });
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith(`/channels/${channelId}/messages`)) {
        const messageId = url.searchParams.get("around");
        if (messageId === failedMessageId) {
          return responseJson([{ ...discordMessage(failedMessageId, channelId), attachments: [attachmentFromApi(failedAttachmentId)] }]);
        }
        if (messageId === missingRowsMessageId) {
          return responseJson([{ ...discordMessage(missingRowsMessageId, channelId), attachments: [attachmentFromApi(missingRowsAttachmentId)] }]);
        }
      }
      if (url.hostname === "cdn.discordapp.com") return new Response("data");
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({ verbose: false, config: { sources: { discord: {} } } });
      expect(result.success).toBe(true);
      expect(result.metadata?.attachmentRecoveryAttempted).toBe(2);
      expect(result.metadata?.attachmentRecoveryStored).toBe(2);

      const checkDb = getDb();
      const rows = checkDb
        .prepare(
          `SELECT source_id, status FROM attachments
           WHERE event_id IN (?, ?) ORDER BY source_id`,
        )
        .all(failedEventId, missingRowsEventId) as Array<{
          source_id: string;
          status: string;
        }>;
      checkDb.close();
      expect(rows).toEqual([
        { source_id: failedAttachmentId, status: "stored" },
        { source_id: missingRowsAttachmentId, status: "stored" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = originalToken;
      if (originalMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
      else process.env.TIMELINE_MEDIA_PATH = originalMediaPath;
      clearMessages([failedMessageId, missingRowsMessageId]);
      deleteSyncState(appDb, "discord-api");
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  test("tombstones deleted and missing attachments without retrying them", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    const deletedMessageId = "810000000000000103";
    const missingAttachmentMessageId = "810000000000000104";
    const deletedAttachmentId = "810000000000000203";
    const missingAttachmentId = "810000000000000204";
    let recoveryFetches = 0;

    deleteSyncState(appDb, "discord-api");
    clearMessages([deletedMessageId, missingAttachmentMessageId]);
    seedEvent(deletedMessageId, [deletedAttachmentId]);
    const missingEventId = seedEvent(missingAttachmentMessageId, [missingAttachmentId]);
    const db = getDb();
    initDb(db);
    db.prepare(
      `INSERT INTO attachments (event_id, source, source_id, filename, status)
       VALUES (?, 'discord', ?, ?, 'failed')`,
    ).run(missingEventId, missingAttachmentId, `${missingAttachmentId}.png`);
    db.close();

    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/@me")) return responseJson({ id: "user-1", username: "alice" });
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith(`/channels/${channelId}/messages`)) {
        recoveryFetches++;
        if (url.searchParams.get("around") === deletedMessageId) return responseJson(null, 404);
        return responseJson([{ ...discordMessage(missingAttachmentMessageId, channelId), attachments: [] }]);
      }
      return responseJson(null, 404);
    });

    try {
      const first = await discordSyncSource.sync({ verbose: false, config: { sources: { discord: {} } } });
      expect(first.success).toBe(true);
      expect(first.metadata?.attachmentRecoveryUnrecoverable).toBe(2);
      expect(recoveryFetches).toBe(2);

      const checkDb = getDb();
      const rows = checkDb
        .prepare(
          `SELECT source_id, status FROM attachments
           WHERE source_id IN (?, ?) ORDER BY source_id`,
        )
        .all(deletedAttachmentId, missingAttachmentId) as Array<{ source_id: string; status: string }>;
      checkDb.close();
      expect(rows).toEqual([
        { source_id: deletedAttachmentId, status: "unrecoverable" },
        { source_id: missingAttachmentId, status: "unrecoverable" },
      ]);

      await discordSyncSource.sync({ verbose: false, config: { sources: { discord: {} } } });
      expect(recoveryFetches).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = originalToken;
      clearMessages([deletedMessageId, missingAttachmentMessageId]);
      deleteSyncState(appDb, "discord-api");
    }
  });

  test("limits recovery to messages from the last 30 days", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    const messageId = "810000000000000105";
    const attachmentId = "810000000000000205";
    let recoveryFetches = 0;

    deleteSyncState(appDb, "discord-api");
    clearMessages([messageId]);
    const eventId = seedEvent(
      messageId,
      [attachmentId],
      new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
    );
    const db = getDb();
    initDb(db);
    db.prepare(
      `INSERT INTO attachments (event_id, source, source_id, filename, status)
       VALUES (?, 'discord', ?, ?, 'failed')`,
    ).run(eventId, attachmentId, `${attachmentId}.png`);
    db.close();

    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/@me")) return responseJson({ id: "user-1", username: "alice" });
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith(`/channels/${channelId}/messages`)) recoveryFetches++;
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({ verbose: false, config: { sources: { discord: {} } } });
      expect(result.success).toBe(true);
      expect(result.metadata?.attachmentRecoveryAttempted).toBe(0);
      expect(recoveryFetches).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = originalToken;
      clearMessages([messageId]);
      deleteSyncState(appDb, "discord-api");
    }
  });

  test("caps each recovery sweep at 25 messages", async () => {
    const originalFetch = globalThis.fetch;
    const originalToken = process.env.DISCORD_TOKEN;
    const appDb = getAppStateDb();
    const messageIds = Array.from(
      { length: 26 },
      (_, index) => `810000000000000${String(300 + index).padStart(3, "0")}`,
    );
    let recoveryFetches = 0;

    deleteSyncState(appDb, "discord-api");
    clearMessages(messageIds);
    const db = getDb();
    initDb(db);
    for (const [index, messageId] of messageIds.entries()) {
      const attachmentId = `810000000000000${String(400 + index).padStart(3, "0")}`;
      const eventId = seedEvent(messageId, [attachmentId]);
      db.prepare(
        `INSERT INTO attachments (event_id, source, source_id, filename, status)
         VALUES (?, 'discord', ?, ?, 'failed')`,
      ).run(eventId, attachmentId, `${attachmentId}.png`);
    }
    db.close();

    process.env.DISCORD_TOKEN = "test-token";
    globalThis.fetch = mockFetch(async (input) => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/users/@me")) return responseJson({ id: "user-1", username: "alice" });
      if (url.pathname.endsWith("/users/@me/channels")) return responseJson([]);
      if (url.pathname.endsWith(`/channels/${channelId}/messages`)) recoveryFetches++;
      return responseJson(null, 404);
    });

    try {
      const result = await discordSyncSource.sync({ verbose: false, config: { sources: { discord: {} } } });
      expect(result.success).toBe(true);
      expect(result.metadata?.attachmentRecoveryAttempted).toBe(25);
      expect(recoveryFetches).toBe(25);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = originalToken;
      clearMessages(messageIds);
      deleteSyncState(appDb, "discord-api");
    }
  });
});
