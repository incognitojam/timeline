import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "./schema";
import {
  recordPlaylistObservation,
  getPlaylistObservations,
  getTrackedPlaylists,
  fillMissingPlaylistName,
  getPlaylistMeta,
  recordPlaylistCreatedAt,
} from "./playlist-follows";

function freshDb(): Database {
  const db = new Database(":memory:");
  initDb(db);
  return db;
}

describe("recordPlaylistObservation", () => {
  test("records and reads back an observation", () => {
    const db = freshDb();
    recordPlaylistObservation(db, {
      playlistId: "abc",
      observedDate: "2024-01-01",
      observedAt: "2024-01-01T12:00:00.000Z",
      followerCount: 10,
      name: "My Mix",
      origin: "seed",
      rawData: { source: "sheet" },
    });

    const obs = getPlaylistObservations(db, "abc");
    expect(obs.length).toBe(1);
    expect(obs[0].follower_count).toBe(10);
    expect(obs[0].name).toBe("My Mix");
    expect(obs[0].origin).toBe("seed");
    expect(JSON.parse(obs[0].raw_data ?? "{}")).toEqual({ source: "sheet" });
    db.close();
  });

  test("upserts within the same day - latest reading wins", () => {
    const db = freshDb();
    recordPlaylistObservation(db, {
      playlistId: "abc",
      observedDate: "2024-01-01",
      observedAt: "2024-01-01T06:00:00.000Z",
      followerCount: 10,
      origin: "api",
    });
    recordPlaylistObservation(db, {
      playlistId: "abc",
      observedDate: "2024-01-01",
      observedAt: "2024-01-01T18:00:00.000Z",
      followerCount: 12,
      origin: "api",
    });

    const obs = getPlaylistObservations(db, "abc");
    expect(obs.length).toBe(1);
    expect(obs[0].follower_count).toBe(12);
    expect(obs[0].observed_at).toBe("2024-01-01T18:00:00.000Z");
    db.close();
  });

  test("does not let an older out-of-order reading clobber a newer one", () => {
    const db = freshDb();
    recordPlaylistObservation(db, {
      playlistId: "abc",
      observedDate: "2024-01-01",
      observedAt: "2024-01-01T18:00:00.000Z",
      followerCount: 12,
      origin: "api",
    });
    // Older observed_at arriving later (e.g. a noon seed re-run after a live
    // sync) must not overwrite the newer reading.
    recordPlaylistObservation(db, {
      playlistId: "abc",
      observedDate: "2024-01-01",
      observedAt: "2024-01-01T12:00:00.000Z",
      followerCount: 99,
      origin: "seed",
    });

    const obs = getPlaylistObservations(db, "abc");
    expect(obs.length).toBe(1);
    expect(obs[0].follower_count).toBe(12);
    expect(obs[0].observed_at).toBe("2024-01-01T18:00:00.000Z");
    db.close();
  });

  test("keeps separate rows per day, sorted oldest-first", () => {
    const db = freshDb();
    recordPlaylistObservation(db, {
      playlistId: "abc",
      observedDate: "2024-01-02",
      observedAt: "2024-01-02T12:00:00.000Z",
      followerCount: 12,
      origin: "api",
    });
    recordPlaylistObservation(db, {
      playlistId: "abc",
      observedDate: "2024-01-01",
      observedAt: "2024-01-01T12:00:00.000Z",
      followerCount: 10,
      origin: "api",
    });

    const obs = getPlaylistObservations(db, "abc");
    expect(obs.map((o) => o.observed_date)).toEqual([
      "2024-01-01",
      "2024-01-02",
    ]);
    db.close();
  });

  test("preserves existing name when a later reading omits it", () => {
    const db = freshDb();
    recordPlaylistObservation(db, {
      playlistId: "abc",
      observedDate: "2024-01-01",
      observedAt: "2024-01-01T06:00:00.000Z",
      followerCount: 10,
      name: "My Mix",
      origin: "seed",
    });
    recordPlaylistObservation(db, {
      playlistId: "abc",
      observedDate: "2024-01-01",
      observedAt: "2024-01-01T18:00:00.000Z",
      followerCount: 11,
      origin: "api",
    });

    const obs = getPlaylistObservations(db, "abc");
    expect(obs[0].name).toBe("My Mix");
    expect(obs[0].follower_count).toBe(11);
    db.close();
  });
});

describe("fillMissingPlaylistName", () => {
  test("fills only NULL-name rows and preserves existing names", () => {
    const db = freshDb();
    recordPlaylistObservation(db, {
      playlistId: "abc",
      observedDate: "2024-01-01",
      observedAt: "2024-01-01T12:00:00.000Z",
      followerCount: 5,
      origin: "seed",
    });
    recordPlaylistObservation(db, {
      playlistId: "abc",
      observedDate: "2024-02-01",
      observedAt: "2024-02-01T12:00:00.000Z",
      followerCount: 7,
      name: "Real Name",
      origin: "api",
    });

    const changed = fillMissingPlaylistName(db, "abc", "Backfilled Name");
    expect(changed).toBe(1);

    const obs = getPlaylistObservations(db, "abc");
    expect(obs.find((o) => o.observed_date === "2024-01-01")?.name).toBe(
      "Backfilled Name",
    );
    expect(obs.find((o) => o.observed_date === "2024-02-01")?.name).toBe(
      "Real Name",
    );
    db.close();
  });
});

