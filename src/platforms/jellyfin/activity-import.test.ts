import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../db/sqlite";
import { initDb } from "../../db/schema";
import { upsertSyncSourcePatch } from "../../sync/config";
import { importActivityFile } from "./activity-import";
import { reconcileActivity, type ActivityRow } from "./activity";
import { saveSession } from "./parser";

const viewer = "1".repeat(32),
  second = "2".repeat(32),
  other = "9".repeat(32),
  itemId = "3".repeat(32),
  server = "a".repeat(32);
const manifest = {
  format: "jellyfin-activity",
  version: 1,
  exportedAt: "2026-11-26T10:00:00Z",
  timeZone: "America/New_York",
  serverId: server,
  users: [viewer, second],
};
function row(Id: number, stop: boolean, time: string, device = "Screen", user = viewer): ActivityRow {
  return {
    Id,
    Type: stop ? "VideoPlaybackStopped" : "VideoPlayback",
    DateCreated: "2026-11-01 " + time,
    UserId: user,
    ItemId: itemId,
    Name: "Viewer " + (stop ? "has finished playing" : "is playing") + " Copper Meadow on " + device,
    item: {
      Type: "Movie",
      Name: "Copper Meadow",
      ProductionYear: 2020,
      SeriesName: null,
      SeriesId: null,
      IndexNumber: null,
      ParentIndexNumber: null,
      RunTimeTicks: null,
      ProviderIds: { Example: "44" },
    },
  };
}
function encode(rows: ActivityRow[], users = manifest.users) {
  const bytes = [{ ...manifest, users }, ...rows].map((v) => JSON.stringify(v) + "\n").join("");
  return (
    bytes + JSON.stringify({ count: rows.length, sha256: createHash("sha256").update(bytes).digest("hex") }) + "\n"
  );
}
test("activity exports preserve evidence and reconcile overlapping selections atomically", async () => {
  const db = new Database(":memory:");
  initDb(db);
  const path = join(await mkdtemp(join(tmpdir(), "jellyfin-activity-")), "history.jsonl");
  upsertSyncSourcePatch("jellyfin", { settings: { users: [viewer, second], timezone: manifest.timeZone } });
  const load = async (text: string) => {
    await Bun.write(path, text);
    return importActivityFile(db, path);
  };
  const evidence = () => db.query("SELECT COUNT(*) AS n FROM jellyfin_activity_evidence").get();
  const plays = () =>
    db
      .query<
        {
          source_id: string;
          end_timestamp: string | null;
          title: string;
          content: string;
          timestamp: string;
          duration_ms: number | null;
        },
        []
      >(
        "SELECT source_id,title,content,timestamp,end_timestamp,duration_ms FROM events WHERE source='jellyfin' ORDER BY source_id",
      )
      .all();
  try {
    const start = row(1, false, "01:30:00.1234567"),
      stop = row(4, true, "01:50:00.1234567");
    const orphan = { ...row(2, true, "01:35:00", "Screen", second), item: null };
    const lone = { ...row(3, false, "01:40:00", "Phone", second), ItemId: null, item: null };
    expect((await load(encode([start, lone]))).eventsAdded).toBe(2);
    expect((await load(encode([orphan, stop]))).eventsUpdated).toBe(1);
    expect(await load(encode([start, orphan, lone, stop]))).toEqual({ eventsAdded: 0, eventsUpdated: 0 });
    const equivalent = {
      ...start,
      UserId: "11111111-1111-1111-1111-111111111111",
      DateCreated: start.DateCreated.replace(" ", "T") + "Z",
    };
    expect(await load(encode([equivalent]))).toEqual({ eventsAdded: 0, eventsUpdated: 0 });
    expect(evidence()).toEqual({ n: 4 });
    expect(plays()[0]).toMatchObject({
      timestamp: "2026-11-01T01:30:00.123Z",
      end_timestamp: "2026-11-01T01:50:00.123Z",
      content: "Estimated elapsed time: 1200 seconds",
      duration_ms: null,
    });
    expect(plays()[1]).toMatchObject({ title: lone.Name, end_timestamp: null });
    for (const invalid of [
      encode([row(5, false, "02:00:00"), row(6, false, "02:01:00", "Screen", other)]),
      encode([], [other]),
      encode([start]).replace('"count":1', '"count":2'),
      encode([start]).replace("Copper Meadow", "Paper Sea"),
      encode([start]).split("\n").slice(0, -2).join("\n") + "\n",
      encode([{ ...start, Name: "Other sentence" }]),
      encode([{ ...start, UserId: second }]),
    ]) {
      await expect(load(invalid)).rejects.toThrow();
      expect(evidence()).toEqual({ n: 4 });
    }
    const account = server + "/" + viewer;
    saveSession(
      db,
      account,
      {
        RowId: "1",
        DateCreated: "2026-10-31 21:30:20",
        UserId: viewer,
        ItemId: itemId,
        ItemType: "Movie",
        ItemName: "Copper Meadow",
        ClientName: "Example",
        DeviceName: "Screen",
        PlaybackMethod: "DirectPlay",
        PlayDuration: "402",
      },
      manifest.timeZone,
    );
    reconcileActivity(db, account, manifest.timeZone);
    expect(plays()).toHaveLength(2);
    expect(evidence()).toEqual({ n: 4 });
    expect(plays().some((e) => e.source_id === "activity/1")).toBe(false);
    saveSession(
      db,
      server.toUpperCase() + "/" + viewer,
      {
        RowId: "2",
        DateCreated: "2026-11-01 01:20:00",
        UserId: viewer,
        ItemId: itemId,
        ItemType: "Movie",
        ItemName: "Copper Meadow",
        ClientName: "Example",
        DeviceName: "Screen",
        PlaybackMethod: "DirectPlay",
        PlayDuration: "20",
      },
      manifest.timeZone,
    );
    expect((await load(encode([row(7, false, "05:19:59")]))).eventsAdded).toBe(0);
    expect(plays().some((e) => e.source_id === "activity/7")).toBe(false);
    const batch = [
      row(10, false, "04:00:00"),
      row(11, false, "04:01:00"),
      row(12, true, "04:02:00"),
      row(13, false, "04:00:00", "Tablet"),
      row(14, true, "04:10:00", "Tablet"),
      row(15, true, "04:03:00"),
      row(16, false, "04:04:00"),
      row(17, true, "04:05:00"),
    ];
    expect((await load(encode(batch))).eventsAdded).toBe(4);
    expect(plays().find((e) => e.source_id === "activity/16")?.end_timestamp).toBe("2026-11-01T04:05:00.000Z");
    expect(plays().find((e) => e.source_id === "activity/10")?.end_timestamp).toBeNull();
    expect(plays().find((e) => e.source_id === "activity/11")?.end_timestamp).toBeNull();
    expect(plays().find((e) => e.source_id === "activity/13")?.end_timestamp).toBe("2026-11-01T04:10:00.000Z");
    for (const [index, startTime] of ["20:00:50", "21:00:20", "21:01:00"].entries()) {
      saveSession(
        db,
        account,
        {
          RowId: String(index + 3),
          DateCreated: "2026-11-01 " + startTime,
          UserId: viewer,
          ItemId: itemId,
          ItemType: "Movie",
          ItemName: "Copper Meadow",
          ClientName: "Example",
          DeviceName: "Screen",
          PlaybackMethod: "DirectPlay",
          PlayDuration: "100",
        },
        "UTC",
      );
    }
    await load(
      encode([
        row(20, false, "20:00:00"),
        row(21, true, "20:00:10"),
        row(22, false, "20:00:30"),
        row(23, true, "20:50:00"),
        row(24, false, "21:00:00"),
        row(25, true, "21:00:25"),
        row(26, false, "21:00:40"),
        row(27, true, "22:30:00"),
      ]),
    );
    expect(
      plays()
        .filter((e) => ["activity/20", "activity/22", "activity/24", "activity/26"].includes(e.source_id))
        .map((e) => e.source_id),
    ).toEqual(["activity/20"]);
  } finally {
    db.close();
  }
});
