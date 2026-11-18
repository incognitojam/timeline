import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { Database } from "../../db/sqlite";
import { appendFile, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../../db/schema";
import { DEFAULT_BOUNDED_WRITER_LIMITS } from "../../db/bounded-writes";
import { importCodex, CODEX_PARSER_VERSION } from "./parser";

const limits = { ...DEFAULT_BOUNDED_WRITER_LIMITS, pauseMs: 0, maxQueuedWrites: 2 };
const options = { writeLimits: limits };
let root: string;
let db: Database;
let reference: Database;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;
const file = (id: string) => join(root, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
const message = (text: string) => JSON.stringify({ type: "event_msg", timestamp: "2026-01-01T00:00:00Z", payload: { type: "user_message", message: text, images: ["data:image/png;base64,c3ludGhldGljIHBpY3R1cmU="] } });
const meta = (id: string, parent?: string) => JSON.stringify({ type: "session_meta", payload: { id, source: parent ? { subagent: "review" } : "cli", parent_thread_id: parent } });
const rows = (database: Database) => (database.prepare("SELECT * FROM events ORDER BY source_id").all() as Record<string, unknown>[])
  .map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !["id", "imported_at", "import_batch"].includes(key))));

beforeEach(async () => {
  clock = spyOn(Date, "now").mockReturnValue(Date.now());
  root = await mkdtemp(join(tmpdir(), "codex-checkpoints-"));
  db = new Database(join(root, "events.db"));
  reference = new Database(":memory:");
  initDb(db);
  initDb(reference);
});
afterEach(async () => { clock.mockRestore(); db.close(); reference.close(); await rm(root, { recursive: true, force: true }); });

it("matches a full reread through append, rewrite, parent changes, deletion and rotation", async () => {
  const compare = async () => {
    const stats = await importCodex(db, root, "alice", options);
    await importCodex(reference, root, "alice", { ...options, full: true });
    expect(rows(db)).toEqual(rows(reference));
    const identities = (database: Database) => database.prepare("SELECT platform, platform_id, display_name, username, avatar_url FROM identities ORDER BY platform, platform_id").all();
    const attachments = (database: Database) => database.prepare(`SELECT e.source_id AS event_source_id, a.source_id, a.content_hash, a.filename, a.mime_type, a.file_size, a.storage_path, a.status FROM attachments a JOIN events e ON e.id = a.event_id ORDER BY e.source_id, a.source_id`).all();
    expect(identities(db)).toEqual(identities(reference));
    expect(attachments(db)).toEqual(attachments(reference));
    return stats;
  };
  await writeFile(file("parent"), `${meta("parent")}\n${message("one")}\n`);
  await writeFile(file("child"), `${meta("child", "parent")}\n${message("one")}\n${message("two")}\n`);
  await compare();
  expect((await compare()).filesSkipped).toBe(2);
  await appendFile(file("parent"), `${message("three")}\n`);
  expect((await compare()).filesSkipped).toBe(0);
  // Restore mtime after a same-size rewrite: ctime still invalidates it.
  const before = await stat(file("parent"));
  await writeFile(file("parent"), `${meta("parent")}\n${message("six")}\n${message("seven")}\n`);
  expect((await stat(file("parent"))).size).toBe(before.size);
  await utimes(file("parent"), before.atime, before.mtime);
  expect((await compare()).filesSkipped).toBe(0);
  await writeFile(file("new"), `${meta("new")}\n${message("new").replace("user_message", "agent_message")}\n`);
  expect((await compare()).messages).toBe(1);
  await rm(file("parent"));
  expect((await compare()).filesSkipped).toBe(1);
  expect(db.prepare("SELECT * FROM file_import_checkpoints WHERE path = ?").get(file("parent"))).toBeNull();
  await writeFile(file("parent"), `${meta("parent")}\n${message("rotated")}\n`);
  expect((await compare()).filesSkipped).toBe(1);
  db.prepare("UPDATE file_import_checkpoints SET version = ?").run(CODEX_PARSER_VERSION - 1);
  expect((await compare()).filesSkipped).toBe(0);
  expect((await importCodex(db, root, "alice", { ...options, full: true })).filesSkipped).toBe(0);
});

