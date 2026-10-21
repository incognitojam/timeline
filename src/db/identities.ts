import { Database } from "bun:sqlite";
import type { QueryExecutor } from "./pool";
import type { Platform, Identity } from "./schema";
import { isValidPlatform } from "./schema";

/**
 * Parse a platform identifier string into platform and platform_id.
 * Format: "platform:id" where id may contain colons (e.g., "facebook:name:Alice Example")
 *
 * @example
 * parseIdentifier("discord:900000000000000001") // { platform: "discord", platformId: "900000000000000001" }
 * parseIdentifier("facebook:name:Alice Example") // { platform: "facebook", platformId: "name:Alice Example" }
 */
export function parseIdentifier(identifier: string): { platform: string; platformId: string } | null {
  const colonIndex = identifier.indexOf(":");
  if (colonIndex === -1) return null;
  return {
    platform: identifier.slice(0, colonIndex),
    platformId: identifier.slice(colonIndex + 1),
  };
}

/**
 * Create a platform identifier string from platform and id.
 */
export function formatIdentifier(platform: string, platformId: string): string {
  return `${platform}:${platformId}`;
}

export interface UpsertIdentityOptions {
  platform: Platform;
  platformId: string;
  displayName?: string;
  username?: string;
  avatarUrl?: string;
}

/**
 * Upsert an identity - called by parsers during import.
 * Creates or updates an identity record with the latest display name.
 * Returns the identity ID.
 */
export function upsertIdentity(db: Database, options: UpsertIdentityOptions): number {
  const { platform, platformId, displayName, username, avatarUrl } = options;

  // Try to insert, or update if exists
  const result = db.prepare(`
    INSERT INTO identities (platform, platform_id, display_name, username, avatar_url)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(platform, platform_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, identities.display_name),
      username = COALESCE(excluded.username, identities.username),
      avatar_url = COALESCE(excluded.avatar_url, identities.avatar_url),
      last_seen = datetime('now')
    RETURNING id
  `).get(platform, platformId, displayName ?? null, username ?? null, avatarUrl ?? null) as { id: number };

  return result.id;
}

/**
 * Batch upsert multiple identities - more efficient for bulk imports.
 */
export function upsertIdentities(db: Database, identities: UpsertIdentityOptions[]): void {
  const stmt = db.prepare(`
    INSERT INTO identities (platform, platform_id, display_name, username, avatar_url)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(platform, platform_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, identities.display_name),
      username = COALESCE(excluded.username, identities.username),
      avatar_url = COALESCE(excluded.avatar_url, identities.avatar_url),
      last_seen = datetime('now')
  `);

  const upsertMany = db.transaction((items: UpsertIdentityOptions[]) => {
    for (const item of items) {
      stmt.run(item.platform, item.platformId, item.displayName ?? null, item.username ?? null, item.avatarUrl ?? null);
    }
  });

  upsertMany(identities);
}

export interface ResolvedIdentity {
  name: string | null;
  username: string | null;
  contactId: number | null;
  avatarUrl: string | null;
  isSelf: boolean;
  hidden: boolean;
}

/**
 * Resolve multiple identifiers to their display names and contact IDs.
 * Returns a map from identifier to resolved info.
 *
 * @example
 * resolveIdentities(db, ["discord:123", "discord:456"])
 * // { "discord:123": { name: "Alice", contactId: 5 }, "discord:456": { name: "Bob", contactId: null } }
 */
