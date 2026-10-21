/**
 * Spotify API Tests
 *
 * Tests for Spotify track image cache endpoint.
 * Run with: bun test src/api/spotify.test.ts
 */

// Set test mode before importing to prevent server auto-start
process.env.NODE_ENV = "test";

import { describe, test, expect, beforeAll } from "bun:test";
import { app } from "./index";
import { getAppStateDb, setSpotifyResource } from "../db/app-state";

describe("Spotify API Tests", () => {
  describe("Spotify Track Images", () => {
    beforeAll(() => {
      const appDb = getAppStateDb();
      setSpotifyResource(appDb, "spotify:track:img1", "track", "Track With Art", "https://i.scdn.co/image/art1");
      setSpotifyResource(appDb, "spotify:track:img2", "track", "Another Track", "https://i.scdn.co/image/art2");
      setSpotifyResource(appDb, "spotify:track:noart", "track", "No Art Track");
    });

    test("GET /api/spotify/track-images returns cached images for known URIs", async () => {
      const res = await app.request("/api/spotify/track-images?uris=spotify:track:img1,spotify:track:img2");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json["spotify:track:img1"]).toBe("https://i.scdn.co/image/art1");
      expect(json["spotify:track:img2"]).toBe("https://i.scdn.co/image/art2");
    });

    test("GET /api/spotify/track-images excludes tracks without images", async () => {
      const res = await app.request("/api/spotify/track-images?uris=spotify:track:img1,spotify:track:noart");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json["spotify:track:img1"]).toBe("https://i.scdn.co/image/art1");
      expect(json["spotify:track:noart"]).toBeUndefined();
    });

    test("GET /api/spotify/track-images returns empty object without uris param", async () => {
      const res = await app.request("/api/spotify/track-images");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({});
    });

    test("GET /api/spotify/track-images returns empty object for empty uris", async () => {
      const res = await app.request("/api/spotify/track-images?uris=");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({});
    });

    test("GET /api/spotify/track-images caps at 200 URIs", async () => {
      // Generate 201 URIs
      const uris = Array.from({ length: 201 }, (_, i) => `spotify:track:test${i}`).join(",");
      const res = await app.request(`/api/spotify/track-images?uris=${uris}`);
      expect(res.status).toBe(200);
      // Should not error - just processes up to 200
      const json = await res.json();
      expect(typeof json).toBe("object");
    });
  });
});
