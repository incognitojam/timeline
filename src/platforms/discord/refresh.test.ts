import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { createConversationRefreshRoutes } from "../../api/conversation-refresh";
import { deleteSyncState, getAppStateDb, getSyncState, setSyncState } from "../../db/app-state";
import type { QueryExecutor } from "../../db/pool";
import { getDb, initDb } from "../../db/schema";
import { JobRunner } from "../../jobs/runner";
import { enqueueJob, getJob } from "../../jobs/store";
import type { Job } from "../../jobs/types";
import { Scheduler } from "../../scheduler/index";
import { workerTestHooks } from "../../scheduler/worker";
import { upsertSyncSourcePatch } from "../../sync/config";
import type { ServiceConfig } from "../../config";
import type { SyncSource } from "../../sync/types";
import { CHANNEL_TYPE, setDiscordClientSleepForTests } from "./client";
import { MAX_REFRESH_PAGES } from "./refresh";
import type { DiscordApiSyncState } from "./sync";

beforeAll(() => setDiscordClientSleepForTests(async () => {}));
afterAll(() => setDiscordClientSleepForTests(null));

const DM = "810000000000000001";
const FULL_GUILD = "900000000000000001";
const SPARSE_GUILD = "900000000000000002";
const CHANNEL = "910000000000000001"; // a text channel in FULL_GUILD
const THREAD = "910000000000000002"; // a thread under CHANNEL
const EXCLUDED = "910000000000000003"; // excluded from FULL_GUILD
const SPARSE_CHANNEL = "920000000000000001";
const GUILDS = {
  [FULL_GUILD]: { name: "Trail Club", mode: "full", exclude_channels: [EXCLUDED] },
  [SPARSE_GUILD]: { name: "Big Server", mode: "sparse" },
};
const OTHER_DM = "810000000000000002";
const BASE = 820000000000000000n;
const id = (n: number) => String(BASE + BigInt(n));
const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => id(from + i));

interface FakeChannel {
  type: number;
  messages: string[];
  guild_id?: string;
  parent_id?: string;
}

/** Fake Discord: channels by id, each with its messages oldest first. Records every request. */
function fakeDiscord(
  channels: Record<string, FakeChannel>,
  opts: {
    failAfter?: string; paging?: "oldest-first"; attachmentOn?: string;
    /** Answer `after=` this id with the page after next, as if a page went missing. */
    skipPageAfter?: string;
    /** Leave last_message_id out of the channel lookup. */
    noHead?: boolean;
    /** Answer message requests with 404. */
    messagesGone?: boolean;
  } = {},
) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push(`${url.pathname}${url.search}`);
    if (url.hostname === "cdn.discordapp.com") return new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
    if (url.pathname.endsWith("/users/@me")) return Response.json({ id: "user-1", username: "alice" });
    const channelMatch = url.pathname.match(/\/channels\/(\d+)(\/messages)?$/);
    const channelId = channelMatch?.[1];
    const channel = channelId ? channels[channelId] : undefined;
    if (!channelId || !channel) return new Response("{}", { status: 404 });
    if (!channelMatch?.[2]) {
      return Response.json({
        id: channelId, type: channel.type, ...(!opts.noHead && { last_message_id: channel.messages.at(-1) ?? null }),
        guild_id: channel.guild_id, parent_id: channel.parent_id, name: "general",
        recipients: [{ id: "u2", username: "bob", global_name: "Bob" }],
      });
    }
    if (opts.messagesGone) return new Response("{}", { status: 404 });
    let after = BigInt(url.searchParams.get("after") ?? "0");
    if (opts.skipPageAfter && after === BigInt(opts.skipPageAfter)) after += 100n;
    if (opts.failAfter && after >= BigInt(opts.failAfter)) return new Response("{}", { status: 400 });
    const before = url.searchParams.get("before");
    const page = before
      ? channel.messages.filter((m) => BigInt(m) < BigInt(before)).slice(-Number(url.searchParams.get("limit")))
      : channel.messages.filter((m) => BigInt(m) > after).slice(0, 100);
    const body = page.map((m) => message(m, channelId, m === opts.attachmentOn));
    return Response.json(opts.paging === "oldest-first" ? body : body.reverse());
  }) as unknown as typeof fetch;
  return calls;
}

