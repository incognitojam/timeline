import type { Database } from "bun:sqlite";

const rawAssetCount = `
    COALESCE(json_array_length(json_extract(e.raw_data, '$.attachments')), 0)
    + COALESCE((
      SELECT SUM(COALESCE(
        json_array_length(json_extract(snapshot.value, '$.message.attachments')),
        0
      ))
      FROM json_each(e.raw_data, '$.message_snapshots') snapshot
    ), 0)
    + COALESCE(json_array_length(json_extract(e.raw_data, '$.sticker_items')), 0)
    + COALESCE((
      SELECT SUM(COALESCE(
        json_array_length(json_extract(snapshot.value, '$.message.sticker_items')),
        0
      ))
      FROM json_each(e.raw_data, '$.message_snapshots') snapshot
    ), 0)
  `;

export const DISCORD_ATTACHMENT_RETRY_WHERE = `
e.source = 'discord'
      AND (${rawAssetCount}) > 0
      AND json_extract(e.raw_data, '$._channel.id') IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM attachments a
          WHERE a.event_id = e.id AND a.source = 'discord' AND a.status = 'failed'
        )
        OR NOT EXISTS (
          SELECT 1 FROM attachments a
          WHERE a.event_id = e.id AND a.source = 'discord'
        )
        OR (
          SELECT COUNT(*) FROM attachments a
          WHERE a.event_id = e.id AND a.source = 'discord'
        ) < (${rawAssetCount})
      )
`;

export const FIND_ATTACHMENT_RETRY_CANDIDATES = `
  SELECT e.id AS event_id, e.source_id AS message_id,
         json_extract(e.raw_data, '$._channel.id') AS channel_id, e.raw_data
  FROM discord_attachment_retry_pending p
  CROSS JOIN events e ON e.id = p.event_id
  WHERE p.source_account = ? AND p.timestamp >= ?
  ORDER BY p.timestamp DESC, p.event_id DESC
  LIMIT ?
`;

/** Materialize the cross-table predicate; SQLite partial indexes cannot contain subqueries. */
export function ensureDiscordAttachmentRetryIndex(db: Database): void {
  const refresh = (id: string) => `
    DELETE FROM discord_attachment_retry_pending WHERE event_id = ${id};
    INSERT INTO discord_attachment_retry_pending
    SELECT e.id, e.source_account, e.timestamp FROM events e
    WHERE e.id = ${id} AND ${DISCORD_ATTACHMENT_RETRY_WHERE};
  `;
  const triggers: Record<string, string> = {
    discord_attachment_retry_event_insert: `AFTER INSERT ON events WHEN NEW.source = 'discord' BEGIN ${refresh("NEW.id")} END`,
    discord_attachment_retry_event_update: `AFTER UPDATE OF id, source, source_account, timestamp, raw_data ON events WHEN OLD.source = 'discord' OR NEW.source = 'discord' BEGIN DELETE FROM discord_attachment_retry_pending WHERE event_id = OLD.id; ${refresh("NEW.id")} END`,
    discord_attachment_retry_event_delete: `AFTER DELETE ON events BEGIN DELETE FROM discord_attachment_retry_pending WHERE event_id = OLD.id; END`,
    discord_attachment_retry_asset_insert: `AFTER INSERT ON attachments WHEN NEW.source = 'discord' BEGIN ${refresh("NEW.event_id")} END`,
    discord_attachment_retry_asset_update: `AFTER UPDATE OF event_id, source, status ON attachments WHEN OLD.source = 'discord' OR NEW.source = 'discord' BEGIN ${refresh("OLD.event_id")} ${refresh("NEW.event_id")} END`,
    discord_attachment_retry_asset_delete: `AFTER DELETE ON attachments WHEN OLD.source = 'discord' BEGIN ${refresh("OLD.event_id")} END`,
  };
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
  db.transaction(() => {
    const exists = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='discord_attachment_retry_pending'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS discord_attachment_retry_pending (
      event_id INTEGER PRIMARY KEY, source_account TEXT, timestamp TEXT
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_discord_attachment_retry_pending
      ON discord_attachment_retry_pending(source_account, timestamp DESC, event_id DESC)`);
    let rebuild = !exists;
    for (const [name, definition] of Object.entries(triggers)) {
      const sql = `CREATE TRIGGER ${name} ${definition}`;
      const stored = db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as {sql: string} | null;
      if (stored && normalize(stored.sql) === normalize(sql)) continue;
      db.exec(`DROP TRIGGER IF EXISTS ${name}`);
      db.exec(sql);
      rebuild = true;
    }
    if (rebuild) {
      db.exec(`DELETE FROM discord_attachment_retry_pending;
        INSERT INTO discord_attachment_retry_pending
        SELECT e.id, e.source_account, e.timestamp FROM events e
        WHERE ${DISCORD_ATTACHMENT_RETRY_WHERE}`);
    }
  }).immediate();
}
