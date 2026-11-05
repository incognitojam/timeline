import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deleteSyncState, getAppStateDb, getSpotifyResource, getSyncState } from "../db/app-state";
import { getDb, initDb } from "../db/schema";
import { SPOTIFY_FRIENDS_CONFIG_PATH, syncSpotifyFriends } from "./spotify-friends";

// Base62 ids round-trip through hex gids, so these are the real conversions.
const TRACK_A = "spotify:track:6rqhFgbbKwnb9MLmUQDhG6";
const TRACK_B = "spotify:track:0VjIjW4GlUZAMYd2vXMi3b";
const ALBUM_GID = "0000000000000000000000000000abcd";
const ALBUM_URI = "spotify:album:0000000000000000000brn";
const ARTIST_GID = "00000000000000000000000000001234";
const ARTIST_URI = "spotify:artist:00000000000000000001da";
const PLAYLIST = "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M";
const ALICE = "spotify:user:alice_spotify";
const TRACK_A_GID = "d3aca7e43e3b452cbfa9ddd2eab9497e";
const BASE_MS = Date.parse("2026-11-01T12:00:00.000Z");
const TRACK_MS = 200_000;

function iso(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

function feedEntity(trackUri: string, offsetMs: number, extra: Record<string, unknown> = {}) {
  return {
    followEntity: {
      uri: ALICE,
      activity: { entityUri: trackUri, isPlaying: true, timestamp: iso(offsetMs), ...extra },
    },
  };
}

interface Stub {
  feed: unknown[];
  feedStatus?: number;
  /** Status for each successive track lookup; 200 once exhausted. */
  trackStatuses?: number[];
  playlistStatus?: number;
  profileStatus?: number;
  calls: string[];
}

let stub: Stub;
const realFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    stub.calls.push(url.pathname);
    if (url.pathname === "/api/server-time") return json({ serverTime: Math.floor(Date.now() / 1000) });
    if (url.pathname === "/api/token") {
      return json({ accessToken: "synthetic-token", accessTokenExpirationTimestampMs: 0, isAnonymous: false });
    }
    if (url.pathname === "/listening-activity/v1/feed") {
      return json({ entities: stub.feed }, stub.feedStatus ?? 200);
    }
    if (url.pathname.startsWith("/metadata/4/track/")) {
      return json(
        {
          name: `Song ${url.pathname.slice(-4)}`,
          duration: TRACK_MS,
          album: {
            gid: ALBUM_GID,
            name: "Test Album",
            cover_group: {
              image: [
                { file_id: "smallcover", size: "SMALL" },
                { file_id: "defaultcover", size: "DEFAULT" },
                { file_id: "largecover", size: "LARGE" },
              ],
            },
          },
          artist: [
            { gid: ARTIST_GID, name: "Test Artist" },
            { gid: ALBUM_GID, name: "Guest Artist" },
          ],
        },
        stub.trackStatuses?.shift() ?? 200,
      );
    }
    if (url.pathname.startsWith("/user-profile-view/v3/profile/")) {
      return json({ name: "Alice Example", image_url: "https://example.com/alice.jpg" }, stub.profileStatus ?? 200);
    }
    if (url.pathname.startsWith("/playlist/v2/playlist/")) {
      return json({ attributes: { name: "Test Playlist" } }, stub.playlistStatus ?? 200);
    }
    throw new Error(`Unexpected request to ${url.host}${url.pathname}`);
  }) as unknown as typeof fetch;
}

function clearEvents(): void {
  const db = getDb();
  initDb(db);
  db.run("DELETE FROM events WHERE source = 'spotify-friends'");
  db.run("DELETE FROM identities WHERE platform = 'spotify'");
  db.close();
  const appDb = getAppStateDb();
  deleteSyncState(appDb, "spotify-friends-sync");
  appDb.run("DELETE FROM spotify_resources");
}

interface StoredEvent {
  source_id: string;
  source_account: string;
  type: string;
  timestamp: string;
  title: string;
  content: string;
  people: string;
  tags: string;
  raw_data: string;
}

function storedEvents(): StoredEvent[] {
  const db = new Database(process.env.TIMELINE_DB_PATH ?? "", { readonly: true });
  const rows = db
    .query("SELECT * FROM events WHERE source = 'spotify-friends' ORDER BY timestamp")
    .all() as StoredEvent[];
  db.close();
  return rows;
}

function insertLegacyEvent(trackUri: string, offsetMs: number): void {
  const db = getDb();
  initDb(db);
  db.prepare(`
    INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, people, tags, raw_data)
    VALUES ('spotify-friends', ?, 'alice_spotify', 'listen:track:friend', ?, 'Old Song', 'Old Song by Old Artist', ?, '[]', ?)
  `).run(
    `spotify:friend:${ALICE}:${trackUri}@${BASE_MS + offsetMs}`,
    iso(offsetMs),
    JSON.stringify(["spotify:alice_spotify"]),
    JSON.stringify({
      timestamp: BASE_MS + offsetMs,
      user: { uri: ALICE, name: "Alice Example" },
      track: { uri: trackUri, name: "Old Song", imageUrl: "https://example.com/old.jpg" },
    }),
  );
  db.close();
}

