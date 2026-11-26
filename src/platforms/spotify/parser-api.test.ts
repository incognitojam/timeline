import { describe, test, expect, spyOn } from "bun:test";
import { getSpotifyResource, initAppStateDb, setSpotifyResource } from "../../db/app-state";
import { Database } from "../../db/sqlite";
import {
  cachePlaylistDetails,
  collectUnknownPlaylistUris,
  fetchPlaylistName,
  lookUpMissingPlaylistImages,
  PLAYLIST_IMAGE_LOOKUPS_PER_RUN,
  SpotifyApiError,
  type SpotifyTokens,
  spotifyTokenExtractor,
  type SpotifyPlayHistoryItem,
} from "./parser-api";

describe("spotify token extraction", () => {
  test("preserves the prior refresh token when a refresh response omits one", () => {
    const tokens = spotifyTokenExtractor(
      { access_token: "new-access", expires_in: 3600 },
      {
        access_token: "old-access",
        refresh_token: "existing-refresh",
        expires_at: 0,
        account_name: "alice",
      },
    );

    expect(tokens.refresh_token).toBe("existing-refresh");
    expect(tokens.account_name).toBe("alice");
  });

  test("uses a rotated refresh token from a refresh response", () => {
    const tokens = spotifyTokenExtractor(
      { access_token: "new-access", refresh_token: "rotated-refresh", expires_in: 3600 },
      { access_token: "old-access", refresh_token: "existing-refresh", expires_at: 0 },
    );

    expect(tokens.refresh_token).toBe("rotated-refresh");
  });

  test("leaves account name absent after a fresh authorization", () => {
    const tokens = spotifyTokenExtractor({ access_token: "new-access", expires_in: 3600 });

    expect(tokens.account_name).toBeUndefined();
  });
});

