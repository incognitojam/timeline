import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { Database } from "../../db/sqlite";
import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../../db/schema";
import { DEFAULT_BOUNDED_WRITER_LIMITS } from "../../db/bounded-writes";
import { importClaudeCode, CLAUDE_CODE_PARSER_VERSION } from "./parser";

const options = { writeLimits: { ...DEFAULT_BOUNDED_WRITER_LIMITS, pauseMs: 0, maxQueuedWrites: 2 } };
let root: string;
let db: Database;
let reference: Database;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;
const file = (id: string) => join(root, "project", `${id}.jsonl`);
const subagent = (id: string) => join(root, "project", "main", "subagents", `agent-${id}.jsonl`);
const message = (uuid: string, text: string) => JSON.stringify({ type: "user", uuid, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: text === "new" ? [{ type: "text", text }, { type: "image", source: { type: "base64", media_type: "image/png", data: "c3ludGhldGljIHBpY3R1cmU=" } }] : text } });
const rows = (database: Database) => (database.prepare("SELECT * FROM events ORDER BY source_id").all() as Record<string, unknown>[])
  .map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !["id", "imported_at", "import_batch"].includes(key))));

beforeEach(async () => {
  clock = spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  root = await mkdtemp(join(tmpdir(), "claude-checkpoints-"));
  await mkdir(join(root, "project", "main", "subagents"), { recursive: true });
  db = new Database(join(root, "events.db")); reference = new Database(":memory:");
  initDb(db); initDb(reference);
});
afterEach(async () => { clock.mockRestore(); db.close(); reference.close(); await rm(root, { recursive: true, force: true }); });

it("matches a full reread through main and subagent appends, rewrites, additions and deletions", async () => {
  const compare = async () => {
    const stats = await importClaudeCode(db, root, "alice", options);
    await importClaudeCode(reference, root, "alice", { ...options, full: true });
    expect(rows(db)).toEqual(rows(reference));
    const identities = (database: Database) => database.prepare("SELECT platform, platform_id, display_name, username, avatar_url FROM identities ORDER BY platform, platform_id").all();
    const attachments = (database: Database) => database.prepare(`SELECT e.source_id AS event_source_id, a.source_id, a.content_hash, a.filename, a.mime_type, a.file_size, a.storage_path, a.status FROM attachments a JOIN events e ON e.id = a.event_id ORDER BY e.source_id, a.source_id`).all();
    expect(identities(db)).toEqual(identities(reference));
    expect(attachments(db)).toEqual(attachments(reference));
    return stats;
  };
  await writeFile(file("main"), `${message("one", "one")}\n`);
  await writeFile(subagent("child"), `${message("child-one", "child")}\n`);
  await compare();
  expect((await compare()).filesSkipped).toBe(2);
  await appendFile(file("main"), `${message("two", "two")}\n`);
  expect((await compare()).filesSkipped).toBe(0);
  await appendFile(subagent("child"), `${message("child-two", "new")}\n`);
  expect((await compare()).messages).toBe(1);
  const before = await stat(file("main"));
  await writeFile(file("main"), `${message("six", "six")}\n${message("ten", "ten")}\n`);
  expect((await stat(file("main"))).size).toBe(before.size);
  await utimes(file("main"), before.atime, before.mtime);
  expect((await compare()).messages).toBe(2);
  await appendFile(file("main"), `${JSON.stringify({ type: "assistant", uuid: "task", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", model: "claude-sonnet-4", content: [{ type: "tool_use", name: "Task", id: "task-new", input: { prompt: "added" } }] } })}\n`);
  await compare();
  await writeFile(subagent("new"), `${message("new-child", "added")}\n`);
  expect((await compare()).messages).toBe(1);
  const linked = db.prepare("SELECT raw_data FROM events WHERE source_id = 'main:new-child'").get() as { raw_data: string };
  expect(JSON.parse(linked.raw_data).parent_tool_use_id).toBe("task-new");
  await rm(subagent("child"));
  expect((await compare()).filesSkipped).toBe(0);
  await writeFile(file("other"), `${message("new-session", "new")}\n`);
  expect((await compare()).messages).toBe(1);
  await rm(file("other"));
  await compare();
  expect(db.prepare("SELECT * FROM file_import_checkpoints WHERE path = ?").get(file("other"))).toBeNull();
  db.prepare("UPDATE file_import_checkpoints SET version = ?").run(CLAUDE_CODE_PARSER_VERSION - 1);
  expect((await compare()).filesSkipped).toBe(0);
  expect((await importClaudeCode(db, root, "alice", { ...options, full: true })).filesSkipped).toBe(0);
});

