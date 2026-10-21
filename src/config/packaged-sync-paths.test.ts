import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  normalizeStoredPackagedSyncPaths,
  validateStoredPackagedSyncPaths,
} from "./packaged-sync-paths";
import type { SyncSource } from "../sync/types";

const PATH_SOURCE: Pick<SyncSource, "name" | "configSchema"> = {
  name: "backup",
  configSchema: [
    {
      key: "destination",
      type: "string",
      format: "path",
      label: "Backup directory",
    },
  ],
};

function createAppState(timelinePath: string, settings: Record<string, unknown>): Database {
  const db = new Database(join(dirname(timelinePath), "app-state.db"));
  db.exec("CREATE TABLE sync_sources (source TEXT PRIMARY KEY, settings TEXT NOT NULL)");
  db.prepare("INSERT INTO sync_sources (source, settings) VALUES (?, ?)").run(
    "backup",
    JSON.stringify(settings),
  );
  return db;
}

test("stored packaged sync paths reject relative values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-packaged-sync-test-"));
  const timelinePath = join(dir, "timeline.db");
  const db = createAppState(timelinePath, { destination: "./backups" });
  db.close();
  try {
    await expect(validateStoredPackagedSyncPaths(timelinePath, [PATH_SOURCE], {})).rejects.toThrow(
      "sync.backup.destination must be an absolute path",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packaged sync preflight validates TOML settings when app state is empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-packaged-sync-test-"));
  const timelinePath = join(dir, "timeline.db");
  try {
    await expect(
      validateStoredPackagedSyncPaths(timelinePath, [PATH_SOURCE], {
        backup: { destination: "./backups" },
      }),
    ).rejects.toThrow("sync.backup.destination must be an absolute path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stored packaged sync paths normalize registered sources and ignore retired rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "timeline-packaged-sync-test-"));
  const timelinePath = join(dir, "timeline.db");
  const db = createAppState(timelinePath, { destination: "~/backups", keep_count: 4 });
  db.prepare("INSERT INTO sync_sources (source, settings) VALUES ('fitbit', 'invalid')").run();
  try {
    await expect(validateStoredPackagedSyncPaths(timelinePath, [PATH_SOURCE], {})).resolves.toBeUndefined();
    expect(normalizeStoredPackagedSyncPaths(db, [PATH_SOURCE])).toBe(1);
    const row = db
      .query<{ settings: string }, []>("SELECT settings FROM sync_sources WHERE source = 'backup'")
      .get();
    expect(JSON.parse(row?.settings ?? "null")).toEqual({
      destination: join(homedir(), "backups"),
      keep_count: 4,
    });
    expect(normalizeStoredPackagedSyncPaths(db, [PATH_SOURCE])).toBe(0);
    expect(db.prepare("SELECT settings FROM sync_sources WHERE source = 'fitbit'").get()).toEqual({ settings: "invalid" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
