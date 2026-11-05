import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { SEED_SOURCES } from "../seed/sources";
import { SOURCE_REGISTRY } from "../shared/sources";
import { SYNC_SOURCES } from "../sync/sources";
import { VALID_PLATFORMS } from "../db/schema";
import { PLATFORMS } from ".";
import { PLATFORM_METAS } from "./metas";
import { collectRenderers, collectSeedSources, collectSyncSources, type PlatformModule } from "./registry";
import type { PlatformMeta } from "./types";

const REPO_ROOT = resolve(import.meta.dir, "../..");

function platformDirs(root: string): string[] {
  return readdirSync(join(REPO_ROOT, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Registry values as they stood before platforms contributed to them. Reorders must be deliberate. */
const EXPECTED_SYNC_ORDER = [
  "discord",
  "google-messages",
  "monzo",
  "trakt",
  "swarm",
  "wakatime",
  "github",
  "claude-code",
  "amp",
  "thriva",
  "google-health",
  "opencode",
  "spotify",
  "spotify-friends",
  "spotify-playlists",
  "conductor",
  "t3code",
  "codex",
  "steam",
  "google-places",
  "inbox-rclone",
  "recall",
  "thumbhash",
  "attachment-descriptions",
  "render-sweep",
  "embeddings",
  "media-evict",
  "backup-app-state",
  "backup",
  "backup-offsite",
];

const EXPECTED_SEED_ORDER = [
  "discord",
  "google-messages",
  "facebook",
  "instagram",
  "google-chat",
  "skype",
  "sms-backup-restore",
  "linkedin",
  "reddit",
  "claude",
  "chatgpt",
  "claude-code",
  "amp",
  "opencode",
  "conductor",
  "t3code",
  "codex",
  "wakatime",
  "github",
  "google-search",
  "google-youtube",
  "google-chrome",
  "google-fit",
  "google-location",
  "google-timeline",
  "google-calendar",
  "google-keep",
  "google-playstore",
  "minecraft",
  "spotify",
  "spotify-friends",
  "trakt",
  "swarm",
  "monzo",
  "amex",
  "fitbit",
  "google-health",
  "thriva",
];

const EXPECTED_IDENTITY_PLATFORMS = [
  "amp",
  "chatgpt",
  "claude",
  "claude-code",
  "codex",
  "conductor",
  "discord",
  "facebook",
  "github",
  "google-calendar",
  "google-chat",
  "instagram",
  "linkedin",
  "live",
  "monzo",
  "opencode",
  "phone",
  "reddit",
  "skype",
  "spotify",
  "steam",
  "t3code",
  "youtube",
];

const EXPECTED_SOURCES = [
  ["amex", "American Express", "#006FCF"],
  ["amp", "Amp", "#f87171"],
  ["attachment-descriptions", "Attachment Descriptions", "#c084fc"],
  ["auto-detect", "Auto-detect", "#9ca3af"],
  ["backup", "Backup", "#64748b"],
  ["backup-app-state", "App State Backup", "#64748b"],
  ["backup-offsite", "Offsite Backup", "#64748b"],
  ["chatgpt", "ChatGPT", "#10A37F"],
  ["chrome", "Chrome", "#D99200"],
  ["claude", "Claude", "#D97757"],
  ["claude-code", "Claude Code", "#D97757"],
  ["codex", "Codex", "#74c69d"],
  ["conductor", "Conductor", "#a4847f"],
  ["discord", "Discord", "#5865F2"],
  ["embeddings", "Embeddings", "#2dd4bf"],
  ["facebook", "Facebook", "#1877F2"],
  ["fitbit", "Fitbit", "#00B0B9"],
  ["github", "GitHub", "#8b949e"],
  ["google", "Google", "#EA4335"],
  ["google-calendar", "Google Calendar", "#4285F4"],
  ["google-chat", "Google Chat", "#00AC47"],
  ["google-fit", "Google Fit", "#4285F4"],
  ["google-health", "Google Health", "#00B0B9"],
  ["google-keep", "Google Keep", "#E37400"],
  ["google-location", "Google Location", "#EA4335"],
  ["google-location-sharing", "Google Location Sharing", "#EA4335"],
  ["google-messages", "Google Messages", "#1A73E8"],
  ["google-places", "Google Places", "#34A853"],
  ["google-playstore", "Google Play Store", "#01875f"],
  ["google-search", "Google Search", "#4285F4"],
  ["google-takeout", "Google Takeout", "#EA4335"],
  ["google-timeline", "Google Timeline", "#EA4335"],
  ["inbox-rclone", "Inbox Sync", "#3b82f6"],
  ["instagram", "Instagram", "#E4405F"],
  ["journal", "Journal", "#8b5cf6"],
  ["linkedin", "LinkedIn", "#0A66C2"],
  ["live", "Microsoft Live", "#00AFF0"],
  ["manual", "Manual", "#6366f1"],
  ["media-evict", "Media Eviction", "#78716c"],
  ["minecraft", "Minecraft", "#62B047"],
  ["monzo", "Monzo", "#FF5F5F"],
  ["opencode", "OpenCode", "#9ca3af"],
  ["phone", "Phone", "#2dd4bf"],
  ["recall", "Recall", "#7c8aa3"],
  ["reddit", "Reddit", "#FF4500"],
  ["render-sweep", "Render Sweep", "#94a3b8"],
  ["skype", "Skype", "#00AFF0"],
  ["sms-backup-restore", "SMS Backup & Restore", "#2dd4bf"],
  ["spotify", "Spotify", "#1DB954"],
  ["spotify-friends", "Spotify Friends", "#1DB954"],
  ["spotify-playlists", "Spotify Playlists", "#1DB954"],
  ["steam", "Steam", "#66c0f4"],
  ["steam-friends", "Steam Friends", "#66c0f4"],
  ["swarm", "Swarm", "#FFA633"],
  ["t3code", "T3 Code", "#8e51ff"],
  ["thriva", "Thriva", "#9856c8"],
  ["thumbhash", "ThumbHash", "#a78bfa"],
  ["trakt", "Trakt", "#ED1C24"],
  ["wakatime", "WakaTime", "#2595ff"],
  ["youtube", "YouTube", "#FF0000"],
];

describe("derived registries", () => {
  test("keep the sync order", () => {
    expect(SYNC_SOURCES.map((source) => source.name)).toEqual(EXPECTED_SYNC_ORDER);
  });

  test("keep the seed order", () => {
    expect(SEED_SOURCES.map((source) => source.name)).toEqual(EXPECTED_SEED_ORDER);
  });

  test("keep the identity platforms", () => {
    expect<string[]>([...VALID_PLATFORMS].sort()).toEqual(EXPECTED_IDENTITY_PLATFORMS);
  });

  test("keep every source's id, label and colour", () => {
    const actual = SOURCE_REGISTRY.map((source) => [source.id, source.label, source.color]);
    expect(actual.sort(([a], [b]) => String(a).localeCompare(String(b)))).toEqual(EXPECTED_SOURCES);
  });
});

describe("platform lists", () => {
  test("server modules follow PLATFORM_METAS, which may list platforms whose code hasn't moved yet", () => {
    const moved = new Set(PLATFORMS.map((platform) => platform.meta));
    const metas: readonly PlatformMeta[] = PLATFORM_METAS;
    expect(metas.filter((meta) => moved.has(meta))).toEqual(PLATFORMS.map((platform) => platform.meta));
    expect(moved.size).toBe(PLATFORMS.length);
  });

  test("every platform directory has a web directory, and the reverse", () => {
    expect(platformDirs("web/src/platforms")).toEqual(platformDirs("src/platforms"));
  });

  test("the lists cover every platform directory", () => {
    expect<string[]>(PLATFORM_METAS.map((meta) => meta.id).sort()).toEqual(platformDirs("src/platforms"));
  });

  test("platforms contribute only for sources they own", async () => {
    for (const platform of PLATFORMS) {
      const owned = new Set(platform.meta.sources.map((source) => source.id));
      const seeds = (await platform.loadSeeds?.()) ?? [];
      const contributed = [
        ...(platform.syncSources ?? []).map((source) => source.name),
        ...Object.keys(platform.renderers ?? {}),
        ...seeds.flatMap((seed) => Object.keys(seed.produces)),
      ];
      expect(contributed.filter((source) => !owned.has(source))).toEqual([]);
    }
  });
});

describe("collect functions", () => {
  const meta = { id: "alpha", color: "#000000", sources: [{ id: "alpha", label: "Alpha" }] };
  const sync = (name: string) => ({
    name,
    description: name,
    enabled: true,
    canSync: async () => null,
    sync: async () => ({ source: name, success: true, eventsAdded: 0, eventsUpdated: 0, durationMs: 0 }),
  });
  const seed = (name: string) => ({ name, produces: {}, seed: async () => {} });
  const render = () => ({ title: null, content: null });

  test("run platform contributions first, then the others", async () => {
    const platforms: PlatformModule[] = [
      { meta, syncSources: [sync("alpha")], loadSeeds: async () => [seed("alpha")] },
    ];
    expect(collectSyncSources(platforms, [sync("job")]).map((source) => source.name)).toEqual(["alpha", "job"]);
    expect((await collectSeedSources(platforms, [seed("other")])).map((source) => source.name)).toEqual(["alpha", "other"]);
  });

  test("accept a list extended at startup", () => {
    const later: PlatformModule = { meta, renderers: { alpha: { version: 1, render } } };
    expect([...collectRenderers([...PLATFORMS, later]).keys()]).toEqual(["discord", "alpha"]);
  });

  test("do not load seeds until asked", async () => {
    let loaded = 0;
    const platforms: PlatformModule[] = [{ meta, loadSeeds: async () => { loaded += 1; return []; } }];
    collectSyncSources(platforms, []);
    collectRenderers(platforms);
    expect(loaded).toBe(0);
    await collectSeedSources(platforms, []);
    expect(loaded).toBe(1);
  });

  test("reject duplicates", async () => {
    const twice: PlatformModule[] = [
      { meta, syncSources: [sync("alpha")], renderers: { alpha: { version: 1, render } }, loadSeeds: async () => [seed("alpha")] },
    ];
    expect(() => collectSyncSources(twice, [sync("alpha")])).toThrow("Duplicate sync source: alpha");
    expect(() => collectRenderers([...twice, ...twice])).toThrow("Duplicate renderer: alpha");
    await expect(collectSeedSources(twice, [seed("alpha")])).rejects.toThrow("Duplicate seed generator: alpha");
  });
});
