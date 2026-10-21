import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServiceConfig } from "../config";
import { getBlockedNetworks, initAppStateDb } from "../db/app-state";
import {
  importTomlSyncSourcesIfEmpty,
  loadSyncConfig,
  loadSyncSourcesConfig,
  upsertSyncSourcePatch,
} from "./config";

let db: Database;

function testServiceConfig(sync: ServiceConfig["sync"]): Pick<ServiceConfig, "sync"> {
  return { sync };
}

describe("sync source config", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    initAppStateDb(db);
  });

  afterEach(() => {
    db.close();
  });

  test("imports [sync.*] TOML sections once into sync_sources", () => {
    const logs: string[] = [];
    const result = importTomlSyncSourcesIfEmpty(
      db,
      testServiceConfig({
        discord: {
          enabled: false,
          interval: "30m",
          account: "alice",
          guilds: {
            "111111111111111111": {
              name: "Example Guild",
              mode: "full",
              channels: ["222222222222222222"],
            },
          },
        },
        "spotify-playlists": {
          interval: "12h",
          playlists: ["0123456789ABCDEFGHIJKL"],
        },
      }),
      {
        log: (message) => logs.push(message),
        warn: (message) => logs.push(message),
      }
    );

    expect(result).toEqual({ imported: 2, ignoredTomlSections: false });
    expect(logs[0]).toContain("Imported 2");

    const rows = db.prepare("SELECT source, enabled, interval, settings FROM sync_sources ORDER BY source").all() as Array<{
      source: string;
      enabled: number;
      interval: string | null;
      settings: string;
    }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: "discord",
      enabled: 0,
      interval: "30m",
    });
    expect(JSON.parse(rows[0].settings)).toEqual({
      account: "alice",
      guilds: {
        "111111111111111111": {
          name: "Example Guild",
          mode: "full",
          channels: ["222222222222222222"],
        },
      },
    });
    expect(rows[1]).toMatchObject({
      source: "spotify-playlists",
      enabled: 1,
      interval: "12h",
    });
    expect(JSON.parse(rows[1].settings)).toEqual({
      playlists: ["0123456789ABCDEFGHIJKL"],
    });
  });

  test("moves imported TOML blocked_ssids into the shared blocked-network list", () => {
    importTomlSyncSourcesIfEmpty(
      db,
      testServiceConfig({ "backup-offsite": { blocked_ssids: ["iPhone"], require_unmetered: true } }),
      { log: () => {}, warn: () => {} }
    );

    expect(getBlockedNetworks(db)).toEqual(["iPhone"]);
    expect(loadSyncSourcesConfig(db)["backup-offsite"]).toEqual({
      enabled: true,
      require_unmetered: true,
      skip_blocked_networks: true,
    });
  });

  test("warns when TOML sync sections remain after sync_sources is populated", () => {
    db.prepare("INSERT INTO sync_sources (source, enabled, settings) VALUES ('discord', 1, '{}')").run();

    const warnings: string[] = [];
    const result = importTomlSyncSourcesIfEmpty(
      db,
      testServiceConfig({
        discord: {
          interval: "30m",
        },
      }),
      {
        log: () => {},
        warn: (message) => warnings.push(message),
      }
    );

    expect(result).toEqual({ imported: 0, ignoredTomlSections: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("config.toml still contains [sync.*] sections");
    expect(warnings[0]).toContain("ignored");
  });

  test("does not import retired TOML sync sections", () => {
    const warnings: string[] = [];
    const result = importTomlSyncSourcesIfEmpty(
      db,
      testServiceConfig({ fitbit: { enabled: true }, trakt: { enabled: true } }),
      { log: () => {}, warn: (message) => warnings.push(message) },
      new Set(["trakt"]),
    );

    expect(result).toEqual({ imported: 1, ignoredTomlSections: false });
    expect(warnings).toEqual(['Ignoring [sync.fitbit] because the sync source is no longer registered']);
    expect(loadSyncSourcesConfig(db)).toEqual({ trakt: { enabled: true } });
  });

  test("ignores stale settings only for unregistered sources", () => {
    db.prepare("INSERT INTO sync_sources (source, settings) VALUES ('fitbit', 'invalid')").run();
    db.prepare("INSERT INTO sync_sources (source, settings) VALUES ('trakt', 'invalid')").run();

    expect(loadSyncSourcesConfig(db, new Set(["backup"]))).toEqual({});
    expect(() => loadSyncSourcesConfig(db, new Set(["trakt"]))).toThrow(
      'Invalid sync_sources.settings for "trakt"',
    );
  });

  test("loadSyncConfig maps rows to per-source config objects", async () => {
    db.prepare(
      `INSERT INTO sync_sources (source, enabled, interval, settings)
       VALUES ('trakt', 0, '4h', '{"account":"alice","keep_count":7}')`
    ).run();

    expect(loadSyncSourcesConfig(db).trakt).toEqual({
      enabled: false,
      interval: "4h",
      account: "alice",
      keep_count: 7,
    });
    await expect(loadSyncConfig(db)).resolves.toEqual({
      sources: {
        trakt: {
          enabled: false,
          interval: "4h",
          account: "alice",
          keep_count: 7,
        },
      },
    });
  });

  test("merges settings patches and deletes null values", () => {
    db.prepare(
      `INSERT INTO sync_sources (source, enabled, interval, settings)
       VALUES ('backup', 0, '4h', '{"destination":"/tmp/old","legacy_option":true,"keep_count":2}')`
    ).run();

    const row = upsertSyncSourcePatch(
      "backup",
      { settings: { destination: "/tmp/new", keep_count: null } },
      db,
    );

    expect(row).toMatchObject({ source: "backup", enabled: 0, interval: "4h" });
    expect(JSON.parse(row.settings)).toEqual({
      destination: "/tmp/new",
      legacy_option: true,
    });
  });

  test("creates a disabled row for a settings-only patch", () => {
    const row = upsertSyncSourcePatch("amp", { settings: { mode: "api" } }, db);

    expect(row).toMatchObject({ source: "amp", enabled: 0, interval: null });
    expect(JSON.parse(row.settings)).toEqual({ mode: "api" });
  });
});
