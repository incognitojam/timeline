import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../db/sqlite";
import { initDb } from "../../db/schema";
import { upsertSyncSourcePatch } from "../../sync/config";
import { importActivityFile, previewActivityFile } from "./activity-import";
import { saveSession } from "./parser";

const providers = { Imdb: "tt123", Tvdb: "12", Tmdb: "13", TmdbCollection: "5", TvRage: "15", sonarr: "16" };

function fixtureItem(episode: boolean, movie: boolean, group: number, title: string, emptyProviders: boolean) {
  if (!episode && !movie) return null;
  return {
    Type: episode
      ? "MediaBrowser.Controller.Entities.TV.Episode"
      : "MediaBrowser.Controller.Entities.Movies.Movie",
    Name: title,
    ProductionYear: 2020,
    SeriesName: episode ? "Copper Clouds" : null,
    SeriesId: episode ? "EFEFEFEF-EFEF-EFEF-EFEF-EFEFEFEFEFEF" : null,
    ParentIndexNumber: episode ? 1 : null,
    IndexNumber: episode && group >= 3 ? group + 1 : null,
    RunTimeTicks: 36000000000,
    ProviderIds: emptyProviders ? {} : providers,
  };
}

test("preview and import mixed export shapes with synthetic playback rows", async () => {
  const users = ["AB".repeat(16), "CD".repeat(16)].map((s) =>
    s.replace(/^(........)(....)(....)(....)(............)$/, "$1-$2-$3-$4-$5"),
  );
  const settingsUsers = users.map((s) => s.replaceAll("-", "").toLowerCase());
  upsertSyncSourcePatch("jellyfin", { settings: { users: settingsUsers, timezone: "Europe/London" } });
  const server = "a".repeat(32);
  const header = {
    format: "jellyfin-activity",
    version: 1,
    exportedAt: "2026-11-23T12:00:00Z",
    serverId: server,
    timeZone: "Europe/London",
    users,
  };
  const lines = [JSON.stringify(header)];
  const since = Date.parse("2024-03-05T08:00:00Z"),
    until = Date.parse("2026-11-23T08:00:00Z");
  const overlap = Date.parse("2026-11-01T08:00:00Z");
  let session: Parameters<typeof saveSession>[2] | undefined;
  for (let i = 0; i < 40; i++) {
    // Paired observations first, then 7 lone starts and 9 lone stops.
    const paired = i < 24,
      group = paired ? Math.floor(i / 2) : i - 12;
    const stop = paired ? i % 2 === 1 : i >= 31;
    const account = (paired ? group >= 10 : i >= 36) ? 1 : 0;
    const id = (group + 1).toString(16).padStart(32, "0");
    const episode = group < 5 || i === 24,
      movie = (group >= 5 && group < 8) || i === 25;
    const title = "Lantern on Paper " + group,
      device = "Screen on Stand";
    const item = fixtureItem(episode, movie, group, title, i < 6);
    const startMs =
      group <= 11 ? since + ((overlap - since) * group) / 11 : overlap + ((until - overlap) * (group - 11)) / (27 - 11);
    const ms = Math.floor(startMs) + (paired && stop ? 600000 : 0);
    const seconds = new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    const digits = 4 + [25, 34, 39].filter((limit) => i < limit).length;
    const date = seconds + "." + "1234567".slice(0, digits);
    lines.push(
      JSON.stringify({
        Id: i + 1,
        Type: stop ? "VideoPlaybackStopped" : "VideoPlayback",
        DateCreated: date,
        UserId: users[account],
        ItemId: i === 39 ? null : id,
        Name:
          "Viewer " +
          (stop ? "has finished playing" : "is playing") +
          " " +
          (episode ? "Copper Clouds - " : "") +
          title +
          " on " +
          device,
        item,
      }),
    );
    if (group === 11 && !stop)
      session = {
        RowId: "1",
        DateCreated: new Date(ms + 20000).toISOString().slice(0, 19).replace("T", " "),
        UserId: settingsUsers[account],
        ItemId: id,
        ItemType: "Movie",
        ItemName: title,
        ClientName: "Example",
        DeviceName: device,
        PlaybackMethod: "DirectPlay",
        PlayDuration: "580",
      };
  }
  const body = lines.join("\n") + "\n";
  const path = join(await mkdtemp(join(tmpdir(), "shape-test-")), "fixture.jsonl");
  await Bun.write(
    path,
    body + JSON.stringify({ count: 40, sha256: createHash("sha256").update(body).digest("hex") }) + "\n",
  );
  using db = new Database(":memory:");
  initDb(db);
  if (!session) throw new Error("Missing synthetic overlap");
  saveSession(db, server + "/" + session.UserId, session, "UTC");
  // An owner trying the draft may still be running the previous schema.
  db.exec("DROP TABLE jellyfin_activity_evidence");
  const preview = await previewActivityFile(db, path);
  expect(db.query("SELECT name FROM sqlite_schema WHERE name='jellyfin_activity_evidence'").get()).toBeNull();
  initDb(db);
  expect(preview.metadata).toEqual({
    rowsAccepted: 40,
    createdEstimated: 11,
    createdUnknown: 7,
    updatedEstimated: 0,
    updatedUnknown: 0,
    rowsNew: 40,
    rowsEnriched: 0,
    evidenceOnlyStops: 9,
    supersededRows: 2,
    skippedAlreadyStored: 0,
  });
  expect(db.query("SELECT COUNT(*) AS n FROM jellyfin_activity_evidence").get()).toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
  expect(await importActivityFile(db, path)).toEqual(preview);
  expect(
    db.query("SELECT user_id,count(*) AS n FROM jellyfin_activity_evidence GROUP BY user_id ORDER BY user_id").all(),
  ).toEqual([
    { user_id: settingsUsers[0], n: 32 },
    { user_id: settingsUsers[1], n: 8 },
  ]);
  expect(
    db
      .query("SELECT type,count(*) AS n FROM events WHERE source_id LIKE 'activity/%' GROUP BY type ORDER BY type")
      .all(),
  ).toEqual([
    { type: "jellyfin:activity", n: 8 },
    { type: "jellyfin:episode", n: 6 },
    { type: "jellyfin:movie", n: 4 },
  ]);
  const rawRows = db
    .query<{ raw_data: string }, []>("SELECT raw_data FROM jellyfin_activity_evidence ORDER BY log_id")
    .all()
    .map(({ raw_data }) => JSON.parse(raw_data));
  expect(rawRows.filter((r) => r.item === null)).toHaveLength(22);
  expect(rawRows.filter((r) => r.ItemId === null)).toHaveLength(1);
  const episodes = rawRows.filter((r) => r.item?.Type === "MediaBrowser.Controller.Entities.TV.Episode");
  expect(episodes).toHaveLength(11);
  expect(episodes.filter((r) => r.item.IndexNumber === null)).toHaveLength(6);
  expect(episodes[0].item.SeriesId).toBe("EFEFEFEF-EFEF-EFEF-EFEF-EFEFEFEFEFEF");
  expect(rawRows.filter((r) => r.item && Object.keys(r.item.ProviderIds).length === 0)).toHaveLength(6);
  expect(episodes[6].item.ProviderIds).toEqual(providers);
  expect(rawRows[0].UserId).toBe(users[0]);
  const fractions = [4, 5, 6, 7].map((n) => rawRows.filter((r) => r.DateCreated.split(".")[1].length === n).length);
  expect(fractions).toEqual([1, 5, 9, 25]);
  const replay = await previewActivityFile(db, path);
  expect(replay.eventsAdded).toBe(0);
  expect(replay.metadata).toMatchObject({
    skippedAlreadyStored: 40,
    rowsNew: 0,
    rowsEnriched: 0,
    supersededRows: 0,
    evidenceOnlyStops: 0,
  });
});