it("retries the unfinished file after a later batch fails, without losing committed events", async () => {
  await writeFile(file("a"), `${meta("a")}\n${message("a")}\n`);
  await writeFile(file("b"), `${meta("b")}\n${message("b")}\n${message("fail")}\n`);
  db.exec(`CREATE TRIGGER fail_import BEFORE INSERT ON events WHEN NEW.content = 'fail'
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  await expect(importCodex(db, root, "alice", options)).rejects.toThrow("injected failure");
  expect(rows(db).length).toBeGreaterThan(0);
  expect(db.prepare("SELECT * FROM file_import_checkpoints WHERE path = ?").get(file("b"))).toBeNull();
  db.exec("DROP TRIGGER fail_import");
  await importCodex(db, root, "alice", options);
  await importCodex(reference, root, "alice", { ...options, full: true });
  expect(rows(db)).toEqual(rows(reference));
  expect((await importCodex(db, root, "alice", options)).filesSkipped).toBe(2);
});

it("does not checkpoint a file appended while its batches commit", async () => {
  await writeFile(file("a"), `${meta("a")}\n${message("one")}\n${message("two")}\n`);
  const run = importCodex(db, root, "alice", { writeLimits: { ...limits, maxQueuedWrites: 1 } });
  // Wait for real progress, then change input before the remaining batches.
  while (rows(db).length === 0) await new Promise<void>(resolve => setImmediate(resolve));
  await appendFile(file("a"), `${message("late")}\n`);
  await run;
  await importCodex(db, root, "alice", options);
  expect(rows(db)).toHaveLength(3);
});

it("takes no write lock on unchanged and forced full reads; deletion invalidates progress", async () => {
  await writeFile(file("a"), `${meta("a")}\n${message("one")}\n`);
  await importCodex(db, root, "alice", options);
  const other = new Database(join(root, "events.db"));
  other.exec("BEGIN IMMEDIATE");
  try {
    expect((await importCodex(db, root, "alice", options)).writeTransactions).toBe(0);
    expect((await importCodex(db, root, "alice", { ...options, full: true })).writeTransactions).toBe(0);
  } finally { other.exec("ROLLBACK"); other.close(); }
  db.exec("DELETE FROM events WHERE source = 'codex'");
  expect((await importCodex(db, root, "alice", options)).messages).toBe(1);
});

it("persists progress across connections without sharing it between accounts or roots", async () => {
  await writeFile(file("a"), `${meta("a")}\n${message("one")}\n`);
  await importCodex(db, root, "alice", options);
  db.close();
  db = new Database(join(root, "events.db"));
  expect((await importCodex(db, root, "alice", options)).filesSkipped).toBe(1);
  expect((await importCodex(db, root, "bob", options)).messages).toBe(1);
  const otherRoot = await mkdtemp(join(root, "other-"));
  await writeFile(join(otherRoot, "rollout-other.jsonl"), `${meta("other")}\n${message("other")}\n`);
  expect((await importCodex(db, otherRoot, "alice", options)).messages).toBe(1);
});

it("does not save progress over events deleted after comparison", async () => {
  await writeFile(file("a"), `${meta("a")}\n${message("old")}\n`);
  await importCodex(db, root, "alice", options);
  await appendFile(file("a"), `${message("new")}\n`);
  db.exec(`CREATE TRIGGER delete_during_import AFTER INSERT ON events WHEN NEW.content = 'new'
    BEGIN DELETE FROM events WHERE source = 'codex' AND content = 'old'; END`);
  await importCodex(db, root, "alice", options);
  expect(db.prepare("SELECT * FROM file_import_checkpoints").all()).toHaveLength(0);
  db.exec("DROP TRIGGER delete_during_import");
  expect((await importCodex(db, root, "alice", options)).messages).toBe(1);
  expect(rows(db)).toHaveLength(2);
});
