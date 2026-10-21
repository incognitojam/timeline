/**
 * Discord Guild Emoji Inventory
 *
 * Persists the guild-level custom emoji listing separately from the global
 * image cache. A successful listing is a complete snapshot for that guild:
 * seen emojis are upserted as current, and previously current rows missing
 * from the snapshot are marked removed.
 */

import type { Database } from "bun:sqlite";
import type { DiscordGuildEmoji } from "./client";

function boolToColumn(value: boolean | undefined): number | null {
  if (value === undefined) return null;
  return value ? 1 : 0;
}

function avatarUrl(user: DiscordGuildEmoji["user"]): string | null {
  if (!user?.avatar) return null;
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`;
}

export function upsertGuildEmojis(
  db: Database,
  guildId: string,
  emojis: DiscordGuildEmoji[],
): void {
  const upsert = db.prepare(`
    INSERT INTO discord_guild_emojis (
      guild_id, emoji_id, name, animated, available, managed, require_colons,
      uploader_id, uploader_username, uploader_display_name, uploader_avatar_url,
      raw_data, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?), NULL)
    ON CONFLICT(guild_id, emoji_id) DO UPDATE SET
      name = excluded.name,
      animated = excluded.animated,
      available = excluded.available,
      managed = excluded.managed,
      require_colons = excluded.require_colons,
      uploader_id = excluded.uploader_id,
      uploader_username = excluded.uploader_username,
      uploader_display_name = excluded.uploader_display_name,
      uploader_avatar_url = excluded.uploader_avatar_url,
      raw_data = excluded.raw_data,
      last_seen = datetime('now'),
      deleted_at = NULL
  `);

  const tx = db.transaction((rows: DiscordGuildEmoji[]) => {
    for (const emoji of rows) {
      const user = emoji.user;
      upsert.run(
        guildId,
        emoji.id,
        emoji.name,
        emoji.animated === true ? 1 : 0,
        boolToColumn(emoji.available),
        boolToColumn(emoji.managed),
        boolToColumn(emoji.require_colons),
        user?.id ?? null,
        user?.username ?? null,
        user?.global_name || user?.username || null,
        avatarUrl(user),
        JSON.stringify(emoji),
      );
    }

    if (rows.length === 0) {
      db.prepare(`
        UPDATE discord_guild_emojis
        SET deleted_at = datetime('now'), last_seen = datetime('now')
        WHERE guild_id = ? AND deleted_at IS NULL
      `).run(guildId);
      return;
    }

    const placeholders = rows.map(() => "?").join(", ");
    db.prepare(`
      UPDATE discord_guild_emojis
      SET deleted_at = datetime('now'), last_seen = datetime('now')
      WHERE guild_id = ? AND deleted_at IS NULL AND emoji_id NOT IN (${placeholders})
    `).run(guildId, ...rows.map((emoji) => emoji.id));
  });

  tx(emojis);
}
