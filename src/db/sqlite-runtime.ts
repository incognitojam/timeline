import type { Database } from "bun:sqlite";
import { SQLITE_PIN } from "./sqlite-pin";

export function sqliteFingerprint(db: Database) {
  const row = db.query<{ version: string; sourceId: string }, []>("SELECT sqlite_version() version, sqlite_source_id() sourceId").get();
  if (!row) throw new Error("SQLite returned no version");
  return {
    ...row,
    compileOptions: db.query<{ compile_options: string }, []>("PRAGMA compile_options").all()
      .map(row => row.compile_options).filter(option => !option.startsWith("COMPILER=")).sort(),
  };
}

export function assertSqlitePin(db: Database, pin = SQLITE_PIN): void {
  const actual = sqliteFingerprint(db);
  const expected = { version: pin.version, sourceId: pin.sourceId, compileOptions: [...pin.compileOptions, ...(process.platform === "darwin" ? pin.darwinExtraCompileOptions : [])].sort() };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`SQLite pin mismatch. Expected ${JSON.stringify(expected)}; loaded ${JSON.stringify(actual)}. On Linux install the pinned Bun, or run bun run sqlite:pin bun-v${Bun.version} for an intentional Bun upgrade. On macOS run bun run sqlite:build and select the resulting library.`);
  }
}
