import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { SyncSource } from "../sync/types";
import type { SyncSourceConfig } from "./types";
import { preparePackagedSyncSourcePaths } from "./packaged-paths";

interface StoredSyncSourceRow {
  source: string;
  settings: string;
}

interface PreparedStoredRow {
  source: string;
  settings: string;
  changed: boolean;
}

function readStoredRows(db: Database): StoredSyncSourceRow[] {
  const table = db
    .query<{ present: number }, []>(
      "SELECT COUNT(*) AS present FROM sqlite_schema WHERE type = 'table' AND name = 'sync_sources'",
    )
    .get();
  if (!table?.present) return [];

  const columns = db.query<{ name: string }, []>("PRAGMA table_info(sync_sources)").all();
  if (!columns.some((column) => column.name === "settings")) return [];
  return db
    .query<StoredSyncSourceRow, []>("SELECT source, settings FROM sync_sources ORDER BY source")
    .all();
}

function prepareStoredRows(
  rows: StoredSyncSourceRow[],
  registeredSources: Pick<SyncSource, "name" | "configSchema">[],
): PreparedStoredRow[] {
  const registeredNames = new Set(registeredSources.map((source) => source.name));
  return rows.filter((row) => registeredNames.has(row.source)).map((row) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.settings);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid sync_sources.settings for "${row.source}": ${reason}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid sync_sources.settings for "${row.source}": expected an object`);
    }

    const settings = parsed as SyncSourceConfig;
    const before = JSON.stringify(settings);
    preparePackagedSyncSourcePaths({ [row.source]: settings }, registeredSources);
    const after = JSON.stringify(settings);
    return { source: row.source, settings: after, changed: before !== after };
  });
}

export async function validateStoredPackagedSyncPaths(
  timelineDbPath: string,
  registeredSources: Pick<SyncSource, "name" | "configSchema">[],
  fallbackSources: Record<string, SyncSourceConfig>,
): Promise<void> {
  const appStatePath = join(dirname(timelineDbPath), "app-state.db");
  if (!existsSync(appStatePath)) {
    preparePackagedSyncSourcePaths(fallbackSources, registeredSources);
    return;
  }

  const { Database } = await import("bun:sqlite");
  const db = new Database(appStatePath, { readonly: true });
  try {
    const rows = readStoredRows(db);
    if (rows.length === 0) {
      preparePackagedSyncSourcePaths(fallbackSources, registeredSources);
    } else {
      prepareStoredRows(rows, registeredSources);
    }
  } finally {
    db.close();
  }
}

export function normalizeStoredPackagedSyncPaths(
  db: Database,
  registeredSources: Pick<SyncSource, "name" | "configSchema">[],
): number {
  const prepared = prepareStoredRows(readStoredRows(db), registeredSources).filter(
    (row) => row.changed,
  );
  if (prepared.length === 0) return 0;

  db.transaction(() => {
    const update = db.prepare("UPDATE sync_sources SET settings = ? WHERE source = ?");
    for (const row of prepared) update.run(row.settings, row.source);
  })();
  return prepared.length;
}
