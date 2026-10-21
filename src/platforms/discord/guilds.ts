/**
 * Discord Guild Metadata
 *
 * Persists each guild's icon hash captured from the Discord API into the
 * `discord_guilds` table (one row per guild). Mirrors the synchronous, no-network
 * upsert shape of emoji-downloader's upsertEmojiRefs — the icon image itself is
 * served straight from Discord's CDN, so there's nothing to download here.
 */

import type { Database } from "bun:sqlite";

export interface GuildInfo {
  id: string;
  /** Guild icon hash from the API, or null when the guild has no icon. */
  icon: string | null;
}

/**
 * Insert or refresh a guild's icon hash. Cheap; called when the sync refreshes
 * guild metadata (at most daily per guild). `last_seen` advances on every call.
 */
export function upsertGuild(db: Database, guild: GuildInfo): void {
  db.prepare(`
    INSERT INTO discord_guilds (guild_id, icon)
    VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      icon = excluded.icon,
      last_seen = datetime('now')
  `).run(guild.id, guild.icon);
}
