import { test, expect, spyOn } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../../db/sqlite";
import { initDb } from "../../db/schema";
import { importClaudeExport } from "./parser";
import { processAutoDetectZip } from "../../inbox/zip-handlers";
import { exportZips } from "./export";
const date = "2026-01-01T00:00:00Z";
const conversation = (uuid = "conversation", name: string | null = "Old title", text = "Old text") => ({ uuid, name, created_at: date, updated_at: date, account: { uuid: "account" }, chat_messages: [{ uuid: "message", sender: "human", text, content: [], created_at: date, updated_at: date, attachments: [{ file_name: "notes.txt", extracted_content: "Notes", file_type: "text/plain", file_size: 5 }], files: [], parent_message_uuid: null }] });
async function fixture(run: (db: Database, root: string, zip: (name: string, files: Record<string, unknown>) => Promise<string>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "claude-review-"));
  const db = new Database(":memory:"); initDb(db);
  let n = 0;
  const zip = async (name: string, files: Record<string, unknown>) => {
    const stage = join(root, `stage-${n++}`); await mkdir(stage);
    for (const [name, value] of Object.entries(files)) { const path = join(stage, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
    const path = join(root, name);
    const proc = Bun.spawn(["zip", "-q", path, ...Object.keys(files)], { cwd: stage });
    expect(await proc.exited).toBe(0); return path;
  };
  try { await run(db, root, zip); } finally { db.close(); await rm(root, { recursive: true, force: true }); }
}

test("old layout reimport preserves messages, counts renames, skips empties and archives refresh", () => fixture(async (db, _root, zip) => {
  const old = await zip("legacy.zip", { "conversations.json": [conversation()], "memories.json": [{ conversations_memory: "Legacy memory", updated_at: date }] });
  await importClaudeExport(db, old, "operator");
  const snapshot = db.query("SELECT source_id, source_account, timestamp, content, raw_data FROM events ORDER BY id").all();
  const fresh = conversation("conversation", "New title", "Edited text");
  fresh.chat_messages[0].attachments = [];
  const newer = await zip("conversations-000.zip", { "conversations.json": [fresh, conversation("empty", "", "")] });
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await importClaudeExport(db, newer, "operator", { dryRun: true });
    expect(log.mock.calls.flat().join("\n")).toContain("renamed conversations: 1");
    expect(log.mock.calls.flat().join("\n")).toContain("Conversations new: 0");
  } finally { log.mockRestore(); }
  await importClaudeExport(db, newer, "operator");
  expect(db.query("SELECT source_id, source_account, timestamp, content, raw_data FROM events ORDER BY id").all()).toEqual(snapshot);
  expect(db.query("SELECT title FROM events WHERE source_id = 'conversation:message'").get()).toEqual({ title: "New title" });
  expect(await importClaudeExport(db, old, "operator", { dryRun: true })).toBe(0);
  await importClaudeExport(db, newer, "operator", { refreshRawData: true });
  expect(db.query("SELECT raw_data FROM event_versions").get()).toEqual({ raw_data: (snapshot[0] as { raw_data: string }).raw_data });
}));

test("late invalid conversations write nothing; inbox rejects invalid category and imports nested content", () => fixture(async (db, _root, zip) => {
  const late = await zip("conversations-000.zip", { "conversations.json": [...Array.from({ length: 250 }, (_, i) => conversation(`c-${i}`)), conversation("invalid", null)] });
  await expect(importClaudeExport(db, late, "operator")).rejects.toThrow("name");
  expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 0 });
  const invalid = await zip("conversations-001.zip", { "conversations.json": [conversation("invalid", null)] });
  await expect(processAutoDetectZip(db, invalid, "operator")).rejects.toThrow("name");
  const nested = await zip("conversations-002.zip", { "export/conversations.json": [conversation()] });
  expect((await processAutoDetectZip(db, nested, "operator")).eventsAdded).toBe(1);
}));

test("inbox refuses overlapping identities even when the wrong account already exists", () => fixture(async (db, _root, zip) => {
  const old = await zip("legacy.zip", { "conversations.json": [conversation()], "memories.json": [] });
  await importClaudeExport(db, old, "operator");
  db.prepare("INSERT INTO events (source, source_id, source_account, type, content, raw_data) VALUES ('claude', 'stray', 'wrong', 'claude:memory', 'stray', '{}')").run();
  const incoming = await zip("conversations-000 (1).zip", { "conversations.json": [conversation()] });
  await expect(processAutoDetectZip(db, incoming, "wrong")).rejects.toThrow("already exist under another account");
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    await importClaudeExport(db, incoming, "wrong", { dryRun: true });
    expect(log.mock.calls.flat().join("\n")).toContain("Messages already present under other accounts: 1");
  } finally { log.mockRestore(); }
  expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 2 });
}));

test("folder discovery validates renamed parts, gaps, unknown ZIPs and manifests", () => fixture(async (_db, root, zip) => {
  await zip("conversations-000 (1).zip", { "conversations.json": [] });
  expect((await exportZips(root)).length).toBe(1);
  await writeFile(join(root, "manifest.json"), JSON.stringify({ version: "1.0", data_files: [{ filename: "conversations-000.zip" }, { filename: "feedback-000.zip" }] }));
  await expect(exportZips(root)).rejects.toThrow("feedback-000.zip");
  await rm(join(root, "manifest.json"));
  await zip("conversations-002.zip", { "conversations.json": [] });
  await expect(exportZips(root)).rejects.toThrow("contiguous");
  await zip("unexpected.zip", { "other.json": [] });
  await expect(exportZips(root)).rejects.toThrow("unexpected.zip");
}));