function message(messageId: string, channelId: string, withAttachment: boolean) {
  return {
    id: messageId, type: 0, content: "hi", channel_id: channelId,
    author: { id: "u2", username: "bob", global_name: "Bob", discriminator: "0", avatar: null },
    timestamp: "2026-06-22T12:00:00.000Z", edited_timestamp: null, tts: false, mention_everyone: false,
    mentions: [], mention_roles: [], embeds: [], reactions: [], pinned: false,
    attachments: withAttachment
      ? [{
        id: `${messageId}9`, filename: "photo.png", size: 7, content_type: "image/png",
        url: `https://cdn.discordapp.com/attachments/${channelId}/${messageId}9/photo.png`,
      }]
      : [],
  };
}

function discordState(channelCursors: Record<string, string>, dms = Object.keys(channelCursors)): DiscordApiSyncState {
  return {
    userId: "user-1", username: "alice", channelCursors, guildSparseCursors: {},
    threadsDiscoveredGuilds: [], knownDMChannelIds: dms, backfilledDMChannelIds: [],
  };
}

const cursors = () => getSyncState<DiscordApiSyncState>(getAppStateDb(), "discord-api")?.channelCursors;

/** A stored message, so the conversation exists the way the full sync left it. */
function storeEvent(channelId: string, messageId: string, account = "user-1", guildId?: string) {
  const db = getDb();
  initDb(db);
  const channel = { id: channelId, name: guildId ? "general" : "Bob", guild_id: guildId ?? null, guild_name: guildId ? "Trail Club" : null, category: guildId ? "Chat" : null };
  db.prepare(
    `INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, conversation_id, raw_data)
     VALUES ('discord', ?, ?, ?, '2026-06-21T12:00:00.000Z', 'Bob', 'hi', ?, ?)`,
  ).run(messageId, account, guildId ? "message:guild" : "message:dm", channelId, JSON.stringify({ _channel: channel }));
  db.close();
}

function storedIds(channelId = DM): string[] {
  const db = getDb();
  initDb(db);
  const rows = db.prepare(
    "SELECT source_id FROM events WHERE source = 'discord' AND conversation_id = ? ORDER BY source_id",
  ).all(channelId) as { source_id: string }[];
  db.close();
  return rows.map((row) => row.source_id);
}

function storedAttachments(): number {
  const db = getDb();
  initDb(db);
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM attachments a JOIN events e ON e.id = a.event_id WHERE e.source = 'discord' AND a.status = 'stored'",
  ).get() as { n: number };
  db.close();
  return row.n;
}

const readDb: QueryExecutor = {
  async query<T>(sql: string, ...params: unknown[]) {
    const db = getDb();
    try {
      return db.prepare(sql).all(...(params as never[])) as T[];
    } finally {
      db.close();
    }
  },
  async get<T>(sql: string, ...params: unknown[]) {
    return (await this.query<T>(sql, ...params))[0] ?? null;
  },
};
const routes = createConversationRefreshRoutes(readDb);

async function check(conversationId: string, source = "discord") {
  const res = await routes.request(`/api/conversation/refresh?source=${source}&conversationId=${conversationId}`);
  return res.json() as Promise<{ refreshable: boolean; reason?: string }>;
}

async function click(conversationId = DM, source = "discord") {
  const res = await routes.request("/api/conversation/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, conversationId }),
  });
  return { status: res.status, body: await res.json() as { jobId: number; joined: boolean } | { error: string } };
}

/**
 * The worker's job runner with its real sync handler. Full Discord syncs go
 * to `fullSync`, standing in for the real one so a test can hold the gate.
 */