it("finishes a partially committed session on retry", async () => {
  await writeFile(file("main"), `${message("one", "one")}\n${message("two", "two")}\n${message("three", "fail")}\n`);
  db.exec(`CREATE TRIGGER fail_import BEFORE INSERT ON events WHEN NEW.content = 'fail'
    BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  await expect(importClaudeCode(db, root, "alice", options)).rejects.toThrow("injected failure");
  expect(rows(db)).toHaveLength(2);
  expect(db.prepare("SELECT * FROM file_import_checkpoints").all()).toHaveLength(0);
  db.exec("DROP TRIGGER fail_import");
  await importClaudeCode(db, root, "alice", options);
  await importClaudeCode(reference, root, "alice", { ...options, full: true });
  expect(rows(db)).toEqual(rows(reference));
});

it("does not rewrite title suppression or take the write lock on unchanged reads", async () => {
  await writeFile(file("main"), `${message("one", "one")}\n`);
  const titles = join(root, "-tmp-t3code-claude-title-test");
  await mkdir(titles);
  await writeFile(join(titles, "title.jsonl"), "");
  await importClaudeCode(db, root, "alice", options);
  const suppressed = db.prepare("SELECT * FROM superseded_conversations").all();
  expect(suppressed).toHaveLength(1);
  const other = new Database(join(root, "events.db")); other.exec("BEGIN IMMEDIATE");
  try {
    expect((await importClaudeCode(db, root, "alice", options)).writeTransactions).toBe(0);
    expect((await importClaudeCode(db, root, "alice", { ...options, full: true })).writeTransactions).toBe(0);
    expect(db.prepare("SELECT * FROM superseded_conversations").all()).toEqual(suppressed);
  } finally { other.exec("ROLLBACK"); other.close(); }
  db.exec("DELETE FROM events WHERE source = 'claude-code'");
  expect((await importClaudeCode(db, root, "alice", options)).messages).toBe(1);
});

it("rereads after a subagent appears during import and converges on the next run", async () => {
  await writeFile(file("main"), `${message("one", "one")}\n${message("two", "two")}\n`);
  const run = importClaudeCode(db, root, "alice", { writeLimits: { ...options.writeLimits, maxQueuedWrites: 1 } });
  while (rows(db).length === 0) await new Promise<void>(resolve => setImmediate(resolve));
  await writeFile(subagent("late"), `${message("late", "late")}\n`);
  await run;
  expect((await importClaudeCode(db, root, "alice", options)).filesSkipped).toBe(0);
  await importClaudeCode(reference, root, "alice", { ...options, full: true });
  expect(rows(db)).toEqual(rows(reference));
  expect(rows(db)).toHaveLength(3);
});

it("does not save progress over events deleted after comparison", async () => {
  await writeFile(file("main"), `${message("old", "old")}\n`);
  await importClaudeCode(db, root, "alice", options);
  await appendFile(file("main"), `${message("new", "new")}\n`);
  db.exec(`CREATE TRIGGER delete_during_import AFTER INSERT ON events WHEN NEW.content = 'new'
    BEGIN DELETE FROM events WHERE source = 'claude-code' AND content = 'old'; END`);
  await importClaudeCode(db, root, "alice", options);
  expect(db.prepare("SELECT * FROM file_import_checkpoints").all()).toHaveLength(0);
  db.exec("DROP TRIGGER delete_during_import");
  expect((await importClaudeCode(db, root, "alice", options)).messages).toBe(1);
  expect(rows(db)).toHaveLength(2);
});

it("does not create identities for empty assistant messages", async () => {
  await writeFile(file("main"), JSON.stringify({ type: "assistant", uuid: "empty", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", content: [], model: "claude-ghost-9" } }));
  await importClaudeCode(db, root, "alice", options);
  expect(db.prepare("SELECT * FROM identities WHERE platform_id = 'claude-ghost-9'").all()).toHaveLength(0);
});


it("treats a regular subagents file as absent and notices its replacement directory", async () => {
  const path = join(root, "project", "main", "subagents");
  await rm(path, { recursive: true });
  await writeFile(path, "not a directory");
  await writeFile(file("main"), `${message("one", "one")}\n`);
  expect((await importClaudeCode(db, root, "alice", options)).messages).toBe(1);
  expect((await importClaudeCode(db, root, "alice", options)).filesSkipped).toBe(1);
  await rm(path);
  await mkdir(path);
  await writeFile(subagent("child"), `${message("child", "child")}\n`);
  expect((await importClaudeCode(db, root, "alice", options)).messages).toBe(1);
  expect(rows(db)).toHaveLength(2);
});

it("refreshes existing raw data even when the log has a matching checkpoint", async () => {
  await writeFile(file("main"), `${message("one", "one")}\n`);
  await importClaudeCode(db, root, "alice", options);
  const original = rows(db);
  db.exec("UPDATE events SET content = 'stale', raw_data = '{}' WHERE source = 'claude-code'");
  expect((await importClaudeCode(db, root, "alice", options)).filesSkipped).toBe(1);
  const refreshed = await importClaudeCode(db, root, "alice", { ...options, refreshRawData: true });
  expect(refreshed.filesSkipped).toBe(0);
  expect(refreshed.refreshed).toBe(1);
  expect(rows(db)).toEqual(original);
});

it("rechecks duplicate UUIDs queued before either event is written", async () => {
  await writeFile(file("main"), `${message("same", "first")}\n${message("same", "new")}\n`);
  const stats = await importClaudeCode(db, root, "alice", {
    writeLimits: { ...options.writeLimits, maxQueuedWrites: 100 },
  });
  expect(stats.messages).toBe(1);
  expect(stats.skipped).toBe(1);
  expect(rows(db).map(row => row.content)).toEqual(["first"]);
  expect(db.prepare("SELECT * FROM attachments").all()).toHaveLength(0);
});

it("does not checkpoint a quiet main log while a subagent timestamp is fresh", async () => {
  await writeFile(file("main"), `${message("one", "one")}\n`);
  await writeFile(subagent("child"), `${message("child", "child")}\n`);
  const future = new Date(Date.now() + 120_000);
  await utimes(subagent("child"), future, future);
  await importClaudeCode(db, root, "alice", options);
  expect(db.prepare("SELECT * FROM file_import_checkpoints").all()).toHaveLength(0);
  const past = new Date("2026-01-01T00:00:00Z");
  await utimes(subagent("child"), past, past);
  expect((await importClaudeCode(db, root, "alice", options)).filesSkipped).toBe(0);
  expect((await importClaudeCode(db, root, "alice", options)).filesSkipped).toBe(2);
});
