import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { initDb } from "../../db/schema";
import { DISCORD_ATTACHMENT_RETRY_WHERE, ensureDiscordAttachmentRetryIndex, FIND_ATTACHMENT_RETRY_CANDIDATES } from "./attachment-retry-index";
import { retryDiscordAttachments } from "./attachment-retry";
import { DiscordClient } from "./client";

let db: Database;
beforeEach(() => { db = new Database(":memory:"); initDb(db); });
afterEach(() => db.close());
const now = new Date("2026-11-18T00:00:00.000Z");
const cutoff = "2026-10-19T00:00:00.000Z";
const asset = {id: "asset", filename: "photo.png", size: 20, url: "https://example.com/photo.png"};
function insert(id: string, raw: object = {attachments: [asset]}, timestamp = now.toISOString(), account = "account") {
  const row = db.query("INSERT INTO events(source,source_id,source_account,type,timestamp,raw_data) VALUES('discord',?,?,'message:guild',?,?) RETURNING id").get(id, account, timestamp, JSON.stringify({_channel:{id:"channel"}, ...raw})) as {id:number};
  return row.id;
}
function attach(eventId: number, status: string, sourceId = "asset", source = "discord") {
  db.query("INSERT INTO attachments(event_id,source,source_id,status) VALUES(?,?,?,?)").run(eventId, source, sourceId, status);
}
function candidates() { return db.query(FIND_ATTACHMENT_RETRY_CANDIDATES).all("account", cutoff, 25) as {event_id:number;message_id:string}[]; }
function equivalent() {
  const expected = db.query(`SELECT e.id FROM events e WHERE ${DISCORD_ATTACHMENT_RETRY_WHERE} AND e.source_account=? AND e.timestamp>=? ORDER BY e.timestamp DESC,e.id DESC LIMIT 25`).all("account", cutoff) as {id:number}[];
  expect(candidates().map(r => r.event_id)).toEqual(expected.map(r => r.id));
}

test("matches the existing predicate for direct, forwarded, sticker, duplicate, missing and completed assets", () => {
  insert("missing");
  insert("forward", {message_snapshots:[{message:{attachments:[asset]}}]});
  insert("sticker", {sticker_items:[{id:"sticker",name:"Wave",format_type:1}]});
  insert("forward-sticker", {message_snapshots:[{message:{sticker_items:[{id:"sticker",name:"Wave",format_type:1}]}}]});
  insert("ordinary", {content:"No assets"});
  insert("no-channel", {_channel:null, attachments:[asset]});
  insert("old", undefined, "2026-09-01T00:00:00.000Z");
  insert("other-account", undefined, now.toISOString(), "other");
  for (const status of ["stored", "failed", "pending", "unrecoverable"]) attach(insert(status), status);
  attach(insert("duplicate", {attachments:[asset,asset]}), "stored");
  const wrong = insert("wrong-source"); attach(wrong, "stored", "asset", "other");
  equivalent();
  expect(candidates().map(r=>r.message_id)).toEqual(["wrong-source","duplicate","failed","forward-sticker","sticker","forward","missing"]);
});

test("tracks event and attachment mutations, replacements, deletion, and account moves", () => {
  const a = insert("a"), b = insert("b"); equivalent();
  attach(a,"stored"); equivalent();
  db.query("UPDATE attachments SET status='failed' WHERE event_id=?").run(a); equivalent();
  db.query("UPDATE attachments SET event_id=?,status='stored' WHERE event_id=?").run(b,a); equivalent();
  db.query("DELETE FROM attachments WHERE event_id=?").run(b); equivalent();
  db.query("UPDATE events SET source_account='other' WHERE id=?").run(a); equivalent();
  db.query("UPDATE events SET raw_data='{}' WHERE id=?").run(b); equivalent();
  db.query("DELETE FROM events WHERE id=?").run(a); equivalent();
  const c = insert("replace");
  db.query("INSERT OR REPLACE INTO events(source,source_id,source_account,type,timestamp,raw_data) VALUES('discord','replace','account','message:guild',?,?)").run(now.toISOString(),JSON.stringify({_channel:{id:"channel"},attachments:[asset]}));
  equivalent();
  expect(db.query("SELECT 1 FROM discord_attachment_retry_pending WHERE event_id=?").get(c)).toBeNull();
  db.exec("UPDATE events SET id=id+1000 WHERE source_id='replace'");
  equivalent();
});

test("backfills existing rows once, uses the candidate index and keeps the 25-row ordering", () => {
  db.exec("DROP TABLE discord_attachment_retry_pending");
  // Existing databases predate both the derived table and its triggers.
  for (const row of db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'discord_attachment_retry_%'").all() as {name:string}[]) db.exec(`DROP TRIGGER ${row.name}`);
  for (let i=0;i<30;i++) insert(`message-${i}`);
  ensureDiscordAttachmentRetryIndex(db); equivalent();
  expect(candidates()).toHaveLength(25);
  const changes = db.query("SELECT total_changes() n").get();
  ensureDiscordAttachmentRetryIndex(db);
  expect(db.query("SELECT total_changes() n").get()).toEqual(changes);
  const plan = db.query(`EXPLAIN QUERY PLAN ${FIND_ATTACHMENT_RETRY_CANDIDATES}`).all("account", cutoff, 25) as {detail:string}[];
  expect(plan.some(r=>r.detail.includes("idx_discord_attachment_retry_pending"))).toBe(true);
  expect(plan.some(r=>r.detail.includes("TEMP B-TREE"))).toBe(false);
});

test("recovery tombstones a missing message and the next sweep makes no requests", async () => {
  insert("missing");
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return new Response(null,{status:404}); }) as unknown as typeof fetch;
  try {
    expect(await retryDiscordAttachments(db,new DiscordClient("test-token"),"account",undefined,now)).toEqual({attempted:1,stored:0,failed:0,unrecoverable:1,unavailable:0});
    expect(await retryDiscordAttachments(db,new DiscordClient("test-token"),"account",undefined,now)).toEqual({attempted:0,stored:0,failed:0,unrecoverable:0,unavailable:0});
    expect(requests).toBe(1); equivalent();
  } finally { globalThis.fetch = original; }
});

test("malformed archived JSON is preserved but never indexed for recovery", () => {
  db.exec("DROP TABLE discord_attachment_retry_pending");
  for (const row of db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'discord_attachment_retry_%'").all() as {name:string}[]) db.exec(`DROP TRIGGER ${row.name}`);
  db.exec("INSERT INTO events(source,source_id,source_account,type,raw_data) VALUES('discord','malformed','account','message:dm','not json')");
  ensureDiscordAttachmentRetryIndex(db);
  db.exec("INSERT INTO events(source,source_id,source_account,type,raw_data) VALUES('discord','also-malformed','account','message:dm','{')");
  expect(candidates()).toEqual([]);
  expect(db.query("SELECT raw_data FROM events WHERE source_id='malformed'").get()).toEqual({raw_data: "not json"});
});