describe("spotify-api playlist resolution", () => {

  test("fetchPlaylistName returns the cover from the same response, mosaics included", async () => {
    const tokens = { access_token: "token", expires_at: Date.now() + 60_000 } as SpotifyTokens;
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      fetchSpy.mockResolvedValueOnce(Response.json({
        id: "sized",
        name: "Sized",
        images: [
          { url: "https://example.com/640.jpg", height: 640 },
          { url: "https://example.com/300.jpg", height: 300 },
        ],
      }));
      expect(await fetchPlaylistName(tokens, "sized")).toEqual({ name: "Sized", imageUrl: "https://example.com/300.jpg" });
      expect(new URL(String(fetchSpy.mock.calls[0]?.[0])).searchParams.get("fields")).toBe("id,name,images");

      // Spotify's auto-generated four-cover mosaic is a single image with no height.
      fetchSpy.mockResolvedValueOnce(Response.json({
        id: "mosaic",
        name: "Mosaic",
        images: [{ url: "https://example.com/mosaic.jpg", height: null }],
      }));
      expect(await fetchPlaylistName(tokens, "mosaic")).toEqual({ name: "Mosaic", imageUrl: "https://example.com/mosaic.jpg" });

      fetchSpy.mockResolvedValueOnce(Response.json({ id: "bare", name: "Bare", images: null }));
      expect(await fetchPlaylistName(tokens, "bare")).toEqual({ name: "Bare", imageUrl: null });

      fetchSpy.mockResolvedValueOnce(Response.json({ id: "blank", name: "", images: null }));
      expect(await fetchPlaylistName(tokens, "blank")).toEqual({ name: "", imageUrl: null });

      // An ID Spotify rejects is as final as a deleted playlist.
      fetchSpy.mockResolvedValueOnce(new Response("Invalid base62 id", { status: 400 }));
      expect(await fetchPlaylistName(tokens, "x")).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(5);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("collectUnknownPlaylistUris finds unknown URIs", () => {
    const items: SpotifyPlayHistoryItem[] = [
      {
        track: { uri: "spotify:track:1", name: "Track 1", artists: [{ name: "Artist" }] },
        played_at: "2024-01-01T00:00:00Z",
        context: { type: "playlist", uri: "spotify:playlist:known", href: "" },
      },
      {
        track: { uri: "spotify:track:2", name: "Track 2", artists: [{ name: "Artist" }] },
        played_at: "2024-01-01T00:01:00Z",
        context: { type: "playlist", uri: "spotify:playlist:unknown1", href: "" },
      },
      {
        track: { uri: "spotify:track:3", name: "Track 3", artists: [{ name: "Artist" }] },
        played_at: "2024-01-01T00:02:00Z",
        context: { type: "playlist", uri: "spotify:playlist:unknown1", href: "" }, // duplicate
      },
      {
        track: { uri: "spotify:track:4", name: "Track 4", artists: [{ name: "Artist" }] },
        played_at: "2024-01-01T00:03:00Z",
        context: { type: "album", uri: "spotify:album:123", href: "" }, // not playlist
      },
      {
        track: { uri: "spotify:track:5", name: "Track 5", artists: [{ name: "Artist" }] },
        played_at: "2024-01-01T00:04:00Z",
        context: null,
      },
      {
        track: { uri: "spotify:track:6", name: "Track 6", artists: [{ name: "Artist" }] },
        played_at: "2024-01-01T00:05:00Z",
        context: { type: "playlist", uri: "spotify:playlist:unknown2", href: "" },
      },
    ];

    items.push({ track: items[0].track, played_at: "2024-01-01T00:06:00Z" });
    const cache = new Map([["spotify:playlist:known", "Known Playlist"]]);
    const result = collectUnknownPlaylistUris(items, cache);

    expect(result).toHaveLength(2);
    expect(result).toContain("spotify:playlist:unknown1");
    expect(result).toContain("spotify:playlist:unknown2");
    expect(result).not.toContain("spotify:playlist:known");
  });

  test("collectUnknownPlaylistUris skips recently missing playlists", () => {
    const items: SpotifyPlayHistoryItem[] = [
      {
        track: { uri: "spotify:track:1", name: "Track 1", artists: [{ name: "Artist" }] },
        played_at: "2024-01-01T00:00:00Z",
        context: { type: "playlist", uri: "spotify:playlist:unknown1", href: "" },
      },
      {
        track: { uri: "spotify:track:2", name: "Track 2", artists: [{ name: "Artist" }] },
        played_at: "2024-01-01T00:01:00Z",
        context: { type: "playlist", uri: "spotify:playlist:unknown2", href: "" },
      },
    ];

    const cache = new Map<string, string>();
    const nowMs = 1_700_000_000_000;
    const missingCache = { "spotify:playlist:unknown1": nowMs - 30_000 };

    const result = collectUnknownPlaylistUris(items, cache, {
      missingCache,
      nowMs,
      missingTtlMs: 60_000,
    });

    expect(result).toHaveLength(1);
    expect(result).toContain("spotify:playlist:unknown2");
    expect(result).not.toContain("spotify:playlist:unknown1");
  });

  test("collectUnknownPlaylistUris retries expired missing playlists", () => {
    const items: SpotifyPlayHistoryItem[] = [
      {
        track: { uri: "spotify:track:1", name: "Track 1", artists: [{ name: "Artist" }] },
        played_at: "2024-01-01T00:00:00Z",
        context: { type: "playlist", uri: "spotify:playlist:unknown1", href: "" },
      },
    ];

    const cache = new Map<string, string>();
    const nowMs = 1_700_000_000_000;
    const missingCache = { "spotify:playlist:unknown1": nowMs - 120_000 };

    const result = collectUnknownPlaylistUris(items, cache, {
      missingCache,
      nowMs,
      missingTtlMs: 60_000,
    });

    expect(result).toHaveLength(1);
    expect(result).toContain("spotify:playlist:unknown1");
  });
});

describe("spotify-api playlist cover lookups", () => {
  const playlistUri = (n: number) => `spotify:playlist:named${String(n).padStart(2, "0")}`;
  function appDbWithNamedPlaylists(count: number): Database {
    const appDb = new Database(":memory:");
    initAppStateDb(appDb);
    for (let n = 0; n < count; n++) setSpotifyResource(appDb, playlistUri(n), "playlist", `Named ${n}`);
    setSpotifyResource(appDb, "spotify:playlist:covered", "playlist", "Covered", "https://example.com/covered.jpg");
    setSpotifyResource(appDb, "spotify:track:untouched", "track", "Track");
    return appDb;
  }

  test("asks about each named playlist without a cover once, a few per run", async () => {
    const appDb = appDbWithNamedPlaylists(PLAYLIST_IMAGE_LOOKUPS_PER_RUN + 2);
    const asked: string[] = [];
    const lookUp = async (id: string) => {
      asked.push(id);
      if (id === "named00") return { name: "", imageUrl: "https://example.com/new.jpg" };
      if (id === "named01") return null; // private, deleted or Spotify-owned
      return { name: `Renamed ${id}`, imageUrl: id === "named11" ? "https://example.com/late.jpg" : null };
    };

    expect(await lookUpMissingPlaylistImages(appDb, lookUp)).toBe(PLAYLIST_IMAGE_LOOKUPS_PER_RUN);
    expect(asked).toHaveLength(PLAYLIST_IMAGE_LOOKUPS_PER_RUN);
    expect(getSpotifyResource(appDb, playlistUri(0))).toMatchObject({ name: "Named 0", image_url: "https://example.com/new.jpg" });
    expect(getSpotifyResource(appDb, playlistUri(1))).toMatchObject({ name: "Named 1", image_url: null });

    // The next run takes the rest; none is asked about twice, and covered playlists never.
    expect(await lookUpMissingPlaylistImages(appDb, lookUp)).toBe(2);
    expect(new Set(asked).size).toBe(PLAYLIST_IMAGE_LOOKUPS_PER_RUN + 2);
    expect(getSpotifyResource(appDb, playlistUri(11))?.image_url).toBe("https://example.com/late.jpg");
    expect(await lookUpMissingPlaylistImages(appDb, lookUp)).toBe(0);
    expect(asked).toHaveLength(PLAYLIST_IMAGE_LOOKUPS_PER_RUN + 2);
  });

  test("stops at a rate limit and retries failed lookups on a later run", async () => {
    const appDb = appDbWithNamedPlaylists(3);
    const failing = async (id: string) => {
      if (id === "named00") throw new Error("socket hang up");
      if (id === "named01") throw new SpotifyApiError(429, "Spotify rate limited.");
      return { name: id, imageUrl: null };
    };
    expect(await lookUpMissingPlaylistImages(appDb, failing)).toBe(0);

    const asked: string[] = [];
    expect(await lookUpMissingPlaylistImages(appDb, async (id) => {
      asked.push(id);
      return null;
    })).toBe(3);
    expect(asked).toEqual(["named00", "named01", "named02"]);
  });

  test("keeps a cover Spotify returns with a blank name, and the cached name", async () => {
    const appDb = appDbWithNamedPlaylists(1);
    const tokens = { access_token: "token", expires_at: Date.now() + 60_000 } as SpotifyTokens;
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({
      id: "named00",
      name: "",
      images: [{ url: "https://example.com/blank-name.jpg", height: null }],
    }));
    try {
      expect(await lookUpMissingPlaylistImages(appDb, (id) => fetchPlaylistName(tokens, id))).toBe(1);
    } finally {
      fetchSpy.mockRestore();
    }
    expect(getSpotifyResource(appDb, playlistUri(0))).toMatchObject({
      name: "Named 0",
      image_url: "https://example.com/blank-name.jpg",
    });
  });

  test("retires a URI with no playlist ID without asking Spotify", async () => {
    const appDb = appDbWithNamedPlaylists(0);
    setSpotifyResource(appDb, "spotify:playlist:not an id!", "playlist", "Odd");
    const asked: string[] = [];
    const lookUp = async (id: string) => {
      asked.push(id);
      return null;
    };
    expect(await lookUpMissingPlaylistImages(appDb, lookUp)).toBe(1);
    expect(await lookUpMissingPlaylistImages(appDb, lookUp)).toBe(0);
    expect(asked).toEqual([]);
  });

  const playFrom = (uri: string): SpotifyPlayHistoryItem => ({
    track: { uri: "spotify:track:1", name: "Track 1", artists: [{ name: "Artist" }] },
    played_at: "2024-01-01T00:00:00Z",
    context: { type: "playlist", uri, href: "" },
  });

  test("names new playlists before covers, and marks their covers checked", async () => {
    const appDb = appDbWithNamedPlaylists(1);
    const asked: string[] = [];
    await cachePlaylistDetails(appDb, [playFrom("spotify:playlist:fresh")], new Map(), async (id) => {
      asked.push(id);
      return { name: `Name ${id}`, imageUrl: null };
    });
    expect(asked).toEqual(["fresh", "named00"]);
    expect(getSpotifyResource(appDb, "spotify:playlist:fresh")?.image_checked_at).not.toBeNull();
    // Neither is asked about again.
    await cachePlaylistDetails(appDb, [], new Map(), async (id) => {
      asked.push(id);
      return null;
    });
    expect(asked).toEqual(["fresh", "named00"]);
  });

  test("looks up no covers in a run where naming was rate limited", async () => {
    const appDb = appDbWithNamedPlaylists(1);
    const asked: string[] = [];
    await cachePlaylistDetails(appDb, [playFrom("spotify:playlist:fresh")], new Map(), async (id) => {
      asked.push(id);
      throw new SpotifyApiError(429, "Spotify rate limited.");
    });
    expect(asked).toEqual(["fresh"]);
    expect(getSpotifyResource(appDb, playlistUri(0))?.image_checked_at).toBeNull();
  });
});
