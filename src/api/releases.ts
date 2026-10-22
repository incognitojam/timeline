import { Hono } from "hono";
import { z } from "zod";
import type { ReleaseStatus } from "../shared/releases";
import type { VersionInfo } from "../shared/version";

class ReleaseCheckError extends Error {}

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const releaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.url(),
  published_at: z.iso.datetime(),
  body: z.string().nullable(),
  draft: z.literal(false),
  prerelease: z.literal(false),
  assets: z.array(z.object({
    name: z.string(),
    state: z.string(),
    browser_download_url: z.url(),
  })),
});

function compareRunningRelease(running: VersionInfo | null, latest: string): ReleaseStatus["comparison"] {
  if (!running?.build || !running.version || !stableVersion.test(running.version)) return "unknown";
  const order = Bun.semver.order(running.version, latest);
  return order < 0 ? "update-available" : order === 0 ? "current" : "ahead";
}

export function createReleaseRoutes(options: {
  repository: string;
  runningVersion: VersionInfo | null;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
    throw new Error("Release repository must be owner/name");
  }
  const now = options.now ?? Date.now;
  const request = options.fetch ?? fetch;
  const releaseRoot = `https://github.com/${options.repository}/releases`;
  let pending: Promise<ReleaseStatus> | undefined;
  let expiresAt = 0;

  async function check(): Promise<ReleaseStatus> {
    const response = await request(`https://api.github.com/repos/${options.repository}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) {
      if (response.status === 404) {
        throw new ReleaseCheckError("GitHub release unavailable. Check the release repository.");
      }
      if (response.status === 401 || response.status === 403) {
        throw new ReleaseCheckError("GitHub denied the release check. Try again later.");
      }
      throw new ReleaseCheckError(`GitHub release check failed (HTTP ${response.status}).`);
    }
    const release = releaseSchema.parse(await response.json());
    const version = release.tag_name.replace(/^v/, "");
    if (!stableVersion.test(version) || release.html_url !== `${releaseRoot}/tag/${release.tag_name}`) {
      throw new ReleaseCheckError("GitHub returned invalid release metadata.");
    }
    const asset = release.assets.find((candidate) =>
      candidate.name === `Timeline-${version}-macos-arm64.dmg` && candidate.state === "uploaded",
    );
    const downloadUrl = asset?.browser_download_url ?? null;
    if (downloadUrl !== null && downloadUrl !== `${releaseRoot}/download/${release.tag_name}/${asset?.name}`) {
      throw new ReleaseCheckError("GitHub returned an invalid download URL.");
    }
    return {
      latest: {
        version,
        url: release.html_url,
        publishedAt: release.published_at,
        notes: release.body ?? "",
        downloadUrl,
      },
      comparison: compareRunningRelease(options.runningVersion, version),
      checkedAt: new Date(now()).toISOString(),
    };
  }

  return new Hono().get("/api/releases/latest", async (c) => {
    if (!pending || now() >= expiresAt) {
      pending = check();
      // Cache successes and failures, and share in-flight requests across browsers.
      expiresAt = now() + 60_000;
    }
    try {
      return c.json(await pending);
    } catch (error) {
      const message = error instanceof ReleaseCheckError
        ? error.message
        : error instanceof z.ZodError
          ? "GitHub returned invalid release metadata."
          : "Could not reach GitHub to check releases. Try again later.";
      return c.json({ error: message }, 503);
    }
  });
}
