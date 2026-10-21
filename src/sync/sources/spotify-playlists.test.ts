import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "../../db/schema";
import { initAppStateDb } from "../../db/app-state";
import {
  extractPlaylistId,
  earliestValidAddedAt,
  SpotifyApiError,
  type SpotifyPlaylistFollowers,
} from "../../parsers/spotify-api";
import {
  parsePlaylistConfig,
  syncPlaylistFollowsWithDb,
} from "./spotify-playlists";
import {
  getPlaylistObservations,
  getPlaylistMeta,
  recordPlaylistObservation,
  recordPlaylistCreatedAt,
} from "../../db/playlist-follows";

const NOW = new Date("2026-05-29T10:00:00.000Z");

function followers(
  id: string,
  count: number,
  name = `Playlist ${id}`,
  imageUrl: string | null = null,
): SpotifyPlaylistFollowers {
  return { id, name, followerCount: count, ownerName: "Owner", imageUrl };
}

function freshDbs(): { db: Database; appDb: Database } {
  const db = new Database(":memory:");
  initDb(db);
  const appDb = new Database(":memory:");
  initAppStateDb(appDb);
  return { db, appDb };
}

describe("extractPlaylistId", () => {
  test("accepts bare IDs, URIs, and URLs", () => {
    expect(extractPlaylistId("0123456789ABCDEFGHIJKL")).toBe(
      "0123456789ABCDEFGHIJKL",
    );
    expect(extractPlaylistId("spotify:playlist:0123456789ABCDEFGHIJKL")).toBe(
      "0123456789ABCDEFGHIJKL",
    );
    expect(
      extractPlaylistId(
        "https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL?si=example",
      ),
    ).toBe("0123456789ABCDEFGHIJKL");
  });

  test("rejects unrecognized input", () => {
    expect(extractPlaylistId("")).toBeNull();
    expect(extractPlaylistId("not a playlist!")).toBeNull();
    expect(extractPlaylistId("spotify:track:abc")).toBeNull();
  });
});

describe("earliestValidAddedAt", () => {
  test("returns the oldest valid added_at", () => {
    expect(
      earliestValidAddedAt([
        "2023-04-01T00:00:00Z",
        "2021-06-01T12:34:56Z",
        "2024-12-31T00:00:00Z",
      ]),
    ).toBe("2021-06-01T12:34:56Z");
  });

  test("ignores null/undefined and pre-launch (bogus) timestamps", () => {
    expect(
      earliestValidAddedAt([
        null,
        undefined,
        "1970-01-01T00:00:00Z", // default/local-file marker, predates Spotify
        "2019-03-15T00:00:00Z",
      ]),
    ).toBe("2019-03-15T00:00:00Z");
  });

  test("returns null when nothing qualifies", () => {
    expect(earliestValidAddedAt([])).toBeNull();
    expect(earliestValidAddedAt([null, "1970-01-01T00:00:00Z"])).toBeNull();
  });
});

describe("parsePlaylistConfig", () => {
  test("extracts and dedupes valid playlist references", () => {
    const { ids, invalid } = parsePlaylistConfig({
      playlists: [
        "0123456789ABCDEFGHIJKL",
        "https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL",
        "spotify:playlist:abc123",
      ],
    });
    expect(ids).toEqual(["0123456789ABCDEFGHIJKL", "abc123"]);
    expect(invalid).toEqual([]);
  });

  test("collects invalid entries", () => {
    const { ids, invalid } = parsePlaylistConfig({
      playlists: ["good123", "spotify:track:nope", "bad!"],
    });
    expect(ids).toEqual(["good123"]);
    expect(invalid).toEqual(["spotify:track:nope", "bad!"]);
  });

  test("handles missing/empty config", () => {
    expect(parsePlaylistConfig(undefined)).toEqual({ ids: [], invalid: [] });
    expect(parsePlaylistConfig({})).toEqual({ ids: [], invalid: [] });
    expect(parsePlaylistConfig({ playlists: [] })).toEqual({
      ids: [],
      invalid: [],
    });
  });
});

