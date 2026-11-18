import { expect, test } from "bun:test";
import { Database } from "./sqlite";
import { initDb } from "./schema";

test("event deletion removes only its children, transactionally", () => {
  using db = new Database(":memory:");
  initDb(db);
  const insert = db.query(`INSERT INTO events(id, source, source_id, source_account, type, timestamp, title, raw_data)
    VALUES (?, 'manual', ?, '', 'note', '2026-01-01T12:00:00Z', 'synthetic', '{}')
    ON CONFLICT(id) DO UPDATE SET title=excluded.title`);
  insert.run(1, 'one');
  insert.run(2, 'two');
  db.exec(`INSERT INTO attachments(event_id, source, content_hash) VALUES (1, 'manual', 'shared'), (2, 'manual', 'shared'), (999, 'manual', 'orphan');
    INSERT INTO discord_reaction_observations VALUES (1, 'initial', '2026-01-01', 0, 1, '{}'), (999, 'initial', '2026-01-01', 0, 1, '{}')`);
  initDb(db);
  insert.run(1, 'one');
  expect(db.query('SELECT count(*) n FROM attachments').get()).toEqual({ n: 3 });
  db.exec('BEGIN; DELETE FROM events WHERE id=1; ROLLBACK');
  expect(db.query('SELECT count(*) n FROM attachments').get()).toEqual({ n: 3 });
  expect(db.query('SELECT count(*) n FROM discord_reaction_observations').get()).toEqual({ n: 2 });
  db.exec('DELETE FROM events WHERE id=1');
  expect(db.query('SELECT event_id FROM attachments ORDER BY event_id').all()).toEqual([{ event_id: 2 }, { event_id: 999 }]);
  expect(db.query('SELECT event_id FROM discord_reaction_observations').all()).toEqual([{ event_id: 999 }]);
  for (const table of ['events_fts', 'events_fts_stemmed']) {
    db.exec(`INSERT INTO ${table}(${table}, rank) VALUES ('integrity-check', 1)`);
  }
  expect(db.query('SELECT sum(event_count) n FROM event_day_sources').get()).toEqual({ n: 1 });
});

test("event references have an explicit deletion policy", () => {
  using db = new Database(":memory:");
  initDb(db);
  const policies: Record<string, string> = {
    attachments: 'delete rows; retain blobs',
    discord_reaction_observations: 'delete rows',
    event_versions: 'delete rows',
    event_people: 'delete rows and update identity counts',
    conversation_summaries: 'recompute title anchor',
    coding_agent_conversations: 'recompute project anchor',
    discord_attachment_retry_pending: 'delete pending entry',
    render_sweep_state: 'retain cursor',
  };
  const references = new Set<string>();
  for (const { name } of db.query<{name: string}, []>("SELECT name FROM sqlite_schema WHERE type='table'").all()) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const foreignKeys = db.query<{table: string}, []>(`PRAGMA foreign_key_list(${quoted})`).all();
    const columns = db.query<{name: string}, []>(`PRAGMA table_info(${quoted})`).all();
    if (foreignKeys.some((fk) => fk.table === 'events') || columns.some((column) => /(^|_)event_id$/.test(column.name))) references.add(name);
  }
  expect([...references].sort()).toEqual(Object.keys(policies).sort());
});

test("attachment cleanup cannot resurrect a deleted Discord retry candidate", () => {
  using db = new Database(":memory:");
  initDb(db);
  db.exec(`INSERT INTO events(id, source, source_id, type, timestamp, raw_data)
    VALUES (1, 'discord', 'synthetic-message', 'message:dm', '2026-01-01T12:00:00Z', '{"attachments":[{"id":"synthetic-asset"}],"_channel":{"id":"synthetic-channel"}}');
    INSERT INTO attachments(event_id, source, status) VALUES (1, 'discord', 'failed')`);
  expect(db.query('SELECT event_id FROM discord_attachment_retry_pending').all()).toEqual([{ event_id: 1 }]);
  db.exec('DELETE FROM events WHERE id=1');
  expect(db.query('SELECT event_id FROM discord_attachment_retry_pending').all()).toEqual([]);
  expect(db.query('SELECT event_id FROM attachments').all()).toEqual([]);
});
