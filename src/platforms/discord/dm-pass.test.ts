import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { randomUUID } from "crypto";
import { deleteSyncState, getAppStateDb, getSyncState, setSyncState } from "../../db/app-state";
import { getDb, initDb } from "../../db/schema";
import { LocalWorkGate } from "../../jobs/local-work";
import { claimNextJob, completeJob, enqueueJob } from "../../jobs/store";
import { runSourceOnce } from "../../sync/once";
import { runSyncSource } from "../../sync/run";
import { CHANNEL_TYPE, setDiscordClientSleepForTests } from "./client";
import { discordDmsSyncSource } from "./dm-pass";
import type { DiscordApiSyncState } from "./sync";

beforeAll(() => setDiscordClientSleepForTests(async () => {}));
afterAll(() => setDiscordClientSleepForTests(null));

const QUIET = "810000000000000001"; // a DM with nothing new
const BUSY = "810000000000000002"; // a DM with new messages
const BASE = 820000000000000000n;
const id = (n: number) => String(BASE + BigInt(n));

/** Fake Discord: the DM listing and each channel's messages, oldest first. */
function fakeDiscord(
  messages: Record<string, string[]>,
  opts: { failAfter?: string; listing429Once?: boolean; forbidden?: string; onMessages?: () => void; on429?: () => void } = {},
) {
  const calls: string[] = [];
  let listing429 = opts.listing429Once ?? false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push(url.pathname);
    if (url.pathname.endsWith("/users/@me")) return Response.json({ id: "user-1", username: "alice" });
    if (url.pathname.endsWith("/users/@me/channels")) {
      if (listing429) {
        listing429 = false;
        opts.on429?.();
        return new Response("{}", { status: 429, headers: { "Retry-After": "0" } });
      }
      return Response.json(Object.entries(messages).map(([channelId, ids]) => ({
        id: channelId,
        type: CHANNEL_TYPE.DM,
        last_message_id: ids.at(-1) ?? null,
        recipients: [{ id: "u2", username: "bob", global_name: "Bob" }],
      })));
    }
    const channelId = url.pathname.match(/\/channels\/(\d+)\/messages$/)?.[1];
    const ids = channelId ? messages[channelId] : undefined;
    if (channelId && channelId === opts.forbidden) return new Response("{}", { status: 403 });
    if (channelId && ids) {
      opts.onMessages?.();
      const after = BigInt(url.searchParams.get("after") ?? "0");
      if (opts.failAfter && after >= BigInt(opts.failAfter)) return new Response("{}", { status: 400 });
      const page = ids.filter((m) => BigInt(m) > after).slice(0, 100);
      // Discord returns a page newest first.
      return Response.json(page.reverse().map((m) => message(m, channelId)));
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

function message(messageId: string, channelId: string) {
  return {
    id: messageId, type: 0, content: "hi", channel_id: channelId,
    author: { id: "u2", username: "bob", global_name: "Bob", discriminator: "0", avatar: null },
    timestamp: "2026-06-22T12:00:00.000Z", edited_timestamp: null, tts: false, mention_everyone: false,
    mentions: [], mention_roles: [], attachments: [], embeds: [], reactions: [], pinned: false,
  };
}

function discordState(channelCursors: Record<string, string>): DiscordApiSyncState {
  return {
    userId: "user-1", username: "alice", channelCursors, guildSparseCursors: {},
    threadsDiscoveredGuilds: [], knownDMChannelIds: Object.keys(channelCursors), backfilledDMChannelIds: [],
  };
}

const cursors = () => getSyncState<DiscordApiSyncState>(getAppStateDb(), "discord-api")?.channelCursors;
const messageFetches = (calls: string[]) => calls.filter((path) => path.endsWith("/messages"));

function storedIds(): string[] {
  const db = getDb();
  initDb(db);
  const rows = db.prepare("SELECT source_id FROM events WHERE source = 'discord' ORDER BY source_id").all() as { source_id: string }[];
  db.close();
  return rows.map((row) => row.source_id);
}

const originalFetch = globalThis.fetch;
const originalToken = process.env.DISCORD_TOKEN;

beforeEach(() => {
  // A fresh token makes each test's first pass check the account again.
  process.env.DISCORD_TOKEN = `token-${randomUUID()}`;
  const appDb = getAppStateDb();
  deleteSyncState(appDb, "discord-api");
  deleteSyncState(appDb, "discord-dms");
  appDb.prepare("DELETE FROM sync_log WHERE source = 'discord-dms'").run();
  appDb.prepare("DELETE FROM jobs WHERE source IN ('discord', 'discord-dms')").run();
  const db = getDb();
  initDb(db);
  db.prepare("DELETE FROM events WHERE source = 'discord'").run();
  db.close();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
  else process.env.DISCORD_TOKEN = originalToken;
  setSystemTime();
});

describe("Discord DM pass", () => {
  test("fetches only the DMs whose last message moved, then idles on one request", async () => {
    const calls = fakeDiscord({ [QUIET]: [id(1)], [BUSY]: [id(2), id(3), id(4)] });

    const first = await runSourceOnce("discord-dms", { state: { "discord-api": discordState({ [QUIET]: id(1), [BUSY]: id(2) }) } });

    expect(first.result).toMatchObject({ success: true, eventsAdded: 2 });
    expect(messageFetches(calls)).toEqual([`/api/v10/channels/${BUSY}/messages`]);
    expect(storedIds()).toEqual([id(3), id(4)]);
    expect(cursors()).toEqual({ [QUIET]: id(1), [BUSY]: id(4) });

    calls.length = 0;
    const idle = await runSourceOnce("discord-dms");
    expect(idle.result).toMatchObject({ skipped: true, metadata: { skipReason: "No new DM messages", requests: 1 } });
    expect(calls).toEqual(["/api/v10/users/@me/channels"]);
  });

  test("a pass that fails part-way keeps each cursor at its last stored message, then backs off", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => id(10 + i));
    // The second page fails: only the first 100 messages are stored.
    const calls = fakeDiscord({ [BUSY]: ids }, { failAfter: ids[99] });

    const failed = await runSourceOnce("discord-dms", { state: { "discord-api": discordState({ [BUSY]: id(1) }) } });

    expect(failed.result).toMatchObject({ success: false, error: "Failed to fetch messages: 400", eventsAdded: 100 });
    expect(storedIds()).toEqual(ids.slice(0, 100));
    expect(cursors()?.[BUSY]).toBe(ids[99]);

    calls.length = 0;
    const next = await runSourceOnce("discord-dms");
    expect(next.result).toMatchObject({ skipped: true, metadata: { skipReason: "Backing off after a failed or rate-limited pass" } });
    expect(calls).toEqual([]);
  });

  test("backs off after a 429 even when the retry succeeded, and resumes once the back-off ends", async () => {
    const calls = fakeDiscord({ [QUIET]: [id(1)] }, { listing429Once: true });
    await runSourceOnce("discord-dms", { state: { "discord-api": discordState({ [QUIET]: id(1) }) } });
    const backoff = getSyncState<{ failures: number; retryAt: string }>(getAppStateDb(), "discord-dms");
    expect(backoff?.failures).toBe(1);

    calls.length = 0;
    expect((await runSourceOnce("discord-dms")).result?.metadata?.skipReason).toBe("Backing off after a failed or rate-limited pass");
    expect(calls).toEqual([]);

    setSystemTime(new Date(Date.parse(backoff?.retryAt ?? "") + 1000));
    expect((await runSourceOnce("discord-dms")).result?.metadata?.skipReason).toBe("No new DM messages");
    expect(getSyncState(getAppStateDb(), "discord-dms")).toBeNull();
  });

  test("saves only its own changes, keeping state another process saved during the pass", async () => {
    const appDb = getAppStateDb();
    fakeDiscord({ [BUSY]: [id(2), id(3)] }, {
      onMessages: () => {
        const latest = getSyncState<DiscordApiSyncState>(appDb, "discord-api");
        if (latest) setSyncState(appDb, "discord-api", { ...latest, guildSparseCursors: { g1: id(99) } });
      },
    });

    await runSourceOnce("discord-dms", { state: { "discord-api": discordState({ [BUSY]: id(2) }) } });

    const saved = getSyncState<DiscordApiSyncState>(appDb, "discord-api");
    expect(saved?.guildSparseCursors).toEqual({ g1: id(99) });
    expect(saved?.channelCursors[BUSY]).toBe(id(3));
  });

  test("stops asking for a DM that answers 403", async () => {
    const calls = fakeDiscord({ [BUSY]: [id(2), id(3)] }, { forbidden: BUSY });
    await runSourceOnce("discord-dms", { state: { "discord-api": discordState({ [BUSY]: id(2) }) } });
    expect(messageFetches(calls)).toHaveLength(1);

    calls.length = 0;
    const next = await runSourceOnce("discord-dms");
    expect(next.result?.metadata?.skipReason).toBe("No new DM messages");
    expect(messageFetches(calls)).toEqual([]);
  });

  test("a DM whose newest message was deleted goes quiet after one fetch", async () => {
    // The listing still names id(3), but only id(2), already stored, exists.
    const calls = fakeDiscord({ [BUSY]: [id(2), id(3)] });
    const listing = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      String(input).includes(`/channels/${BUSY}/messages`) ? Response.json([]) : listing(input)) as typeof fetch;

    const first = await runSourceOnce("discord-dms", { state: { "discord-api": discordState({ [BUSY]: id(2) }) } });
    expect(first.result?.metadata?.skipReason).toBe("No new DM messages");
    expect(cursors()?.[BUSY]).toBe(id(3));

    calls.length = 0;
    await runSourceOnce("discord-dms");
    expect(calls).toEqual(["/api/v10/users/@me/channels"]);
  });

  test("a cancelled pass keeps the back-off count", async () => {
    fakeDiscord({ [QUIET]: [id(1)] });
    const appDb = getAppStateDb();
    const retryAt = new Date(Date.now() - 1000).toISOString();
    const controller = new AbortController();
    controller.abort();

    await runSourceOnce("discord-dms", {
      signal: controller.signal,
      state: { "discord-api": discordState({ [QUIET]: id(1) }), "discord-dms": { failures: 2, retryAt } },
    });

    expect(getSyncState<{ failures: number; retryAt: string }>(appDb, "discord-dms")).toEqual({ failures: 2, retryAt });
  });

  test("backs off after a 429 even when the pass was cancelled during the retry", async () => {
    const controller = new AbortController();
    fakeDiscord({ [QUIET]: [id(1)] }, { listing429Once: true, on429: () => controller.abort() });

    const report = await runSourceOnce("discord-dms", {
      signal: controller.signal, state: { "discord-api": discordState({ [QUIET]: id(1) }) },
    });

    expect(report.result?.metadata).toMatchObject({ cancelled: true, rateLimit429Count: 1 });
    expect(getSyncState<{ failures: number }>(getAppStateDb(), "discord-dms")?.failures).toBe(1);
  });

  test("skips its tick while a full Discord sync job is running", async () => {
    const calls = fakeDiscord({ [BUSY]: [id(2), id(3)] });
    const job = enqueueJob({ kind: "sync", source: "discord" });
    expect(claimNextJob({ workerId: "test", leaseMs: 60_000, syncSource: "discord" })?.id).toBe(job.jobId);

    const report = await runSourceOnce("discord-dms", { state: { "discord-api": discordState({ [BUSY]: id(2) }) } });

    expect(report.result?.metadata?.skipReason).toBe("A full Discord sync is running");
    expect(calls).toEqual([]);
    completeJob(job.jobId, null);
  });

  test("waits for local work, then reads the cursors a full sync advanced meanwhile", async () => {
    const calls = fakeDiscord({ [BUSY]: [id(2), id(3)] });
    await runSourceOnce("discord-dms", { dryRun: true, state: { "discord-api": discordState({ [BUSY]: id(2) }) } });

    // A serial job (here standing in for the full sync) holds local work.
    const gate = new LocalWorkGate();
    const release = Promise.withResolvers<void>();
    const serialJob = gate.run(() => release.promise);
    const pass = discordDmsSyncSource.sync({
      verbose: false, intervalMs: 120_000, localWork: gate, config: { sources: {} },
    });
    while (!calls.includes("/api/v10/users/@me/channels")) await Bun.sleep(1);
    await Bun.sleep(10);
    expect(messageFetches(calls)).toEqual([]);

    // That job stores the new message and moves the cursor before it ends.
    getAppStateDb().prepare("UPDATE sync_state SET state = ? WHERE source = 'discord-api'")
      .run(JSON.stringify(discordState({ [BUSY]: id(3) })));
    release.resolve();
    await serialJob;

    expect((await pass).metadata?.skipReason).toBe("No new DM messages");
    expect(messageFetches(calls)).toEqual([]);
    expect(cursors()?.[BUSY]).toBe(id(3));
  });

  test("repeated idle scheduled passes fold into one sync_log row", async () => {
    fakeDiscord({ [QUIET]: [id(1)] });
    await runSourceOnce("discord-dms", { dryRun: true, state: { "discord-api": discordState({ [QUIET]: id(1) }) } });
    const appDb = getAppStateDb();
    for (let i = 0; i < 3; i++) {
      await runSyncSource({
        appDb, source: discordDmsSyncSource, config: { sources: {} }, intervalMs: 120_000, scheduled: true,
      });
    }
    const rows = appDb.prepare("SELECT skipped, repeat_count FROM sync_log WHERE source = 'discord-dms'").all();
    expect(rows).toEqual([{ skipped: 1, repeat_count: 3 }]);
  });
});
