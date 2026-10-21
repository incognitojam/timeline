import { describe, expect, test } from "bun:test";
import { readUpdateConfig, releaseURLFromRemote } from "../tools/timeline-app/update-config";

const key = Buffer.alloc(32, 1).toString("base64");
const feed = "https://example.com/appcast.xml";

describe("native update configuration", () => {
  test("derives download links from the source repository", () => {
    expect(releaseURLFromRemote("https://github.com/example/timeline.git")).toBe("https://github.com/example/timeline/releases");
    const sshRemote = ["git", "github.com:example/timeline.git"].join("@");
    expect(releaseURLFromRemote(sshRemote)).toBe("https://github.com/example/timeline/releases");
    expect(() => releaseURLFromRemote("https://example.com/timeline.git")).toThrow();
  });
  test("keeps manual downloads when native updates are not enabled", () => {
    expect(readUpdateConfig({})).toBeNull();
  });
  test("accepts a complete HTTPS feed and public key", () => {
    expect(readUpdateConfig({ TIMELINE_UPDATE_FEED_URL: feed, TIMELINE_UPDATE_PUBLIC_KEY: key })).toEqual({ feed, key });
  });
  for (const env of [
    { TIMELINE_UPDATE_FEED_URL: feed },
    { TIMELINE_UPDATE_PUBLIC_KEY: key },
    { TIMELINE_UPDATE_FEED_URL: "http://example.com/appcast.xml", TIMELINE_UPDATE_PUBLIC_KEY: key },
    { TIMELINE_UPDATE_FEED_URL: "https://alice:password@example.com/feed", TIMELINE_UPDATE_PUBLIC_KEY: key },
    { TIMELINE_UPDATE_FEED_URL: feed, TIMELINE_UPDATE_PUBLIC_KEY: "invalid" },
  ]) {
    test("rejects incomplete or invalid update configuration", () => {
      expect(() => readUpdateConfig(env)).toThrow();
    });
  }
});
