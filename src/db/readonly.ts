import { Database } from "bun:sqlite";
import { assertNoLocalDbMarker, getDbPathInfo, getTimelineDbPath } from "./paths";

export function openReadonlyDbAtPath(dbPath: string): Database {
  const info = getDbPathInfo(dbPath);
  assertNoLocalDbMarker(info, info.resolvedDbPath, "database");
  return new Database(dbPath, { readonly: true });
}

export function openReadonlyTimelineDb(): Database {
  return openReadonlyDbAtPath(getTimelineDbPath());
}
