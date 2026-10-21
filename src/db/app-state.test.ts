import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  getBlockedNetworks,
  initAppStateDb,
  migrateSourceBlockedNetworks,
  setBlockedNetworks,
  setSpotifyResource,
  getSpotifyResource,
  getTrackImageUrls,
} from "./app-state";

let db: Database;

function setup(): void {
  db = new Database(":memory:");
  initAppStateDb(db);
}

function teardown(): void {
  db.close();
}

describe("sync_log indexes", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("indexes global history by newest start time", () => {
    const index = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_sync_log_started_at") as { sql: string } | null;

    expect(index?.sql).toContain("sync_log(started_at DESC)");
  });
});

describe("spotify_resources image_url", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("stores and retrieves image_url", () => {
    setSpotifyResource(db, "spotify:track:1", "track", "Test Track", "https://i.scdn.co/image/abc");
    const resource = getSpotifyResource(db, "spotify:track:1");
    expect(resource).not.toBeNull();
    expect(resource!.image_url).toBe("https://i.scdn.co/image/abc");
    expect(resource!.name).toBe("Test Track");
    expect(resource!.type).toBe("track");
  });

  test("stores null image_url when not provided", () => {
    setSpotifyResource(db, "spotify:track:2", "track", "No Art Track");
    const resource = getSpotifyResource(db, "spotify:track:2");
    expect(resource).not.toBeNull();
    expect(resource!.image_url).toBeNull();
  });

  test("COALESCE preserves existing image_url when updating without one", () => {
    // Initial insert with image
    setSpotifyResource(db, "spotify:track:3", "track", "Old Name", "https://i.scdn.co/image/original");

    // Update name without providing image — should keep existing image
    setSpotifyResource(db, "spotify:track:3", "track", "New Name");

    const resource = getSpotifyResource(db, "spotify:track:3");
    expect(resource!.name).toBe("New Name");
    expect(resource!.image_url).toBe("https://i.scdn.co/image/original");
  });

  test("explicit image_url overwrites existing one", () => {
    setSpotifyResource(db, "spotify:track:4", "track", "Track", "https://i.scdn.co/image/old");
    setSpotifyResource(db, "spotify:track:4", "track", "Track", "https://i.scdn.co/image/new");

    const resource = getSpotifyResource(db, "spotify:track:4");
    expect(resource!.image_url).toBe("https://i.scdn.co/image/new");
  });
});

describe("getTrackImageUrls", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("returns image URLs for matching URIs", () => {
    setSpotifyResource(db, "spotify:track:a", "track", "Track A", "https://art/a");
    setSpotifyResource(db, "spotify:track:b", "track", "Track B", "https://art/b");
    setSpotifyResource(db, "spotify:track:c", "track", "Track C");

    const result = getTrackImageUrls(db, ["spotify:track:a", "spotify:track:b", "spotify:track:c"]);
    expect(result.size).toBe(2);
    expect(result.get("spotify:track:a")).toBe("https://art/a");
    expect(result.get("spotify:track:b")).toBe("https://art/b");
    expect(result.has("spotify:track:c")).toBe(false);
  });

  test("returns empty map for empty input", () => {
    const result = getTrackImageUrls(db, []);
    expect(result.size).toBe(0);
  });

  test("returns empty map when no URIs match", () => {
    const result = getTrackImageUrls(db, ["spotify:track:nonexistent"]);
    expect(result.size).toBe(0);
  });
});

describe("blocked networks migration", () => {
  beforeEach(setup);
  afterEach(teardown);

  function insertSource(source: string, settings: Record<string, unknown>): void {
    db.prepare("INSERT INTO sync_sources (source, settings) VALUES (?, ?)").run(source, JSON.stringify(settings));
  }

  function settingsFor(source: string): Record<string, unknown> {
    const row = db.prepare("SELECT settings FROM sync_sources WHERE source = ?").get(source) as { settings: string };
    return JSON.parse(row.settings);
  }

  test("merges per-source lists into the shared list and opts those sources in", () => {
    setBlockedNetworks(db, ["Cafe Guest"]);
    insertSource("backup-offsite", { keep_count: 7, blocked_ssids: ["iPhone", "Train WiFi"], require_unmetered: true });
    insertSource("embeddings", { blocked_ssids: ["iphone", "Hotel"] });
    insertSource("emptied", { blocked_ssids: [] });
    insertSource("unguarded", { keep_count: 3 });

    migrateSourceBlockedNetworks(db);

    expect(getBlockedNetworks(db)).toEqual(["Cafe Guest", "iPhone", "Train WiFi", "Hotel"]);
    expect(settingsFor("backup-offsite")).toEqual({ keep_count: 7, require_unmetered: true, skip_blocked_networks: true });
    expect(settingsFor("embeddings")).toEqual({ skip_blocked_networks: true });
    expect(settingsFor("emptied")).toEqual({});
    expect(settingsFor("unguarded")).toEqual({ keep_count: 3 });
  });

  test("runs when the app-state database opens and is idempotent", () => {
    insertSource("backup-offsite", { blocked_ssids: ["iPhone"] });

    initAppStateDb(db);
    initAppStateDb(db);

    expect(getBlockedNetworks(db)).toEqual(["iPhone"]);
    expect(settingsFor("backup-offsite")).toEqual({ skip_blocked_networks: true });
  });

  test("leaves the shared list unset when no source has a per-source list", () => {
    insertSource("unguarded", {});
    migrateSourceBlockedNetworks(db);
    expect(db.prepare("SELECT COUNT(*) AS count FROM app_settings").get()).toEqual({ count: 0 });
    expect(getBlockedNetworks(db)).toEqual([]);
  });

  test("fails loudly on a malformed per-source list", () => {
    insertSource("backup-offsite", { blocked_ssids: "iPhone" });
    expect(() => migrateSourceBlockedNetworks(db)).toThrow("[sync.backup-offsite].blocked_ssids must be an array of strings");
  });
});
