import { describe, expect, test } from "bun:test";
import { createReleaseRoutes } from "./releases";

const repository = "example/timeline";
const releaseRoot = `https://github.com/${repository}/releases`;
const release = {
  tag_name: "v0.10.0",
  html_url: `${releaseRoot}/tag/v0.10.0`,
  published_at: "2026-01-15T12:00:00Z",
  body: "## Changes\n\n- Faster searches.",
  draft: false,
  prerelease: false,
  assets: [{
    name: "Timeline-0.10.0-macos-arm64.dmg",
    state: "uploaded",
    browser_download_url: `${releaseRoot}/download/v0.10.0/Timeline-0.10.0-macos-arm64.dmg`,
  }],
};
const running = {
  version: "0.9.0", build: "11", commit: "1111111",
  commitFull: "1".repeat(40), message: "Synthetic build", branch: "main",
};

describe("release status API", () => {
  test("reports a newer downloadable release and caches concurrent checks", async () => {
    let calls = 0;
    let clock = 0;
    const app = createReleaseRoutes({
      repository, runningVersion: running, now: () => clock,
      fetch: async () => { calls++; return Response.json(release); },
    });
    const results = await Promise.all([app.request("/api/releases/latest"), app.request("/api/releases/latest")]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    const data = await results[0]?.json();
    expect(data.comparison).toBe("update-available");
    expect(data.latest.downloadUrl).toBe(release.assets[0]?.browser_download_url);
    expect(data.latest.notes).toBe(release.body);
    expect(calls).toBe(1);
    clock = 60_001;
    await app.request("/api/releases/latest");
    expect(calls).toBe(2);
  });

  for (const [version, comparison] of [["0.10.0", "current"], ["0.11.0", "ahead"]]) {
    test(`compares packaged version ${version} correctly`, async () => {
      const app = createReleaseRoutes({
        repository, runningVersion: { ...running, version },
        fetch: async () => Response.json(release),
      });
      expect((await (await app.request("/api/releases/latest")).json()).comparison).toBe(comparison);
    });
  }

  test("does not claim checkout builds are current and tolerates pending packaging", async () => {
    const app = createReleaseRoutes({
      repository, runningVersion: { ...running, build: undefined },
      fetch: async () => Response.json({ ...release, assets: [] }),
    });
    const data = await (await app.request("/api/releases/latest")).json();
    expect(data.comparison).toBe("unknown");
    expect(data.latest.downloadUrl).toBeNull();
  });

  test("checks the public release without credentials", async () => {
    const app = createReleaseRoutes({
      repository, runningVersion: running,
      fetch: async (url, init) => {
        expect(url).toBe(`https://api.github.com/repos/${repository}/releases/latest`);
        expect(new Headers(init.headers).has("Authorization")).toBe(false);
        return Response.json(release);
      },
    });
    expect((await app.request("/api/releases/latest")).status).toBe(200);
  });

  for (const status of [401, 403, 404, 500]) {
    test(`reports upstream HTTP ${status} as a failed check`, async () => {
      const app = createReleaseRoutes({ repository, runningVersion: running, fetch: async () => new Response(null, { status }) });
      const response = await app.request("/api/releases/latest");
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain("GitHub");
    });
  }

  for (const invalid of [
    { ...release, prerelease: true },
    { ...release, tag_name: "v0.11.0-beta.1" },
    { ...release, html_url: "https://example.com/release" },
    { ...release, assets: [{ ...release.assets[0], browser_download_url: "https://example.com/download" }] },
  ]) {
    test("rejects invalid release metadata and download locations", async () => {
      const app = createReleaseRoutes({ repository, runningVersion: running, fetch: async () => Response.json(invalid) });
      expect((await app.request("/api/releases/latest")).status).toBe(503);
    });
  }
});
