import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { processSource } from "../../inbox/process";
import { upsertSyncSourcePatch } from "../../sync/config";
import { Database } from "../../db/sqlite";
import { getDb } from "../../db/schema";
import { runSourceOnce } from "../../sync/once";

test("imports only selected users, preserves deleted titles and reconciles changed durations", async () => {
  const users = ["1".repeat(32), "2".repeat(32)],
    other = "3".repeat(32),
    item = "a".repeat(32);
  const serverId = "e".repeat(32);
  const plugin = new Database(":memory:");
  plugin.run(
    "CREATE TABLE PlaybackActivity(DateCreated,UserId,ItemId,ItemType,ItemName,PlaybackMethod,ClientName,DeviceName,PlayDuration)",
  );
  for (const user of [...users, other])
    plugin.run("INSERT INTO PlaybackActivity VALUES (?,?,?,?,?,?,?,?,?)", [
      "2026-07-10 20:00:00",
      user,
      item,
      "Movie",
      "The Paper Harbor",
      "DirectPlay",
      "Example Player",
      "Example Screen",
      "300",
    ]);
  let deleted = false,
    mismatch = false;
  const scoped: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      expect(req.headers.get("Authorization")).toBe('MediaBrowser Token="synthetic"');
      if (url.pathname === "/System/Info/Public") return Response.json({ Id: serverId });
      if (url.pathname === "/user_usage_stats/submit_custom_query") {
        const sql = (await req.json()).CustomQueryString;
        const user = /WHERE UserId='([a-f0-9]+)'/.exec(sql)?.[1];
        expect(users).toContain(user!);
        const rows = plugin.query(sql).all() as Record<string, unknown>[];
        scoped.push(user!);
        if (mismatch && rows[0]) rows[0].UserId = other;
        return Response.json({
          colums: Object.keys(rows[0] ?? {}),
          results: rows.map((row) => Object.values(row).map(String)),
          message: "",
        });
      }
      if (url.pathname.endsWith("/Ancestors")) {
        expect(users).toContain(url.searchParams.get("userId")!);
        return Response.json([{ Id: "f".repeat(32) }, { Id: "b".repeat(32) }]);
      }
      expect(url.pathname).toBe("/Items");
      expect(users).toContain(url.searchParams.get("userId")!);
      expect(url.searchParams.get("enableUserData")).toBe("false");
      return Response.json({
        Items: deleted ? [] : [{ Id: item, Name: "Paper Harbor", ProviderIds: { Tmdb: "123" } }],
      });
    },
  });
  const token = process.env.JELLYFIN_TOKEN;
  process.env.JELLYFIN_TOKEN = "synthetic";
  try {
    const config = { users, url: server.url.href, timezone: "America/New_York" };
    const run = () => runSourceOnce("jellyfin", { config });
    upsertSyncSourcePatch("jellyfin", { settings: config });
    const dir = await mkdtemp(join(tmpdir(), "jellyfin-inbox-"));
    const header = {
      format: "jellyfin-activity",
      version: 1,
      serverId,
      timeZone: "America/New_York",
      exportedAt: "2026-11-02T10:00:00Z",
      users,
    };
    const start = {
      Id: 1,
      Type: "VideoPlayback",
      DateCreated: "2026-07-10 23:59:55",
      UserId: users[0],
      ItemId: item,
      Name: "Viewer is playing The Paper Harbor on Example Screen",
      item: null,
    };
    const data = JSON.stringify(header) + "\n" + JSON.stringify(start) + "\n";
    const footer = { count: 1, sha256: createHash("sha256").update(data).digest("hex") };
    await Bun.write(join(dir, "history.jsonl"), data + JSON.stringify(footer) + "\n");
    const inbox = { type: "local" as const, local: dir, parser: "jellyfin-activity", patterns: ["*.jsonl"] };
    const imported = await processSource({ inbox_path: dir, sources: { jellyfin: inbox } }, "jellyfin", inbox, {});
    expect(imported.errors).toEqual([]);
    expect(imported.eventsAdded).toBe(1);
    const first = await run();
    expect(first.events.deleted).toBe(1);
    expect(first.result?.error).toBeUndefined();
    expect(first.events.inserted.count).toBe(2);
    expect(first.events.inserted.samples[0]?.timestamp).toBe("2026-07-11T00:00:00.000Z");
    expect(scoped).toEqual(users);
    expect((await run()).events.updated.count).toBe(0);
    deleted = true;
    plugin.run("UPDATE PlaybackActivity SET PlayDuration='400' WHERE UserId=?", [users[0]]);
    expect((await run()).events.updated.count).toBe(1);
    const rows = getDb()
      .query("SELECT title,duration_ms,raw_data FROM events WHERE source='jellyfin' ORDER BY source_account")
      .all() as { title: string; duration_ms: number; raw_data: string }[];
    expect(rows.map((row) => row.duration_ms)).toEqual([400000, 300000]);
    expect(JSON.parse(rows[0]!.raw_data).item.ProviderIds.Tmdb).toBe("123");
    plugin.run(
      "INSERT INTO PlaybackActivity SELECT '2026-11-01 01:30:00',UserId,ItemId,ItemType,'The Fold',PlaybackMethod,ClientName,DeviceName,PlayDuration FROM PlaybackActivity WHERE UserId=?",
      [users[0]],
    );
    const fold = await run();
    expect(fold.events.inserted.samples[0]?.timestamp).toBeNull();
    expect(fold.events.inserted.samples[0]?.title).toBe("The Fold");
    expect((await run()).events.inserted.count).toBe(0);
    const library = "b".repeat(32);
    const restricted = await runSourceOnce("jellyfin", { config: { ...config, libraries: [library] } });
    expect(restricted.result?.success).toBe(true);
    expect(restricted.events.updated.count).toBe(0);
    deleted = false;
    const nested = await runSourceOnce("jellyfin", { config: { ...config, libraries: [library] } });
    expect(nested.result?.success).toBe(true);
    expect(nested.events.updated.count).toBe(1);
    const selection = scoped.length;
    await expect(runSourceOnce("jellyfin", { config: { ...config, users: [] } })).rejects.toThrow("non-empty array");
    expect(scoped.length).toBe(selection);
    for (let i = 0; i < 102; i++) {
      plugin.run(
        "INSERT INTO PlaybackActivity SELECT ?,UserId,ItemId,ItemType,ItemName,PlaybackMethod,ClientName,DeviceName,PlayDuration FROM PlaybackActivity WHERE rowid=1",
        ["2026-11-02 09:00:00." + String(i).padStart(3, "0")],
      );
    }
    const paged = await run();
    expect(paged.result?.error).toBeUndefined();
    expect(paged.events.inserted.count).toBe(102);
    expect((await run()).events.inserted.count).toBe(0);
    plugin.run("UPDATE PlaybackActivity SET rowid=rowid+1000");
    expect((await run()).events.inserted.count).toBe(0);
    mismatch = true;
    expect((await run()).result?.success).toBe(false);
    expect(
      getDb()
        .query("SELECT 1 FROM events WHERE source_account=?")
        .get(serverId + "/" + other),
    ).toBeNull();
  } finally {
    if (token === undefined) delete process.env.JELLYFIN_TOKEN;
    else process.env.JELLYFIN_TOKEN = token;
    plugin.close();
    await server.stop(true);
  }
});