export async function resolveIdentities(
  db: QueryExecutor,
  identifiers: string[]
): Promise<Record<string, ResolvedIdentity>> {
  if (identifiers.length === 0) return {};

  // Parse identifiers and separate contact: references from platform identities
  const parsed: Array<{ identifier: string; platform: string; platformId: string }> = [];
  const contactRefs: Array<{ identifier: string; contactId: number }> = [];
  for (const id of identifiers) {
    const p = parseIdentifier(id);
    if (p) {
      if (p.platform === "contact") {
        const cid = Number(p.platformId);
        if (Number.isSafeInteger(cid) && cid > 0) contactRefs.push({ identifier: id, contactId: cid });
      } else {
        parsed.push({ identifier: id, ...p });
      }
    }
  }

  const result: Record<string, ResolvedIdentity> = {};

  // Resolve contact: references directly from the contacts table
  if (contactRefs.length > 0) {
    const CHUNK_SIZE = 500;
    for (let i = 0; i < contactRefs.length; i += CHUNK_SIZE) {
      const slice = contactRefs.slice(i, i + CHUNK_SIZE);
      const placeholders = slice.map(() => "?").join(", ");
      const params = slice.map(r => r.contactId);

      const rows = await db.query<{
        id: number;
        display_name: string;
        avatar_url: string | null;
        is_self: number;
        hidden: number;
      }>(`
        SELECT c.id, c.display_name, c.is_self, c.hidden,
          (SELECT i.avatar_url FROM identities i WHERE i.contact_id = c.id AND i.avatar_url IS NOT NULL LIMIT 1) as avatar_url
        FROM contacts c WHERE c.id IN (${placeholders})
      `, ...params);

      const rowMap = new Map(rows.map(r => [r.id, r]));
      for (const ref of slice) {
        const row = rowMap.get(ref.contactId);
        result[ref.identifier] = row
          ? { name: row.display_name, username: null, contactId: row.id, avatarUrl: row.avatar_url, isSelf: row.is_self === 1, hidden: row.hidden === 1 }
          : { name: null, username: null, contactId: null, avatarUrl: null, isSelf: false, hidden: false };
      }
    }
  }

  // Resolve platform identities via the identities table
  if (parsed.length > 0) {
    // SQLite default max variable count is 999; each identifier uses 2 params.
    const CHUNK_SIZE = 400;
    for (let i = 0; i < parsed.length; i += CHUNK_SIZE) {
      const slice = parsed.slice(i, i + CHUNK_SIZE);
      const placeholders = slice.map(() => "(?, ?)").join(", ");
      const params: string[] = [];
      for (const p of slice) {
        params.push(p.platform, p.platformId);
      }

      const rows = await db.query<{
        platform: string;
        platform_id: string;
        display_name: string | null;
        username: string | null;
        contact_id: number | null;
        avatar_url: string | null;
        is_self: number | null;
        hidden: number | null;
      }>(`
        WITH lookups(platform, platform_id) AS (VALUES ${placeholders})
        SELECT
          l.platform,
          l.platform_id,
          COALESCE(c.display_name, i.display_name) AS display_name,
          i.username,
          i.contact_id,
          i.avatar_url,
          c.is_self,
          c.hidden
        FROM lookups l
        LEFT JOIN identities i ON i.platform = l.platform AND i.platform_id = l.platform_id
        LEFT JOIN contacts c ON c.id = i.contact_id
      `, ...params);

      for (const row of rows) {
        const identifier = formatIdentifier(row.platform, row.platform_id);
        result[identifier] = {
          name: row.display_name,
          username: row.username,
          contactId: row.contact_id,
          avatarUrl: row.avatar_url,
          isSelf: row.is_self === 1,
          hidden: row.hidden === 1,
        };
      }
    }

    // Fill in any platform identifiers that weren't in the database
    for (const p of parsed) {
      if (!result[p.identifier]) {
        result[p.identifier] = { name: null, username: null, contactId: null, avatarUrl: null, isSelf: false, hidden: false };
      }
    }
  }

  return result;
}

/**
 * Get a single identity by platform and platform_id.
 */
export async function getIdentity(
  db: QueryExecutor,
  platform: string,
  platformId: string
): Promise<Identity | null> {
  return await db.get<Identity>(`
    SELECT * FROM identities WHERE platform = ? AND platform_id = ?
  `, platform, platformId);
}

/**
 * Get identity by its formatted identifier string.
 */
export async function getIdentityByIdentifier(
  db: QueryExecutor,
  identifier: string
): Promise<Identity | null> {
  const parsed = parseIdentifier(identifier);
  if (!parsed) return null;
  return await getIdentity(db, parsed.platform, parsed.platformId);
}

/**
 * Link an identity to a contact.
 */
export function linkIdentityToContact(
  db: Database,
  platform: string,
  platformId: string,
  contactId: number
): void {
  db.prepare(`
    UPDATE identities
    SET contact_id = ?, skipped = 0
    WHERE platform = ? AND platform_id = ?
  `).run(contactId, platform, platformId);
}

/**
 * Link multiple identities to contacts in a single transaction.
 * Returns the number of identities successfully linked and any errors.
 */
