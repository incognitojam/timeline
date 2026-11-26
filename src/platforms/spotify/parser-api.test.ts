import { describe, test, expect, spyOn } from "bun:test";
import {
  collectUnknownPlaylistUris,
  fetchPlaylistName,
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
      expect(await fetchPlaylistName(tokens, "blank")).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(4);
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