const hadConfig = existsSync(SPOTIFY_FRIENDS_CONFIG_PATH);

beforeEach(() => {
  mkdirSync(dirname(SPOTIFY_FRIENDS_CONFIG_PATH), { recursive: true });
  writeFileSync(
    SPOTIFY_FRIENDS_CONFIG_PATH,
    JSON.stringify({ sp_dc: "synthetic-cookie", totp_secret: "syntheticsecret", totp_version: 1 }),
  );
  stub = { feed: [], calls: [] };
  installFetch();
  clearEvents();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  if (!hadConfig) rmSync(SPOTIFY_FRIENDS_CONFIG_PATH, { force: true });
});

describe("syncSpotifyFriends", () => {
  test("stores a feed entry with looked-up names under the existing id format", async () => {
    stub.feed = [feedEntity(TRACK_A, 0, { contextUri: PLAYLIST })];

    const stats = await syncSpotifyFriends();

    expect(stats).toEqual({ imported: 1, skipped: 0, friendsCount: 1 });
    const [event] = storedEvents();
    expect(event.source_id).toBe(`spotify:friend:${ALICE}:${TRACK_A}@${BASE_MS}`);
    expect(event.source_account).toBe("alice_spotify");
    expect(event.type).toBe("listen:track:friend");
    expect(event.timestamp).toBe(iso(0));
    expect(event.content).toBe(`${event.title} by Test Artist from Test Album`);
    expect(JSON.parse(event.people)).toEqual(["spotify:alice_spotify"]);
    expect(JSON.parse(event.tags).sort()).toEqual([
      "album:Test Album",
      "artist:Test Artist",
      "playlist:Test Playlist",
    ]);

    const raw = JSON.parse(event.raw_data);
    expect(raw.user).toEqual({ uri: ALICE, name: "Alice Example" });
    expect(raw.track.album).toEqual({ uri: ALBUM_URI, name: "Test Album" });
    expect(raw.track.artist).toEqual({ uri: ARTIST_URI, name: "Test Artist" });
    expect(raw.track.imageUrl).toBe("https://i.scdn.co/image/largecover");
    expect(raw.track.durationMs).toBe(TRACK_MS);
    expect(raw.listeningActivity.activity.entityUri).toBe(TRACK_A);
    expect(stub.calls).toContain(`/metadata/4/track/${TRACK_A_GID}`);
    expect(stub.calls.some((path) => path.startsWith("/v1/"))).toBe(false);

    const db = getDb();
    const identity = db
      .prepare("SELECT display_name, avatar_url FROM identities WHERE platform = 'spotify' AND platform_id = 'alice_spotify'")
      .get();
    db.close();
    expect(identity).toEqual({ display_name: "Alice Example", avatar_url: "https://example.com/alice.jpg" });
    expect(getSpotifyResource(getAppStateDb(), PLAYLIST)?.name).toBe("Test Playlist");
  });

  test("keeps one event while a timestamp moves within a play", async () => {
    stub.feed = [feedEntity(TRACK_A, 0)];
    await syncSpotifyFriends();

    stub.feed = [feedEntity(TRACK_A, 60_000)];
    const stats = await syncSpotifyFriends();

    expect(stats.imported).toBe(0);
    expect(storedEvents()).toHaveLength(1);
    const state = getSyncState<{ lastSyncedTimestamps: Record<string, number> }>(
      getAppStateDb(),
      "spotify-friends-sync",
    );
    expect(state?.lastSyncedTimestamps[ALICE]).toBe(BASE_MS + 60_000);
  });

  test("records a repeat once a full track length has passed", async () => {
    stub.feed = [feedEntity(TRACK_A, 0)];
    await syncSpotifyFriends();

    stub.feed = [feedEntity(TRACK_A, TRACK_MS)];
    await syncSpotifyFriends();

    expect(storedEvents()).toHaveLength(2);
  });

  test("keeps one event when a friend resumes the same track after a long pause", async () => {
    stub.feed = [feedEntity(TRACK_A, 0)];
    await syncSpotifyFriends();

    stub.feed = [feedEntity(TRACK_A, 60_000, { isPlaying: false })];
    await syncSpotifyFriends();

    stub.feed = [feedEntity(TRACK_A, TRACK_MS * 10)];
    await syncSpotifyFriends();

    expect(storedEvents()).toHaveLength(1);
  });

  test("records a different track, and makes no request for an unchanged feed", async () => {
    stub.feed = [feedEntity(TRACK_A, 0)];
    await syncSpotifyFriends();

    stub.feed = [feedEntity(TRACK_B, 30_000)];
    await syncSpotifyFriends();
    expect(storedEvents()).toHaveLength(2);

    stub.calls = [];
    await syncSpotifyFriends();
    expect(stub.calls.filter((path) => path.startsWith("/metadata/"))).toEqual([]);
    expect(storedEvents()).toHaveLength(2);
  });

  test("does not duplicate a listen stored from the old feed", async () => {
    insertLegacyEvent(TRACK_A, -30_000);

    stub.feed = [feedEntity(TRACK_A, 0)];
    const stats = await syncSpotifyFriends();

    expect(stats.imported).toBe(0);
    expect(storedEvents()).toHaveLength(1);
  });

  test("ignores entries that are not a friend's track", async () => {
    stub.feed = [
      feedEntity("spotify:episode:6rqhFgbbKwnb9MLmUQDhG6", 0),
      { followEntity: { uri: ALICE } },
      {},
    ];

    const stats = await syncSpotifyFriends();

    expect(stats).toEqual({ imported: 0, skipped: 3, friendsCount: 0 });
    expect(storedEvents()).toEqual([]);
  });

  test("stores a listen without a name for a playlist it cannot read", async () => {
    stub.feed = [feedEntity(TRACK_A, 0, { contextUri: PLAYLIST })];
    stub.playlistStatus = 404;

    await syncSpotifyFriends();

    const [event] = storedEvents();
    expect(JSON.parse(event.tags)).not.toContain("playlist:Test Playlist");
    expect(JSON.parse(event.raw_data).track.context).toEqual({ uri: PLAYLIST });
  });

  test("uses album and artist names for those contexts without extra requests", async () => {
    stub.feed = [feedEntity(TRACK_A, 0, { contextUri: ALBUM_URI })];

    await syncSpotifyFriends();

    const [event] = storedEvents();
    expect(JSON.parse(event.raw_data).track.context).toEqual({ uri: ALBUM_URI, name: "Test Album" });
    expect(stub.calls.some((path) => path.startsWith("/playlist/"))).toBe(false);
  });

  test("retries a listen whose lookup failed, reporting the failure", async () => {
    stub.feed = [feedEntity(TRACK_A, 0)];
    stub.trackStatuses = [503];

    const failed = await syncSpotifyFriends();
    expect(failed.error).toBe("Track metadata request failed: 503");
    expect(storedEvents()).toEqual([]);

    const retried = await syncSpotifyFriends();
    expect(retried.error).toBeUndefined();
    expect(storedEvents()).toHaveLength(1);
  });

  test("stops at a rate limit, keeping listens already stored and retrying the rest", async () => {
    stub.feed = [
      feedEntity(TRACK_A, 0),
      {
        followEntity: {
          uri: "spotify:user:bob_spotify",
          activity: { entityUri: TRACK_B, isPlaying: true, timestamp: iso(1_000) },
        },
      },
      {
        followEntity: {
          uri: "spotify:user:carol_spotify",
          activity: { entityUri: "spotify:track:1VjIjW4GlUZAMYd2vXMi3b", isPlaying: true, timestamp: iso(2_000) },
        },
      },
    ];
    stub.trackStatuses = [200, 429];

    const limited = await syncSpotifyFriends();

    expect(limited.imported).toBe(1);
    expect(limited.error).toBe("Track metadata request failed: 429");
    expect(stub.calls.filter((path) => path.startsWith("/metadata/"))).toHaveLength(2);
    expect(storedEvents()).toHaveLength(1);

    const retried = await syncSpotifyFriends();

    expect(retried.imported).toBe(2);
    expect(storedEvents()).toHaveLength(3);
  });

  test("keeps a known friend's stored name when the profile can't be fetched", async () => {
    stub.feed = [feedEntity(TRACK_A, 0)];
    await syncSpotifyFriends();

    stub.feed = [feedEntity(TRACK_B, 30_000)];
    stub.profileStatus = 503;
    const stats = await syncSpotifyFriends();

    expect(stats.error).toBeUndefined();
    expect(JSON.parse(storedEvents()[1].raw_data).user.name).toBe("Alice Example");
  });

  test("reports a failed sync when a new friend's profile can't be fetched", async () => {
    stub.feed = [feedEntity(TRACK_A, 0)];
    stub.profileStatus = 503;

    const stats = await syncSpotifyFriends();

    expect(stats.error).toBe("User profile request failed: 503");
    expect(storedEvents()).toEqual([]);
  });

  test("raises when the feed itself fails or changes shape", async () => {
    stub.feedStatus = 429;
    await expect(syncSpotifyFriends()).rejects.toThrow("Listening activity request failed: 429");

    stub.feedStatus = 200;
    stub.feed = [{ followEntity: { uri: ALICE, activity: { entityUri: TRACK_A, timestamp: "not a date" } } }];
    await expect(syncSpotifyFriends()).rejects.toThrow("unparseable timestamp");
  });
});