function startWorker(fullSync: SyncSource["sync"] = async () => ({
  source: "discord", success: true, eventsAdded: 0, eventsUpdated: 0, durationMs: 0,
})) {
  const config = {
    scheduler: { enabled: true, default_interval: "1h", stagger: false },
  } as ServiceConfig;
  const fullDiscord: SyncSource = {
    name: "discord", description: "full sync stand-in", enabled: true, canSync: async () => null, sync: fullSync,
  };
  const scheduler = new Scheduler(config, { syncSources: [fullDiscord] });
  const runner = new JobRunner({
    pollIdleMs: 5, pollActiveMs: 5,
    handlers: workerTestHooks.buildHandlers(scheduler, null),
  });
  runner.start();
  return runner;
}

async function settled(jobId: number): Promise<Job> {
  for (;;) {
    const job = getJob(jobId);
    if (job && !["queued", "running"].includes(job.status)) return job;
    await Bun.sleep(5);
  }
}

async function refreshOnce(conversationId = DM): Promise<Job> {
  const runner = startWorker();
  try {
    const { body } = await click(conversationId);
    if (!("jobId" in body)) throw new Error(body.error);
    return await settled(body.jobId);
  } finally {
    await runner.stop(1000);
  }
}

const originalFetch = globalThis.fetch;
const originalToken = process.env.DISCORD_TOKEN;

beforeEach(() => {
  // A fresh token makes each test's first refresh check the account again.
  process.env.DISCORD_TOKEN = `token-${randomUUID()}`;
  const appDb = getAppStateDb();
  deleteSyncState(appDb, "discord-api");
  appDb.prepare("DELETE FROM jobs").run();
  appDb.prepare("DELETE FROM sync_log").run();
  appDb.prepare("DELETE FROM scheduler_state").run();
  appDb.prepare("DELETE FROM sync_sources").run();
  upsertSyncSourcePatch("discord", { enabled: true, settings: { guilds: GUILDS } }, appDb);
  const db = getDb();
  initDb(db);
  db.prepare("DELETE FROM events WHERE source = 'discord'").run();
  db.close();
  storeEvent(DM, id(1));
  storeEvent(OTHER_DM, id(9000));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
  else process.env.DISCORD_TOKEN = originalToken;
});

