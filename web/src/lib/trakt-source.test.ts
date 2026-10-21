import { describe, expect, it } from "vitest";
import { describeTraktSource } from "./trakt-source";

describe("describeTraktSource", () => {
  it("names known applications", () => {
    expect(
      describeTraktSource(JSON.stringify({ action: "scrobble", application: { id: 59843 } })),
    ).toBe("scrobbled via Jellyfin");
    expect(
      describeTraktSource(JSON.stringify({ action: "scrobble", application: { id: 6231 } })),
    ).toBe("scrobbled via Stremio");
    expect(
      describeTraktSource(JSON.stringify({ action: "watch", application: { id: 174635 } })),
    ).toBe("marked watched via timeline-mcp");
  });

  it("falls back to numeric hint for unknown apps", () => {
    expect(
      describeTraktSource(JSON.stringify({ action: "scrobble", application: { id: 999999 } })),
    ).toBe("scrobbled via app #999999");
  });

  it("omits the app suffix when application is missing or id is 0", () => {
    expect(describeTraktSource(JSON.stringify({ action: "watch" }))).toBe("marked watched");
    expect(
      describeTraktSource(JSON.stringify({ action: "watch", application: { id: 0 } })),
    ).toBe("marked watched");
    expect(describeTraktSource(JSON.stringify({ action: "checkin" }))).toBe("checked in");
  });

  it("returns null for invalid input", () => {
    expect(describeTraktSource(null)).toBeNull();
    expect(describeTraktSource("")).toBeNull();
    expect(describeTraktSource("not json")).toBeNull();
    expect(describeTraktSource(JSON.stringify({ action: "bogus" }))).toBeNull();
    expect(describeTraktSource(JSON.stringify({}))).toBeNull();
  });
});