describe("syncPlaylistFollowsWithDb", () => {
  test("records one observation per playlist for today", async () => {
    const { db, appDb } = freshDbs();
    const stats = await syncPlaylistFollowsWithDb(db, appDb, ["p1", "p2"], {
      fetchFollowers: async (id) => followers(id, id === "p1" ? 10 : 20),
      now: NOW,
    });

    expect(stats.recorded).toBe(2);
    expect(stats.missing).toBe(0);
    expect(stats.rateLimited).toBe(false);

    const p1 = getPlaylistObservations(db, "p1");
    expect(p1.length).toBe(1);
    expect(p1[0].observed_date).toBe("2026-05-29");
    expect(p1[0].follower_count).toBe(10);
    expect(p1[0].origin).toBe("api");
    expect(p1[0].name).toBe("Playlist p1");

    // Playlist name cached for listen-event resolution
    const cached = appDb
      .prepare("SELECT name FROM spotify_resources WHERE uri = ?")
      .get("spotify:playlist:p1") as { name: string } | null;
    expect(cached?.name).toBe("Playlist p1");

    db.close();
    appDb.close();
  });

  test("caches the playlist cover art for UI/listen-event lookups", async () => {
    const { db, appDb } = freshDbs();
    await syncPlaylistFollowsWithDb(db, appDb, ["p1"], {
      fetchFollowers: async (id) =>
        followers(id, 7, "Cover Mix", "https://i.scdn.co/image/cover300"),
      now: NOW,
    });

    const cached = appDb
      .prepare("SELECT image_url FROM spotify_resources WHERE uri = ?")
      .get("spotify:playlist:p1") as { image_url: string | null } | null;
    expect(cached?.image_url).toBe("https://i.scdn.co/image/cover300");

    db.close();
    appDb.close();
  });

  test("backfills the resolved name onto earlier nameless rows", async () => {
    const { db, appDb } = freshDbs();
    // A pre-existing seed row imported before the name was known.
    recordPlaylistObservation(db, {
      playlistId: "p1",
      observedDate: "2020-01-01",
      observedAt: "2020-01-01T12:00:00.000Z",
      followerCount: 2,
      origin: "seed",
    });

    await syncPlaylistFollowsWithDb(db, appDb, ["p1"], {
      fetchFollowers: async (id) => followers(id, 50, "Resolved Name"),
      now: NOW,
    });

    const obs = getPlaylistObservations(db, "p1");
    expect(obs.find((o) => o.observed_date === "2020-01-01")?.name).toBe(
      "Resolved Name",
    );
    db.close();
    appDb.close();
  });

  test("counts missing playlists (deleted/private) without recording", async () => {
    const { db, appDb } = freshDbs();
    const stats = await syncPlaylistFollowsWithDb(db, appDb, ["p1", "gone"], {
      fetchFollowers: async (id) => (id === "gone" ? null : followers(id, 5)),
      now: NOW,
    });

    expect(stats.recorded).toBe(1);
    expect(stats.missing).toBe(1);
    expect(getPlaylistObservations(db, "gone").length).toBe(0);
    db.close();
    appDb.close();
  });

  test("stops early on rate limit (429)", async () => {
    const { db, appDb } = freshDbs();
    const calls: string[] = [];
    const stats = await syncPlaylistFollowsWithDb(
      db,
      appDb,
      ["p1", "p2", "p3"],
      {
        fetchFollowers: async (id) => {
          calls.push(id);
          if (id === "p2") throw new SpotifyApiError(429, "rate limited", 5);
          return followers(id, 1);
        },
        now: NOW,
      },
    );

    expect(stats.rateLimited).toBe(true);
    expect(calls).toEqual(["p1", "p2"]); // p3 never attempted
    expect(stats.recorded).toBe(1); // only p1 recorded
    db.close();
    appDb.close();
  });

  test("propagates a permanent (non-retryable) error without retrying", async () => {
    const { db, appDb } = freshDbs();
    let calls = 0;
    await expect(
      syncPlaylistFollowsWithDb(db, appDb, ["p1"], {
        fetchFollowers: async () => {
          calls++;
          throw new SpotifyApiError(401, "unauthorized");
        },
        now: NOW,
        retry: { baseDelayMs: 0 },
      }),
    ).rejects.toThrow("unauthorized");
    expect(calls).toBe(1); // a 401 is permanent — no retries
    db.close();
    appDb.close();
  });

  test("retries transient server errors, then records on success", async () => {
    const { db, appDb } = freshDbs();
    let attempts = 0;
    const stats = await syncPlaylistFollowsWithDb(db, appDb, ["p1"], {
      fetchFollowers: async (id) => {
        attempts++;
        if (attempts < 3) throw new SpotifyApiError(503, "service unavailable");
        return followers(id, 42);
      },
      now: NOW,
      retry: { maxRetries: 3, baseDelayMs: 0 },
    });

    expect(attempts).toBe(3); // two 503s, then success
    expect(stats.recorded).toBe(1);
    expect(getPlaylistObservations(db, "p1")[0].follower_count).toBe(42);
    db.close();
    appDb.close();
  });

  test("retries transient network errors (fetch TypeError)", async () => {
    const { db, appDb } = freshDbs();
    let attempts = 0;
    const stats = await syncPlaylistFollowsWithDb(db, appDb, ["p1"], {
      fetchFollowers: async (id) => {
        attempts++;
        if (attempts === 1) throw new TypeError("fetch failed");
        return followers(id, 7);
      },
      now: NOW,
      retry: { baseDelayMs: 0 },
    });

    expect(attempts).toBe(2);
    expect(stats.recorded).toBe(1);
    db.close();
    appDb.close();
  });

  test("propagates a persistent server error after exhausting retries", async () => {
    const { db, appDb } = freshDbs();
    let attempts = 0;
    await expect(
      syncPlaylistFollowsWithDb(db, appDb, ["p1"], {
        fetchFollowers: async () => {
          attempts++;
          throw new SpotifyApiError(500, "server error");
        },
        now: NOW,
        retry: { maxRetries: 2, baseDelayMs: 0 },
      }),
    ).rejects.toThrow("server error");
    expect(attempts).toBe(3); // initial attempt + 2 retries
    db.close();
    appDb.close();
  });
});

