import { describe, it, expect } from "vitest";
import {
  getAlbumArtUrl,
  getTrackUri,
  getEventAlbumArt,
  getSessionAlbumArts,
  isSpotifyEvent,
} from "./spotify-art";
import type { TimelineEvent } from "./types";

function makeEvent(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 1,
    source: "spotify",
    source_id: "test-1",
    source_account: "test",
    type: "listen:track",
    timestamp: "2024-01-15T12:00:00Z",
    end_timestamp: null,
    duration_ms: null,
    title: "Test Track",
    content: null,
    latitude: null,
    longitude: null,
    location_name: null,
    people: null,
    tags: null,
    raw_data: "{}",
    imported_at: "2024-01-15T00:00:00Z",
    import_batch: null,
    conversation_id: null,
    ...overrides,
  };
}

describe("getAlbumArtUrl", () => {
  it("extracts 300px image from Spotify API format", () => {
    const rawData = JSON.stringify({
      track: {
        album: {
          images: [
            { url: "https://i.scdn.co/image/large", height: 640 },
            { url: "https://i.scdn.co/image/medium", height: 300 },
            { url: "https://i.scdn.co/image/small", height: 64 },
          ],
        },
      },
    });
    expect(getAlbumArtUrl(rawData)).toBe("https://i.scdn.co/image/medium");
  });

  it("falls back to 64px when 300px is missing", () => {
    const rawData = JSON.stringify({
      track: {
        album: {
          images: [
            { url: "https://i.scdn.co/image/large", height: 640 },
            { url: "https://i.scdn.co/image/small", height: 64 },
          ],
        },
      },
    });
    expect(getAlbumArtUrl(rawData)).toBe("https://i.scdn.co/image/small");
  });

  it("falls back to first image when no standard sizes match", () => {
    const rawData = JSON.stringify({
      track: {
        album: {
          images: [{ url: "https://i.scdn.co/image/only", height: 200 }],
        },
      },
    });
    expect(getAlbumArtUrl(rawData)).toBe("https://i.scdn.co/image/only");
  });

  it("extracts imageUrl from Spotify Friends format", () => {
    const rawData = JSON.stringify({
      track: {
        imageUrl: "https://i.scdn.co/image/friends-art",
      },
    });
    expect(getAlbumArtUrl(rawData)).toBe("https://i.scdn.co/image/friends-art");
  });

  it("returns null for file export format (no images)", () => {
    const rawData = JSON.stringify({
      ts: "2024-01-01T00:00:00Z",
      ms_played: 180000,
      master_metadata_track_name: "Song",
      spotify_track_uri: "spotify:track:abc",
    });
    expect(getAlbumArtUrl(rawData)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(getAlbumArtUrl("not json")).toBeNull();
  });

  it("returns null for empty images array", () => {
    const rawData = JSON.stringify({ track: { album: { images: [] } } });
    expect(getAlbumArtUrl(rawData)).toBeNull();
  });
});

describe("getTrackUri", () => {
  it("extracts URI from API format", () => {
    const rawData = JSON.stringify({ track: { uri: "spotify:track:abc123" } });
    expect(getTrackUri(rawData)).toBe("spotify:track:abc123");
  });

  it("extracts URI from file export format", () => {
    const rawData = JSON.stringify({ spotify_track_uri: "spotify:track:xyz789" });
    expect(getTrackUri(rawData)).toBe("spotify:track:xyz789");
  });

  it("returns null when no URI present", () => {
    const rawData = JSON.stringify({ ts: "2024-01-01" });
    expect(getTrackUri(rawData)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(getTrackUri("{broken")).toBeNull();
  });
});

describe("getEventAlbumArt", () => {
  it("prefers raw_data URL over imageMap", () => {
    const event = makeEvent({
      raw_data: JSON.stringify({
        track: { uri: "spotify:track:1", imageUrl: "https://i.scdn.co/from-raw" },
      }),
    });
    const imageMap = new Map([["spotify:track:1", "https://i.scdn.co/from-cache"]]);
    expect(getEventAlbumArt(event, imageMap)).toBe("https://i.scdn.co/from-raw");
  });

  it("falls back to imageMap when raw_data has no image", () => {
    const event = makeEvent({
      raw_data: JSON.stringify({ spotify_track_uri: "spotify:track:2" }),
    });
    const imageMap = new Map([["spotify:track:2", "https://i.scdn.co/cached"]]);
    expect(getEventAlbumArt(event, imageMap)).toBe("https://i.scdn.co/cached");
  });

  it("returns null when neither source has an image", () => {
    const event = makeEvent({
      raw_data: JSON.stringify({ spotify_track_uri: "spotify:track:3" }),
    });
    const imageMap = new Map<string, string>();
    expect(getEventAlbumArt(event, imageMap)).toBeNull();
  });

  it("returns null with no imageMap and no raw_data image", () => {
    const event = makeEvent({ raw_data: JSON.stringify({}) });
    expect(getEventAlbumArt(event)).toBeNull();
  });
});

describe("getSessionAlbumArts", () => {
  it("collects unique album art URLs", () => {
    const events = [
      makeEvent({ id: 1, raw_data: JSON.stringify({ track: { imageUrl: "https://art/a" } }) }),
      makeEvent({ id: 2, raw_data: JSON.stringify({ track: { imageUrl: "https://art/b" } }) }),
      makeEvent({ id: 3, raw_data: JSON.stringify({ track: { imageUrl: "https://art/c" } }) }),
    ];
    expect(getSessionAlbumArts(events)).toEqual(["https://art/a", "https://art/b", "https://art/c"]);
  });

  it("deduplicates URLs from the same album", () => {
    const events = [
      makeEvent({ id: 1, raw_data: JSON.stringify({ track: { imageUrl: "https://art/same" } }) }),
      makeEvent({ id: 2, raw_data: JSON.stringify({ track: { imageUrl: "https://art/same" } }) }),
      makeEvent({ id: 3, raw_data: JSON.stringify({ track: { imageUrl: "https://art/different" } }) }),
    ];
    expect(getSessionAlbumArts(events)).toEqual(["https://art/same", "https://art/different"]);
  });

  it("respects maxCount limit", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ id: i, raw_data: JSON.stringify({ track: { imageUrl: `https://art/${i}` } }) })
    );
    expect(getSessionAlbumArts(events, 2)).toHaveLength(2);
  });

  it("returns empty array when no events have art", () => {
    const events = [
      makeEvent({ id: 1, raw_data: JSON.stringify({}) }),
      makeEvent({ id: 2, raw_data: JSON.stringify({}) }),
    ];
    expect(getSessionAlbumArts(events)).toEqual([]);
  });

  it("uses imageMap fallback for events without embedded art", () => {
    const events = [
      makeEvent({ id: 1, raw_data: JSON.stringify({ spotify_track_uri: "spotify:track:1" }) }),
      makeEvent({ id: 2, raw_data: JSON.stringify({ spotify_track_uri: "spotify:track:2" }) }),
    ];
    const imageMap = new Map([
      ["spotify:track:1", "https://art/cached1"],
      ["spotify:track:2", "https://art/cached2"],
    ]);
    expect(getSessionAlbumArts(events, 4, imageMap)).toEqual(["https://art/cached1", "https://art/cached2"]);
  });
});

describe("isSpotifyEvent", () => {
  it("returns true for spotify source", () => {
    expect(isSpotifyEvent(makeEvent({ source: "spotify" }))).toBe(true);
  });

  it("returns true for spotify-friends source", () => {
    expect(isSpotifyEvent(makeEvent({ source: "spotify-friends" }))).toBe(true);
  });

  it("returns false for other sources", () => {
    expect(isSpotifyEvent(makeEvent({ source: "discord" }))).toBe(false);
    expect(isSpotifyEvent(makeEvent({ source: "youtube" }))).toBe(false);
  });
});
