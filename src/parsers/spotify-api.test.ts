import { describe, test, expect } from "bun:test";
import {
  collectUnknownPlaylistUris,
  spotifyTokenExtractor,
  type SpotifyPlayHistoryItem,
} from "./spotify-api";

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
  test("extracts playlist ID from URI", () => {
    const testCases = [
      { uri: "spotify:playlist:0123456789ABCDEFGHIJKL", expected: "0123456789ABCDEFGHIJKL" },
      { uri: "spotify:playlist:abc123XYZ", expected: "abc123XYZ" },
      { uri: "spotify:album:123", expected: null },
      { uri: "invalid", expected: null },
    ];

    for (const { uri, expected } of testCases) {
      const match = uri.match(/spotify:playlist:([a-zA-Z0-9]+)/);
      const result = match ? match[1] : null;
      expect(result).toBe(expected);
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

    const cache = new Map([["spotify:playlist:known", "Known Playlist"]]);
    const result = collectUnknownPlaylistUris(items, cache);

    expect(result).toHaveLength(2);
    expect(result).toContain("spotify:playlist:unknown1");
    expect(result).toContain("spotify:playlist:unknown2");
    expect(result).not.toContain("spotify:playlist:known");
  });

  test("collectUnknownPlaylistUris returns empty for all cached", () => {
    const items: SpotifyPlayHistoryItem[] = [
      {
        track: { uri: "spotify:track:1", name: "Track 1", artists: [{ name: "Artist" }] },
        played_at: "2024-01-01T00:00:00Z",
        context: { type: "playlist", uri: "spotify:playlist:cached1", href: "" },
      },
    ];

    const cache = new Map([["spotify:playlist:cached1", "Cached Playlist"]]);
    const result = collectUnknownPlaylistUris(items, cache);

    expect(result).toHaveLength(0);
  });

  test("collectUnknownPlaylistUris handles items without context", () => {
    const items: SpotifyPlayHistoryItem[] = [
      {
        track: { uri: "spotify:track:1", name: "Track 1", artists: [{ name: "Artist" }] },
        played_at: "2024-01-01T00:00:00Z",
        context: null,
      },
      {
        track: { uri: "spotify:track:2", name: "Track 2", artists: [{ name: "Artist" }] },
        played_at: "2024-01-01T00:01:00Z",
        // context undefined
      },
    ];

    const cache = new Map<string, string>();
    const result = collectUnknownPlaylistUris(items, cache);

    expect(result).toHaveLength(0);
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