test("CLI resolves service configuration from another cwd, refuses missing databases and selects configured SQLite", () => fixture(async (db, root, zip) => {
  const file = await zip("conversations-000.zip", { "conversations.json": [conversation()] });
  const database = join(root, "existing.db");
  await writeFile(database, db.serialize());
  const before = await Bun.file(database).arrayBuffer();
  await writeFile(join(root, "config.toml"), `[database]\npath = ${JSON.stringify(database)}\n`);
  const run = async (path: string, library?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, TIMELINE_DB_PATH: path, TIMELINE_CONFIG: join(root, "config.toml"), TIMELINE_ENV_FILE: join(root, "missing.env") };
    if (library) env.TIMELINE_SQLITE_LIBRARY_PATH = library;
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "parser.ts"), file, "operator", "--dry-run"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    return { code: await proc.exited, text: await new Response(proc.stdout).text() + await new Response(proc.stderr).text() };
  };
  const configured = await run("");
  expect(configured.code).toBe(0);
  expect(configured.text).toContain(`Database: ${database} (0 events)`);
  expect(await Bun.file(join(root, "timeline.db")).exists()).toBe(false);
  expect((await run(join(root, "missing.db"))).text).toContain("Database does not exist");
  expect(await Bun.file(join(root, "missing.db")).exists()).toBe(false);
  expect((await run(database, join(root, "missing-sqlite"))).text).toContain("Failed to load TIMELINE_SQLITE_LIBRARY_PATH");
  const preview = await run(database);
  expect(preview.code).toBe(0);
  expect(preview.text).toContain(`Database: ${database} (0 events)`);
  expect(await Bun.file(database).arrayBuffer()).toEqual(before);
}));

test("inbox leaves invalid exports unprocessed and records unsupported categories as skipped", () => fixture(async (_db, root, zip) => {
  const invalid = await zip("conversations-000.zip", { "conversations.json": [conversation("invalid", null)] });
  await zip("feedback-000 (1).zip", { "reflections/account.json": { account_uuid: "account", reflections: [], feedback: [] } });
  const resultPath = join(root, "result.json");
  const script = `
    import { processSource } from ${JSON.stringify(join(import.meta.dir, "../../inbox/process.ts"))};
    import { getAppStateDb } from ${JSON.stringify(join(import.meta.dir, "../../db/app-state.ts"))};
    const source = { type: "local", local: ${JSON.stringify(root)}, parser: "auto-detect", account: "operator", patterns: ["*.zip"] };
    const result = await processSource({ sources: { test: source }, inbox_path: ${JSON.stringify(root)}, archive_path: ${JSON.stringify(join(root, "archive"))} }, "test", source, {});
    const db = getAppStateDb();
    await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ result, processed: db.query("SELECT count(*) AS n FROM processed_files").get(), logs: db.query("SELECT success, skipped, metadata FROM sync_log ORDER BY id").all() }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, TIMELINE_DB_PATH: join(root, "inbox.db") }, stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  const stderr = await new Response(child.stderr).text();
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const result = await Bun.file(resultPath).json();
  expect(result.result.errors).toHaveLength(1);
  expect(result.processed).toEqual({ n: 1 });
  expect(result.logs[0].success).toBe(0);
  expect(result.logs[1].skipped).toBe(1);
  expect(JSON.parse(result.logs[1].metadata).skipReason).toBe("skipped: not imported (feedback)");
  expect(await Bun.file(invalid).exists()).toBe(true);
  expect(await Bun.file(join(root, "archive/test/feedback-000 (1).zip")).exists()).toBe(true);
}));

test("raw blocks are not duplicated merely because their keys are reordered", () => fixture(async (db, _root, zip) => {
  const conv = conversation();
  const message = { ...conv.chat_messages[0], text: "Text", content: [{ text: "Text", type: "text" }] };
  const path = await zip("conversations-000.zip", { "conversations.json": [{ ...conv, chat_messages: [message] }] });
  await importClaudeExport(db, path, "operator");
  const row = db.query("SELECT raw_data FROM events").get() as { raw_data: string };
  const raw = JSON.parse(row.raw_data);
  expect(raw.content).toEqual([{ type: "text", text: "Text" }]);
  expect(raw.original_content).toBeUndefined();
  expect(raw.text).toBeUndefined();
}));

test("an empty exported name does not replace an existing title", () => fixture(async (db, _root, zip) => {
  await importClaudeExport(db, await zip("old.zip", { "conversations.json": [conversation()] }), "operator");
  await importClaudeExport(db, await zip("conversations-000.zip", { "conversations.json": [conversation("conversation", "")] }), "operator");
  expect(db.query("SELECT title FROM events").get()).toEqual({ title: "Old title" });
}));

test("a second identical refresh adds no history", () => fixture(async (db, _root, zip) => {
  await importClaudeExport(db, await zip("old.zip", { "conversations.json": [conversation()] }), "operator");
  const path = await zip("conversations-000.zip", { "conversations.json": [conversation("conversation", "New title", "New text")] });
  await importClaudeExport(db, path, "operator", { refreshRawData: true });
  expect(db.query("SELECT count(*) AS n FROM event_versions").get()).toEqual({ n: 1 });
  await importClaudeExport(db, path, "operator", { refreshRawData: true });
  expect(db.query("SELECT count(*) AS n FROM event_versions").get()).toEqual({ n: 1 });
}));

test("an account without history requires confirmation even without overlapping messages", () => fixture(async (db, _root, zip) => {
  await importClaudeExport(db, await zip("old.zip", { "conversations.json": [conversation()] }), "operator");
  const path = await zip("conversations-000.zip", { "conversations.json": [conversation("unrelated")] });
  await expect(importClaudeExport(db, path, "new-account")).rejects.toThrow("--allow-new-account");
  expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 1 });
}));