describe("Discord conversation refresh", () => {
  test("a quiet DM costs one channel lookup, plus the account check on a new token", async () => {
    const calls = fakeDiscord({ [DM]: { type: CHANNEL_TYPE.DM, messages: [id(1)] } });
    setSyncState(getAppStateDb(), "discord-api", discordState({ [DM]: id(1) }));
    expect(await check(DM)).toEqual({ refreshable: true });

    const first = await refreshOnce();
    expect(first).toMatchObject({ status: "succeeded", result: { eventsAdded: 0, metadata: { moreRemaining: false, requests: 2 } } });
    expect(calls).toEqual(["/api/v10/users/@me", `/api/v10/channels/${DM}`]);

    calls.length = 0;
    const second = await refreshOnce();
    expect(second.result?.metadata).toMatchObject({ requests: 1 });
    expect(calls).toEqual([`/api/v10/channels/${DM}`]);
  });

  test("stores new messages with their attachments and moves only that DM's cursor", async () => {
    const calls = fakeDiscord(
      { [DM]: { type: CHANNEL_TYPE.GROUP_DM, messages: [id(1), id(2), id(3)] }, [OTHER_DM]: { type: CHANNEL_TYPE.DM, messages: [id(9000), id(9001)] } },
      { attachmentOn: id(3) },
    );
    setSyncState(getAppStateDb(), "discord-api", discordState({ [DM]: id(1), [OTHER_DM]: id(9000) }));

    const job = await refreshOnce();

    expect(job).toMatchObject({ status: "succeeded", result: { eventsAdded: 2, metadata: { attachmentsStored: 1, moreRemaining: false } } });
    expect(storedIds()).toEqual([id(1), id(2), id(3)]);
    expect(storedAttachments()).toBe(1);
    expect(cursors()).toEqual({ [DM]: id(3), [OTHER_DM]: id(9000) });
    expect(calls.filter((call) => call.includes(OTHER_DM))).toEqual([]);
    // Not a full sync: no sync_log row, and the scheduler's last run is untouched.
    const appDb = getAppStateDb();
    expect(appDb.prepare("SELECT COUNT(*) AS n FROM sync_log").get()).toEqual({ n: 0 });
    expect(appDb.prepare("SELECT COUNT(*) AS n FROM scheduler_state").get()).toEqual({ n: 0 });
  });

  test("a refresh that fails part-way keeps what it stored, and the next one continues from there", async () => {
    const all = ids(10, 150);
    fakeDiscord({ [DM]: { type: CHANNEL_TYPE.DM, messages: [id(1), ...all] } }, { failAfter: all[99] });
    setSyncState(getAppStateDb(), "discord-api", discordState({ [DM]: id(1) }));

    const failed = await refreshOnce();
    expect(failed).toMatchObject({ status: "failed", error: "Failed to fetch messages: 400" });
    expect(storedIds()).toEqual([id(1), ...all.slice(0, 100)]);
    expect(cursors()?.[DM]).toBe(all[99]);

    fakeDiscord({ [DM]: { type: CHANNEL_TYPE.DM, messages: [id(1), ...all] } });
    const retried = await refreshOnce();
    expect(retried).toMatchObject({ status: "succeeded", result: { eventsAdded: 50 } });
    expect(cursors()?.[DM]).toBe(all[149]);
  });

  test("stops after a few pages and says more remains", async () => {
    const all = ids(10, MAX_REFRESH_PAGES * 100 + 30);
    fakeDiscord({ [DM]: { type: CHANNEL_TYPE.DM, messages: [id(1), ...all] } });
    setSyncState(getAppStateDb(), "discord-api", discordState({ [DM]: id(1) }));

    const job = await refreshOnce();

    expect(job.result).toMatchObject({ eventsAdded: MAX_REFRESH_PAGES * 100, metadata: { moreRemaining: true } });
    expect(cursors()?.[DM]).toBe(all[MAX_REFRESH_PAGES * 100 - 1]);
  });

  test("says more may remain when Discord doesn't report the newest message", async () => {
    const all = ids(10, MAX_REFRESH_PAGES * 100 + 30);
    fakeDiscord({ [DM]: { type: CHANNEL_TYPE.DM, messages: [id(1), ...all] } }, { noHead: true });
    setSyncState(getAppStateDb(), "discord-api", discordState({ [DM]: id(1) }));

    expect((await refreshOnce()).result).toMatchObject({ metadata: { moreRemaining: true } });
  });

  test("fails without moving the cursor past a page Discord skipped", async () => {
    const all = ids(10, 300);
    // Page two starts 100 messages late.
    fakeDiscord({ [DM]: { type: CHANNEL_TYPE.DM, messages: [id(1), ...all] } }, { skipPageAfter: all[99] });
    setSyncState(getAppStateDb(), "discord-api", discordState({ [DM]: id(1) }));

    const job = await refreshOnce();

    expect(job.status).toBe("failed");
    expect(job.error).toEndWith(`saw a page starting at ${all[200]} with ${all[199]} skipped`);
    expect(storedIds()).toEqual([id(1), ...all.slice(0, 100)]);
    expect(cursors()?.[DM]).toBe(all[99]);
  });

  test("fails when the channel's messages are gone after the lookup", async () => {
    fakeDiscord({ [DM]: { type: CHANNEL_TYPE.DM, messages: [id(1), id(2)] } }, { messagesGone: true });
    setSyncState(getAppStateDb(), "discord-api", discordState({ [DM]: id(1) }));

    expect(await refreshOnce()).toMatchObject({ status: "failed", error: "Discord couldn't find this conversation" });
    expect(cursors()?.[DM]).toBe(id(1));
  });

  test("two clicks at once make one job and one set of requests; a click while it runs joins it", async () => {
    const calls = fakeDiscord({ [DM]: { type: CHANNEL_TYPE.DM, messages: [id(1), id(2)] } });
    setSyncState(getAppStateDb(), "discord-api", discordState({ [DM]: id(1) }));

    const [a, b] = (await Promise.all([click(), click()])).map(({ body }) => body as { jobId: number; joined: boolean });
    expect(b.jobId).toBe(a.jobId);
    expect([a.joined, b.joined].sort()).toEqual([false, true]);

    // Hold the job inside its first request, then click again.
    const release = Promise.withResolvers<void>();
    const fake = globalThis.fetch;
    let entered = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      entered = true;
      await release.promise;
      return fake(input);
    }) as typeof fetch;
    const runner = startWorker();
    try {
      while (!entered) await Bun.sleep(5);
      expect(getJob(a.jobId)?.status).toBe("running");
      const c = await click();
      expect(c.body).toEqual({ jobId: a.jobId, joined: true });
      release.resolve();
      expect(await settled(a.jobId)).toMatchObject({ status: "succeeded", result: { eventsAdded: 1 } });
    } finally {
      await runner.stop(1000);
    }
    expect(calls.filter((call) => call.includes("/messages"))).toHaveLength(1);
    expect(getAppStateDb().prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 });
  });

  test("a click during a full Discord sync waits for it, then runs on the cursor it left", async () => {
    const calls = fakeDiscord({ [DM]: { type: CHANNEL_TYPE.DM, messages: [id(1), id(2), id(3)] } });
    setSyncState(getAppStateDb(), "discord-api", discordState({ [DM]: id(1) }));
    const release = Promise.withResolvers<void>();
    let fullSyncRunning = false;
    const runner = startWorker(async () => {
      fullSyncRunning = true;
      await release.promise;
      // The full sync stores id(2) and saves its whole state as it finishes.
      storeEvent(DM, id(2));
      setSyncState(getAppStateDb(), "discord-api", discordState({ [DM]: id(2) }));
      return { source: "discord", success: true, eventsAdded: 1, eventsUpdated: 0, durationMs: 0 };
    });
    try {
      const full = enqueueJob({ kind: "sync", source: "discord", dedupeKey: "sync:discord", trigger: "scheduler" });
      while (!fullSyncRunning) await Bun.sleep(5);

      const { body } = await click();
      if (!("jobId" in body)) throw new Error(body.error);
      await Bun.sleep(50);
      expect(getJob(body.jobId)?.status).toBe("queued");
      expect(calls).toEqual([]);

      release.resolve();
      expect((await settled(full.jobId)).status).toBe("succeeded");
      expect(await settled(body.jobId)).toMatchObject({ status: "succeeded", result: { eventsAdded: 1 } });
    } finally {
      await runner.stop(1000);
    }
    expect(calls.filter((call) => call.includes("/messages"))).toEqual([`/api/v10/channels/${DM}/messages?limit=100&after=${id(2)}`]);
    expect(cursors()?.[DM]).toBe(id(3));
  });

  test("a DM the full sync hasn't collected yet can't be refreshed, so no backfill starts", async () => {
    const calls = fakeDiscord({ [DM]: { type: CHANNEL_TYPE.DM, messages: [id(1), id(2)] } });
    setSyncState(getAppStateDb(), "discord-api", discordState({ [OTHER_DM]: id(9000) }, [DM, OTHER_DM]));

    expect(await check(DM)).toEqual({ refreshable: false, reason: "The full Discord sync hasn't collected this conversation yet" });
    expect(await click()).toEqual({ status: 409, body: { error: "The full Discord sync hasn't collected this conversation yet" } });
    expect(getAppStateDb().prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    expect(calls).toEqual([]);
  });

  test("refuses what isn't a stored conversation of the synced account", async () => {
    setSyncState(getAppStateDb(), "discord-api", discordState({ [DM]: id(1) }));
    storeEvent("840000000000000001", id(800), "someone-else");
    storeEvent("840000000000000001", id(801), "user-1");

    expect((await check("999")).reason).toBe("Not a stored Discord conversation");
    expect((await check("840000000000000001")).reason).toBe("This conversation is stored under more than one Discord account");
    expect((await check(DM, "chatgpt")).reason).toBe("Conversations from this source can't be refreshed one at a time");

    upsertSyncSourcePatch("discord", { enabled: false }, getAppStateDb());
    expect((await check(DM)).reason).toBe("discord sync is turned off");
    upsertSyncSourcePatch("discord", { enabled: true }, getAppStateDb());
    delete process.env.DISCORD_TOKEN;
    expect((await check(DM)).reason).toBe("DISCORD_TOKEN environment variable not set");
  });

  test("fails loudly and stores nothing when Discord pages out of order", async () => {
    fakeDiscord({ [DM]: { type: CHANNEL_TYPE.DM, messages: [id(1), id(2), id(3)] } }, { paging: "oldest-first" });
    setSyncState(getAppStateDb(), "discord-api", discordState({ [DM]: id(1) }));

    const job = await refreshOnce();

    expect(job.status).toBe("failed");
    expect(job.error).toBe(
      `discord refresh: Discord paged channel ${DM} after ${id(1)} out of order: expected newest first, saw ${id(2)} before ${id(3)}`,
    );
    expect(storedIds()).toEqual([id(1)]);
    expect(cursors()?.[DM]).toBe(id(1));
  });

  describe("server channels and threads", () => {
    beforeEach(() => {
      for (const [channel, n] of [[CHANNEL, 1000], [THREAD, 2000], [EXCLUDED, 3000]] as const) storeEvent(channel, id(n), "user-1", FULL_GUILD);
      storeEvent(SPARSE_CHANNEL, id(4000), "user-1", SPARSE_GUILD);
      setSyncState(getAppStateDb(), "discord-api", discordState(
        { [DM]: id(1), [CHANNEL]: id(1000), [THREAD]: id(2000), [EXCLUDED]: id(3000), [SPARSE_CHANNEL]: id(4000) },
        [DM],
      ));
    });

    test("a channel in a fully synced server refreshes like a DM, stored under its server", async () => {
      const calls = fakeDiscord({ [CHANNEL]: { type: CHANNEL_TYPE.GUILD_TEXT, guild_id: FULL_GUILD, messages: [id(1000), id(1001), id(1002)] } });
      expect(await check(CHANNEL)).toEqual({ refreshable: true });

      const job = await refreshOnce(CHANNEL);

      expect(job).toMatchObject({ status: "succeeded", result: { eventsAdded: 2, metadata: { requests: 3 } } });
      expect(calls.filter((call) => call.includes("/guilds/"))).toEqual([]);
      const db = getDb();
      const rows = db.prepare(
        "SELECT type, title FROM events WHERE conversation_id = ? AND source_id IN (?, ?)",
      ).all(CHANNEL, id(1001), id(1002));
      db.close();
      expect(rows).toEqual([
        { type: "message:guild", title: "Trail Club #general" },
        { type: "message:guild", title: "Trail Club #general" },
      ]);
      expect(cursors()?.[CHANNEL]).toBe(id(1002));
    });

    test("a thread refreshes, unless its channel is excluded", async () => {
      fakeDiscord({
        [THREAD]: { type: CHANNEL_TYPE.PUBLIC_THREAD, guild_id: FULL_GUILD, parent_id: CHANNEL, messages: [id(2000), id(2001)] },
      });
      expect(await refreshOnce(THREAD)).toMatchObject({ status: "succeeded", result: { eventsAdded: 1 } });

      fakeDiscord({
        [THREAD]: { type: CHANNEL_TYPE.PUBLIC_THREAD, guild_id: FULL_GUILD, parent_id: EXCLUDED, messages: [id(2000), id(2001), id(2002)] },
      });
      expect(await refreshOnce(THREAD)).toMatchObject({ status: "failed", error: "This thread's channel is excluded from the Discord sync" });
      expect(cursors()?.[THREAD]).toBe(id(2001));
    });

    test("a thread in a server that skips thread discovery can't be refreshed", async () => {
      const calls = fakeDiscord({
        [THREAD]: { type: CHANNEL_TYPE.PUBLIC_THREAD, guild_id: FULL_GUILD, parent_id: CHANNEL, messages: [id(2000), id(2001)] },
      });
      const { body } = await click(THREAD);
      if (!("jobId" in body)) throw new Error(body.error);
      upsertSyncSourcePatch("discord", { settings: { guilds: { ...GUILDS, [FULL_GUILD]: { ...GUILDS[FULL_GUILD], skip_discovery: true } } } }, getAppStateDb());

      // Accepted before the change: the worker sees a thread and refuses it before fetching messages.
      const runner = startWorker();
      try {
        expect(await settled(body.jobId)).toMatchObject({ status: "failed", error: "The Discord sync doesn't follow threads in this server" });
      } finally {
        await runner.stop(1000);
      }
      expect(calls.filter((call) => call.includes("/messages"))).toEqual([]);

      // Once the state knows it as a thread, the route refuses it too.
      const state = getSyncState<DiscordApiSyncState>(getAppStateDb(), "discord-api");
      if (!state) throw new Error("no state");
      setSyncState(getAppStateDb(), "discord-api", { ...state, knownGuildThreadIds: { [FULL_GUILD]: [THREAD] } });
      expect((await check(THREAD)).reason).toBe("The Discord sync doesn't follow threads in this server");
    });

    test("a channel in a sparse server can't be refreshed through the route, so nothing is queued or fetched", async () => {
      const calls = fakeDiscord({ [SPARSE_CHANNEL]: { type: CHANNEL_TYPE.GUILD_TEXT, guild_id: SPARSE_GUILD, messages: [id(4000), id(4001)] } });
      const reason = "This server is synced sparsely, so its channels can't be refreshed one at a time";

      expect(await check(SPARSE_CHANNEL)).toEqual({ refreshable: false, reason });
      expect(await click(SPARSE_CHANNEL)).toEqual({ status: 409, body: { error: reason } });
      expect(getAppStateDb().prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
      expect(calls).toEqual([]);
    });

    test("a refresh accepted before its server turned sparse fails without fetching messages", async () => {
      const calls = fakeDiscord({ [CHANNEL]: { type: CHANNEL_TYPE.GUILD_TEXT, guild_id: FULL_GUILD, messages: [id(1000), id(1001)] } });
      const { body } = await click(CHANNEL);
      if (!("jobId" in body)) throw new Error(body.error);
      upsertSyncSourcePatch("discord", { settings: { guilds: { ...GUILDS, [FULL_GUILD]: { mode: "sparse" } } } }, getAppStateDb());

      const runner = startWorker();
      try {
        expect(await settled(body.jobId)).toMatchObject({
          status: "failed", error: "This server is synced sparsely, so its channels can't be refreshed one at a time",
        });
      } finally {
        await runner.stop(1000);
      }
      expect(calls).toEqual([]);
    });

    test("refuses excluded channels and servers the sync no longer follows", async () => {
      expect((await check(EXCLUDED)).reason).toBe("This channel is excluded from the Discord sync");
      upsertSyncSourcePatch("discord", { settings: { guilds: { [SPARSE_GUILD]: GUILDS[SPARSE_GUILD] } } }, getAppStateDb());
      expect((await check(CHANNEL)).reason).toBe("The Discord sync no longer follows this server");
    });

    test("fails when Discord moved the channel to another server, and remembers a refused channel", async () => {
      fakeDiscord({ [CHANNEL]: { type: CHANNEL_TYPE.GUILD_TEXT, guild_id: "999", messages: [id(1000), id(1001)] } });
      expect(await refreshOnce(CHANNEL)).toMatchObject({ status: "failed", error: "Discord says this channel belongs to another server" });

      globalThis.fetch = (async (input: RequestInfo | URL) =>
        String(input).endsWith("/users/@me") ? Response.json({ id: "user-1", username: "alice" }) : new Response("{}", { status: 403 })
      ) as typeof fetch;
      expect(await refreshOnce(CHANNEL)).toMatchObject({ status: "failed", error: "Discord refused access to this conversation" });
      expect((await check(CHANNEL)).reason).toBe("Discord refused access to this conversation recently");
    });
  });
});
