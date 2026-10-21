import { Database } from "bun:sqlite";
import type { QueryExecutor } from "./pool";
import { normalizeIdentityInput } from "./contacts";
import { upsertIdentity, skipIdentity, unskipIdentity } from "./identities";

/**
 * Skip an identity by alias - hide it from suggestions permanently
 */
export function skipIdentityByAlias(db: Database, alias: string, source: string): void {
  const normalized = normalizeIdentityInput(alias, source);
  if (!normalized) {
    throw new Error("Invalid identity: must include a platform identifier or valid source");
  }

  upsertIdentity(db, {
    platform: normalized.platform,
    platformId: normalized.platformId,
    displayName: normalized.displayName,
  });
  skipIdentity(db, normalized.platform, normalized.platformId);
}

/**
 * Unskip an identity by alias - show it in suggestions again
 */
export function unskipIdentityByAlias(db: Database, alias: string, source: string): void {
  const normalized = normalizeIdentityInput(alias, source);
  if (!normalized) {
    throw new Error("Invalid identity: must include a platform identifier or valid source");
  }
  unskipIdentity(db, normalized.platform, normalized.platformId);
}

/**
 * Get count of skipped identities
 */
export async function countSkippedIdentities(db: QueryExecutor): Promise<number> {
  const row = await db.get<{ count: number }>(`
    SELECT COUNT(*) as count FROM identities WHERE skipped = 1
  `);
  return row?.count ?? 0;
}
