import { Database } from "bun:sqlite";
import { invalidateStatsCache } from "./stats";

/**
 * Call this at the end of parser imports to invalidate caches.
 * Stats will be lazily recomputed on the next request.
 */
export function onImportComplete(db: Database): void {
  invalidateStatsCache(db);
}
