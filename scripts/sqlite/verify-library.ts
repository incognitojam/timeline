import { Database } from "bun:sqlite";
import { assertSqlitePin } from "../../src/db/sqlite-runtime";
const path = process.argv[2];
if (!path || process.platform !== "darwin" || !Database.setCustomSQLite(path)) throw new Error("Cannot select the built macOS SQLite library");
using db = new Database(":memory:");
assertSqlitePin(db);