describe("syncPlaylistFollowsWithDb - creation date", () => {
  test("records the creation date from the earliest track add", async () => {
    const { db, appDb } = freshDbs();
    await syncPlaylistFollowsWithDb(db, appDb, ["p1"], {
      fetchFollowers: async (id) => followers(id, 10),
      fetchCreatedAt: async () => "2021-06-01T12:34:56Z",
      now: NOW,
    });

    const meta = getPlaylistMeta(db, "p1");
    expect(meta?.created_at).toBe("2021-06-01T12:34:56Z");
    expect(meta?.checked_at).toBe(NOW.toISOString());
    db.close();
    appDb.close();
  });

  test("skips the created-at fetch when recently checked", async () => {
    const { db, appDb } = freshDbs();
    // Fresh meta: checked today, so the gate should skip the (costly) refetch.
    recordPlaylistCreatedAt(db, {
      playlistId: "p1",
      createdAt: "2021-06-01T12:34:56Z",
      checkedAt: NOW.toISOString(),
    });
    let createdAtCalls = 0;

    await syncPlaylistFollowsWithDb(db, appDb, ["p1"], {
      fetchFollowers: async (id) => followers(id, 10),
      fetchCreatedAt: async () => {
        createdAtCalls++;
        return "2099-01-01T00:00:00Z";
      },
      now: NOW,
    });

    expect(createdAtCalls).toBe(0);
    expect(getPlaylistMeta(db, "p1")?.created_at).toBe("2021-06-01T12:34:56Z");
    db.close();
    appDb.close();
  });

  test("refreshes the created-at when the cached value is stale", async () => {
    const { db, appDb } = freshDbs();
    // Checked >30 days ago, so the gate should refetch.
    recordPlaylistCreatedAt(db, {
      playlistId: "p1",
      createdAt: "2021-06-01T12:34:56Z",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });
    let createdAtCalls = 0;

    await syncPlaylistFollowsWithDb(db, appDb, ["p1"], {
      fetchFollowers: async (id) => followers(id, 10),
      fetchCreatedAt: async () => {
        createdAtCalls++;
        return "2021-06-01T12:34:56Z";
      },
      now: NOW,
    });

    expect(createdAtCalls).toBe(1);
    expect(getPlaylistMeta(db, "p1")?.checked_at).toBe(NOW.toISOString());
    db.close();
    appDb.close();
  });

  test("stops the run when the created-at fetch is rate limited", async () => {
    const { db, appDb } = freshDbs();
    const followerCalls: string[] = [];

    const stats = await syncPlaylistFollowsWithDb(db, appDb, ["p1", "p2"], {
      fetchFollowers: async (id) => {
        followerCalls.push(id);
        return followers(id, 10);
      },
      fetchCreatedAt: async () => {
        throw new SpotifyApiError(429, "rate limited", 5);
      },
      now: NOW,
    });

    expect(stats.rateLimited).toBe(true);
    expect(followerCalls).toEqual(["p1"]); // stopped before p2's follower fetch
    expect(stats.recorded).toBe(1); // p1's follower observation still landed
    expect(getPlaylistMeta(db, "p1")).toBeNull(); // 429 left meta unwritten
    db.close();
    appDb.close();
  });
});