export function batchLinkIdentitiesToContact(
  db: Database,
  links: Array<{ platform: string; platformId: string; contactId: number }>
): { linked: number; errors: Array<{ identifier: string; error: string }> } {
  const stmt = db.prepare(`
    UPDATE identities
    SET contact_id = ?, skipped = 0
    WHERE platform = ? AND platform_id = ?
  `);

  const errors: Array<{ identifier: string; error: string }> = [];
  let linked = 0;

  const linkAll = db.transaction(() => {
    for (const link of links) {
      try {
        const result = stmt.run(link.contactId, link.platform, link.platformId);
        if (result.changes > 0) {
          linked++;
        } else {
          errors.push({
            identifier: formatIdentifier(link.platform, link.platformId),
            error: "Identity not found",
          });
        }
      } catch (err) {
        errors.push({
          identifier: formatIdentifier(link.platform, link.platformId),
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  });

  linkAll();
  return { linked, errors };
}

/**
 * Unlink an identity from any contact.
 */
export function unlinkIdentity(db: Database, platform: string, platformId: string): void {
  db.prepare(`
    UPDATE identities
    SET contact_id = NULL
    WHERE platform = ? AND platform_id = ?
  `).run(platform, platformId);
}

/**
 * Skip an identity - hide it from suggestions.
 */
export function skipIdentity(db: Database, platform: string, platformId: string): void {
  db.prepare(`
    UPDATE identities
    SET skipped = 1, contact_id = NULL
    WHERE platform = ? AND platform_id = ?
  `).run(platform, platformId);
}

/**
 * Unskip an identity - show it in suggestions again.
 */
export function unskipIdentity(db: Database, platform: string, platformId: string): void {
  db.prepare(`
    UPDATE identities
    SET skipped = 0
    WHERE platform = ? AND platform_id = ?
  `).run(platform, platformId);
}

export interface UnlinkedIdentity {
  identifier: string;  // "platform:platformId"
  platform: string;
  platformId: string;
  displayName: string | null;
  username: string | null;
  eventCount: number;
  avatarUrl: string | null;
}

/**
 * Get unlinked identities (not linked to a contact and not skipped).
 * Uses the denormalized event_count column for fast queries.
 */
export async function getUnlinkedIdentities(
  db: QueryExecutor,
  options?: { platform?: string; limit?: number }
): Promise<UnlinkedIdentity[]> {
  const { platform, limit } = options ?? {};

  const platformFilter = platform ? "AND platform = ?" : "";
  const limitClause = limit !== undefined ? "LIMIT ?" : "";
  const params: (string | number)[] = platform ? [platform] : [];

  // Get unlinked, non-skipped identities using denormalized event_count
  // Uses idx_identities_unlinked partial index for fast sorting
  const sql = `
    SELECT
      platform,
      platform_id as platformId,
      display_name as displayName,
      username,
      event_count as eventCount,
      avatar_url as avatarUrl
    FROM identities
    WHERE contact_id IS NULL
      AND skipped = 0
      AND event_count > 0
      ${platformFilter}
    ORDER BY event_count DESC
    ${limitClause}
  `;

  if (limit !== undefined) params.push(limit);
  const rows = await db.query<{
    platform: string;
    platformId: string;
    displayName: string | null;
    username: string | null;
    eventCount: number;
    avatarUrl: string | null;
  }>(sql, ...params);

  return rows.map((r) => ({
    identifier: formatIdentifier(r.platform, r.platformId),
    platform: r.platform,
    platformId: r.platformId,
    displayName: r.displayName,
    username: r.username,
    eventCount: r.eventCount,
    avatarUrl: r.avatarUrl,
  }));
}

/**
 * Count unlinked identities (for dashboard stats).
 */
export async function countUnlinkedIdentities(db: QueryExecutor): Promise<number> {
  const result = await db.get<{ count: number }>(`
    SELECT COUNT(*) as count
    FROM identities
    WHERE contact_id IS NULL AND skipped = 0
  `);
  if (!result) throw new Error("COUNT query returned no result");
  return result.count;
}

/**
 * List skipped identities.
 * Uses the denormalized event_count column for fast queries.
 */
export async function listSkippedIdentities(
  db: QueryExecutor,
): Promise<Array<{
  identifier: string;
  platform: string;
  platformId: string;
  displayName: string | null;
  username: string | null;
  eventCount: number;
  avatarUrl: string | null;
  skippedAt: string;
}>> {
  const rows = await db.query<{
    platform: string;
    platformId: string;
    displayName: string | null;
    username: string | null;
    eventCount: number;
    avatarUrl: string | null;
    skippedAt: string;
  }>(`
    SELECT
      platform,
      platform_id as platformId,
      display_name as displayName,
      username,
      event_count as eventCount,
      avatar_url as avatarUrl,
      last_seen as skippedAt
    FROM identities
    WHERE skipped = 1
    ORDER BY last_seen DESC
  `);

  return rows.map((r) => ({
    identifier: formatIdentifier(r.platform, r.platformId),
    ...r,
  }));
}

/**
 * Get all identities linked to a contact.
 */
export async function getIdentitiesForContact(
  db: QueryExecutor,
  contactId: number
): Promise<Array<Identity>> {
  return await db.query<Identity>(`
    SELECT * FROM identities
    WHERE contact_id = ?
    ORDER BY platform, display_name
  `, contactId);
}

export interface SuggestedContactForIdentity {
  contactId: number;
  contactName: string;
  matchedIdentity: string;
  normalized: string;
}

/**
 * Normalize an identifier for matching (lowercase, replace separators with spaces).
 * Extracts the name portion from identifiers like "platform:name:Display Name".
 */
function normalizeIdentifier(identifier: string): string {
  // Parse the identifier to get the platform_id part
  const parts = identifier.split(":");
  if (parts.length < 2) return "";

  // Get the platform_id (everything after first colon)
  const platformId = parts.slice(1).join(":");

  // Extract name: if it starts with "name:", use that; otherwise use the whole platformId
  const name = platformId.startsWith("name:") ? platformId.slice(5) : platformId;

  // Normalize: lowercase, replace separators with spaces, trim
  return name
    .toLowerCase()
    .replace(/[_.\-]/g, " ")
    .trim();
}

/**
 * Find contacts whose identities match a given unlinked identity via name normalization.
 * Used by the "Link to..." modal to suggest likely contacts.
 */
export async function getSuggestedContactsForIdentity(
  db: QueryExecutor,
  identifier: string
): Promise<SuggestedContactForIdentity[]> {
  // Normalize the input identifier directly (don't rely on it being in identities table)
  const normalized = normalizeIdentifier(identifier);

  if (!normalized || normalized.length <= 2) {
    return [];
  }

  const result = await db.query<{
    contact_id: number;
    contact_name: string;
    matched_identity: string;
  }>(`
    SELECT
      c.id as contact_id,
      c.display_name as contact_name,
      (i.platform || ':' || i.platform_id) as matched_identity
    FROM identities i
    JOIN contacts c ON i.contact_id = c.id
    WHERE i.normalized_name = ?
      AND i.contact_id IS NOT NULL
    ORDER BY c.display_name
    LIMIT 10
  `, normalized);

  return result.map((r) => ({
    contactId: r.contact_id,
    contactName: r.contact_name,
    matchedIdentity: r.matched_identity,
    normalized,
  }));
}

export interface IdentityLinkSuggestion {
  identity: {
    identifier: string;
    platform: string;
    platformId: string;
    displayName: string | null;
    username: string | null;
    eventCount: number;
    avatarUrl: string | null;
  };
  contact: {
    id: number;
    displayName: string;
    identityCount: number;
    eventCount: number;
  };
  matchedVia: string;
}

/**
 * Find unlinked identities that have matching contacts via name normalization.
 * Returns suggestions for bulk linking in the Unlinked view.
 */
export async function getIdentityLinkSuggestions(
  db: QueryExecutor,
  limit = 10
): Promise<IdentityLinkSuggestion[]> {
  const result = await db.query<{
    // Unlinked identity fields
    u_platform: string;
    u_platform_id: string;
    u_display_name: string | null;
    u_username: string | null;
    u_event_count: number;
    u_avatar_url: string | null;
    // Contact fields
    c_id: number;
    c_display_name: string;
    c_identity_count: number;
    c_event_count: number;
    // Match info
    matched_identity: string;
  }>(`
    WITH contact_stats AS (
      SELECT contact_id, COUNT(*) as identity_count, COALESCE(SUM(event_count), 0) as total_event_count
      FROM identities
      WHERE contact_id IS NOT NULL
      GROUP BY contact_id
    )
    SELECT
      u.platform as u_platform,
      u.platform_id as u_platform_id,
      u.display_name as u_display_name,
      u.username as u_username,
      u.event_count as u_event_count,
      u.avatar_url as u_avatar_url,
      c.id as c_id,
      c.display_name as c_display_name,
      COALESCE(cs.identity_count, 0) as c_identity_count,
      COALESCE(cs.total_event_count, 0) as c_event_count,
      (l.platform || ':' || l.platform_id) as matched_identity
    FROM identities u
    JOIN identities l ON u.normalized_name = l.normalized_name
    JOIN contacts c ON l.contact_id = c.id
    LEFT JOIN contact_stats cs ON cs.contact_id = c.id
    WHERE u.contact_id IS NULL AND u.skipped = 0 AND u.event_count > 0
      AND l.contact_id IS NOT NULL
      AND LENGTH(u.normalized_name) > 2
      AND c.hidden = 0
    GROUP BY u.platform, u.platform_id
    ORDER BY u.event_count DESC
    LIMIT ?
  `, limit);

  return result.map((r) => ({
    identity: {
      identifier: formatIdentifier(r.u_platform, r.u_platform_id),
      platform: r.u_platform,
      platformId: r.u_platform_id,
      displayName: r.u_display_name,
      username: r.u_username,
      eventCount: r.u_event_count,
      avatarUrl: r.u_avatar_url,
    },
    contact: {
      id: r.c_id,
      displayName: r.c_display_name,
      identityCount: r.c_identity_count,
      eventCount: r.c_event_count,
    },
    matchedVia: r.matched_identity,
  }));
}
