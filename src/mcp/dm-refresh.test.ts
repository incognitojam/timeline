import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { deleteSyncState, getAppStateDb, setSyncState } from "../db/app-state";
import { wrapDatabase } from "../db/pool";
import { getDb, initDb } from "../db/schema";
import { JobRunner } from "../jobs/runner";
import { claimNextJob, completeJob, enqueueJob, failJob, getJob, listJobs } from "../jobs/store";
import { CHANNEL_TYPE, setDiscordClientSleepForTests } from "../platforms/discord/client";
import { discordDmsSyncSource } from "../platforms/discord/dm-pass";
import type { DiscordApiSyncState } from "../platforms/discord/sync";
import { syncJobResult } from "../scheduler/job-result";
import { loadSyncConfig, upsertSyncSourcePatch } from "../sync/config";
import { runSyncSource } from "../sync/run";
import { refreshDiscordDms } from "./dm-refresh";
import { runGetUpdates } from "./updates";

const DM = "810000000000000002";
const BASE = 820000000000000000n;
const id = (n: number) => String(BASE + BigInt(n));

/**
 * Fake Discord with one DM, then start the runner; `hold` makes the listing
 * wait until released. The runner starts only once the fake is in place, so
 * no pass can reach the test fetch guard.
 */
function fakeDiscord(ids: string[], hold?: Promise<void>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push(url.pathname);
    if (url.pathname.endsWith("/users/@me")) return Response.json({ id: "user-1", username: "alice" });
    if (url.pathname.endsWith("/users/@me/channels")) {
      await hold;
      return Response.json([{
        id: DM, type: CHANNEL_TYPE.DM, last_message_id: ids.at(-1),
        recipients: [{ id: "u2", username: "bob", global_name: "Bob" }],
      }]);
    }
    if (url.pathname.endsWith(`/channels/${DM}/messages`)) {
      const after = BigInt(url.searchParams.get("after") ?? "0");
      return Response.json(ids.filter((m) => BigInt(m) > after).reverse().map((m) => ({
        id: m, type: 0, content: `dm text ${m}`, channel_id: DM,
        author: { id: "u2", username: "bob", global_name: "Bob", discriminator: "0", avatar: null },
        timestamp: new Date().toISOString(), edited_timestamp: null, tts: false, mention_everyone: false,
        mentions: [], mention_roles: [], attachments: [], embeds: [], reactions: [], pinned: false,
      })));
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  appDb().prepare("DELETE FROM jobs").run();
  runner.start();
  return { listings: () => calls.filter((path) => path.endsWith("/users/@me/channels")).length };
}

const appDb = () => getAppStateDb();
const originalFetch = globalThis.fetch;
const originalToken = process.env.DISCORD_TOKEN;
let runner: JobRunner;

beforeAll(() => setDiscordClientSleepForTests(async () => {}));
afterAll(() => setDiscordClientSleepForTests(null));

beforeEach(() => {
  process.env.DISCORD_TOKEN = `token-${randomUUID()}`;
  for (const key of ["discord-dms", "discord-dms-passed"]) deleteSyncState(appDb(), key);
  setSyncState(appDb(), "discord-api", {
    userId: "user-1", username: "alice", channelCursors: { [DM]: id(1) }, guildSparseCursors: {},
    threadsDiscoveredGuilds: [], knownDMChannelIds: [DM], backfilledDMChannelIds: [],
  } satisfies DiscordApiSyncState);
  appDb().prepare("DELETE FROM jobs WHERE source = 'discord-dms'").run();
  upsertSyncSourcePatch("discord-dms", { enabled: true }, appDb());
  const db = getDb();
  initDb(db);
  db.prepare("DELETE FROM events WHERE source = 'discord'").run();
  db.close();
  // The worker's real runner and lane, with the scheduler's sync step.
  runner = new JobRunner({
    pollIdleMs: 10,
    pollActiveMs: 10,
    overlapSyncSources: ["discord-dms"],
    handlers: {
      sync: async (job, signal, localWork) => {
        // Only the DM pass: earlier files can leave other sources' jobs queued.
        if (job.source !== "discord-dms") throw new Error(`Not the DM pass: ${job.source}`);
        const { result } = await runSyncSource({
          appDb: appDb(), source: discordDmsSyncSource, config: await loadSyncConfig(appDb()),
          intervalMs: 120_000, jobId: job.id, signal, localWork, scheduled: true,
        });
        if (!result.success) throw new Error(result.error);
        return syncJobResult(result);
      },
    },
  });
});

afterEach(async () => {
  await runner.stop(5_000);
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.DISCORD_TOKEN;
  else process.env.DISCORD_TOKEN = originalToken;
});

const getUpdates = async (params: Parameters<typeof runGetUpdates>[1], waitMs?: number) => {
  const db = getDb();
  try {
    const result = await runGetUpdates(wrapDatabase(db), { health_days: 0, ...params }, { waitMs });
    const content = result.content[0];
    if (content?.type !== "text") throw new Error("expected text");
    return content.text;
  } finally {
    db.close();
  }
};
const jobs = () => listJobs({ kind: "sync", source: "discord-dms" }, appDb());
/** The line a reply carries when DMs may be behind. */
const STALE = /^Discord DMs (last synced|have never synced)/m;
const NEVER = "Discord DMs have never synced.";

describe("get_updates refreshes Discord DMs", () => {
  test("a stale pass triggers one pass whose new message is in the reply", async () => {
    const discord = fakeDiscord([id(1), id(2)]);
    const text = await getUpdates({ since: "id:0" });
    expect(text).toContain(`dm text ${id(2)}`);
    expect(text).not.toMatch(STALE);
    expect(discord.listings()).toBe(1);
    expect(jobs()).toHaveLength(1);
  });

  test("calls close together trigger one pass, and a call after it asks Discord for nothing", async () => {
    const discord = fakeDiscord([id(1), id(2)]);
    const [first, second] = await Promise.all([getUpdates({ since: "id:0" }), getUpdates({ since: "id:0", sources: ["discord"] })]);
    expect(discord.listings()).toBe(1);
    const third = await getUpdates({ since: "id:0" });
    for (const text of [first, second, third]) expect(text).toContain(`dm text ${id(2)}`);
    expect(discord.listings()).toBe(1);
    expect(jobs()).toHaveLength(1);
  });

  test("a slow pass leaves the reply in time with when DMs last synced", async () => {
    let release = () => {};
    fakeDiscord([id(1), id(2)], new Promise<void>((resolve) => { release = resolve; }));
    const passedAt = new Date(Date.now() - 4.5 * 60_000).toISOString();
    setSyncState(appDb(), "discord-dms-passed", { at: passedAt });
    try {
      // Answers while the listing is still held.
      const text = await getUpdates({ since: "id:0" }, 100);
      expect(text.split("\n")[1]).toBe(`Discord DMs last synced ${passedAt.slice(0, 16).replace("T", " ")}.`);
      expect(text).not.toContain(`dm text ${id(2)}`);
    } finally {
      release();
    }
  });

  test("a call while a pass is claimed and running joins it instead of queuing another", async () => {
    let release = () => {};
    const discord = fakeDiscord([id(1), id(2)], new Promise<void>((resolve) => { release = resolve; }));
    try {
      expect(await getUpdates({ since: "id:0" }, 100)).toMatch(STALE);
      const [running] = jobs();
      expect(running?.status).toBe("running");
      expect(await getUpdates({ since: "id:0" }, 100)).toMatch(STALE);
      expect(jobs().map((job) => job.id)).toEqual([running?.id]);
    } finally {
      release();
    }
    const done = jobs()[0]?.id ?? 0;
    while (getJob(done, appDb())?.status === "running") await Bun.sleep(10);
    const text = await getUpdates({ since: "id:0" });
    expect(text).toContain(`dm text ${id(2)}`);
    expect(text).not.toMatch(STALE);
    expect(discord.listings()).toBe(1);
    expect(jobs()).toHaveLength(1);
  });

  test("a pass that finishes between the refresh's reads counts as fresh and is not asked for again", async () => {
    // A running pass, claimed here, no runner: it finishes just after the refresh reads the stamp.
    const { jobId } = enqueueJob({ kind: "sync", source: "discord-dms", dedupeKey: "sync:discord-dms", trigger: "scheduler" }, appDb());
    expect(claimNextJob({ workerId: "test", leaseMs: 60_000, syncSource: "discord-dms" }, appDb())?.id).toBe(jobId);
    const real = appDb();
    let finished = false;
    const appDbFinishingOnStampRead = new Proxy(real, {
      get(target, key) {
        if (key !== "prepare") return Reflect.get(target, key, target);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (finished || !sql.includes("FROM sync_state")) return statement;
          return new Proxy(statement, {
            get(st, k) {
              if (k !== "get") return Reflect.get(st, k, st);
              return (...args: unknown[]) => {
                const row = st.get(...(args as []));
                if (args[0] === "discord-dms-passed") {
                  finished = true;
                  setSyncState(target, "discord-dms-passed", { at: new Date().toISOString() });
                  completeJob(jobId, null, target);
                }
                return row;
              };
            },
          });
        };
      },
    });
    expect(await refreshDiscordDms({ appDb: appDbFinishingOnStampRead, waitMs: 1_000 })).toBeNull();
    expect(finished).toBe(true);
    expect(jobs().map((job) => job.id)).toEqual([jobId]);
  });

  test("a pass that ended within the window without freshening is not asked for again", async () => {
    const discord = fakeDiscord([id(1), id(2)]);
    const { jobId } = enqueueJob({ kind: "sync", source: "discord-dms", dedupeKey: "sync:discord-dms", notBefore: new Date(Date.now() + 60_000) }, appDb());
    failJob(jobId, "Discord said no", {}, appDb());
    const text = await getUpdates({ since: "id:0" });
    expect(text).toContain(NEVER);
    expect(discord.listings()).toBe(0);
    expect(jobs()).toHaveLength(1);
  });

  test("a backing-off pass is not asked for; the reply says DMs have never synced", async () => {
    const discord = fakeDiscord([id(1), id(2)]);
    setSyncState(appDb(), "discord-dms", { failures: 1, retryAt: new Date(Date.now() + 60_000).toISOString() });
    const text = await getUpdates({ since: "id:0" });
    expect(text).toContain(NEVER);
    expect(discord.listings()).toBe(0);
    expect(jobs()).toHaveLength(0);
  });

  test("a disabled source adds no line and no wait", async () => {
    const discord = fakeDiscord([id(1), id(2)]);
    upsertSyncSourcePatch("discord-dms", { enabled: false }, appDb());
    const text = await getUpdates({ since: "id:0" });
    expect(text).not.toMatch(STALE);
    expect(discord.listings()).toBe(0);
    expect(jobs()).toHaveLength(0);
  });

  test("a follow-on page, one conversation, or other sources trigger no pass", async () => {
    const discord = fakeDiscord([id(1), id(2)]);
    for (const params of [
      { since: "id:0", until: "id:10" },
      { since: "id:0", skip: 3 },
      { since: "id:0", conversation_id: "some-conversation" },
      { since: "id:0", sources: ["spotify"] },
    ]) {
      expect(await getUpdates(params)).not.toMatch(STALE);
    }
    expect(discord.listings()).toBe(0);
    expect(jobs()).toHaveLength(0);
  });
});