describe("getTrackedPlaylists", () => {
  test("summarizes latest count and span per playlist, ordered by count", () => {
    const db = freshDb();
    recordPlaylistObservation(db, {
      playlistId: "p1",
      observedDate: "2024-01-01",
      observedAt: "2024-01-01T12:00:00.000Z",
      followerCount: 5,
      name: "One",
      origin: "seed",
    });
    recordPlaylistObservation(db, {
      playlistId: "p1",
      observedDate: "2024-03-01",
      observedAt: "2024-03-01T12:00:00.000Z",
      followerCount: 9,
      name: "One",
      origin: "api",
    });
    recordPlaylistObservation(db, {
      playlistId: "p2",
      observedDate: "2024-02-01",
      observedAt: "2024-02-01T12:00:00.000Z",
      followerCount: 20,
      name: "Two",
      origin: "api",
    });

    const tracked = getTrackedPlaylists(db);
    expect(tracked.map((t) => t.playlist_id)).toEqual(["p2", "p1"]);

    const p1 = tracked.find((t) => t.playlist_id === "p1");
    expect(p1?.latest_count).toBe(9);
    expect(p1?.latest_date).toBe("2024-03-01");
    expect(p1?.first_date).toBe("2024-01-01");
    expect(p1?.observations).toBe(2);
    expect(p1?.created_at).toBeNull(); // no meta recorded yet
    db.close();
  });

  test("includes the creation date once meta is recorded", () => {
    const db = freshDb();
    recordPlaylistObservation(db, {
      playlistId: "p1",
      observedDate: "2024-03-01",
      observedAt: "2024-03-01T12:00:00.000Z",
      followerCount: 9,
      name: "One",
      origin: "api",
    });
    recordPlaylistCreatedAt(db, {
      playlistId: "p1",
      createdAt: "2021-06-01T10:00:00.000Z",
      checkedAt: "2024-03-01T12:00:00.000Z",
    });

    const p1 = getTrackedPlaylists(db).find((t) => t.playlist_id === "p1");
    expect(p1?.created_at).toBe("2021-06-01T10:00:00.000Z");
    db.close();
  });
});

describe("recordPlaylistCreatedAt", () => {
  test("stores and reads back a creation date with checked_at", () => {
    const db = freshDb();
    recordPlaylistCreatedAt(db, {
      playlistId: "abc",
      createdAt: "2021-06-01T10:00:00.000Z",
      checkedAt: "2026-06-11T00:00:00.000Z",
    });

    const meta = getPlaylistMeta(db, "abc");
    expect(meta?.created_at).toBe("2021-06-01T10:00:00.000Z");
    expect(meta?.checked_at).toBe("2026-06-11T00:00:00.000Z");
    db.close();
  });

  test("returns null meta for an unknown playlist", () => {
    const db = freshDb();
    expect(getPlaylistMeta(db, "missing")).toBeNull();
    db.close();
  });

  test("never moves a known creation date later, but always advances checked_at", () => {
    const db = freshDb();
    recordPlaylistCreatedAt(db, {
      playlistId: "abc",
      createdAt: "2021-06-01T10:00:00.000Z",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });
    // A later re-check (e.g. the oldest track was removed) finds a newer
    // earliest-add — creation can't un-happen, so the date must not move.
    recordPlaylistCreatedAt(db, {
      playlistId: "abc",
      createdAt: "2022-09-01T10:00:00.000Z",
      checkedAt: "2026-02-01T00:00:00.000Z",
    });

    const meta = getPlaylistMeta(db, "abc");
    expect(meta?.created_at).toBe("2021-06-01T10:00:00.000Z");
    expect(meta?.checked_at).toBe("2026-02-01T00:00:00.000Z");
    db.close();
  });

  test("adopts an earlier creation date when one is found", () => {
    const db = freshDb();
    recordPlaylistCreatedAt(db, {
      playlistId: "abc",
      createdAt: "2022-09-01T10:00:00.000Z",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });
    recordPlaylistCreatedAt(db, {
      playlistId: "abc",
      createdAt: "2021-06-01T10:00:00.000Z",
      checkedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(getPlaylistMeta(db, "abc")?.created_at).toBe(
      "2021-06-01T10:00:00.000Z",
    );
    db.close();
  });

  test("a null reading keeps an existing date but still advances checked_at", () => {
    const db = freshDb();
    recordPlaylistCreatedAt(db, {
      playlistId: "abc",
      createdAt: "2021-06-01T10:00:00.000Z",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });
    recordPlaylistCreatedAt(db, {
      playlistId: "abc",
      createdAt: null,
      checkedAt: "2026-02-01T00:00:00.000Z",
    });

    const meta = getPlaylistMeta(db, "abc");
    expect(meta?.created_at).toBe("2021-06-01T10:00:00.000Z");
    expect(meta?.checked_at).toBe("2026-02-01T00:00:00.000Z");
    db.close();
  });
});
