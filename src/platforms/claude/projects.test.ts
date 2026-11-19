import { test, expect } from "bun:test";
import { inferProject } from "./projects";
import { importClaudeExport } from "./parser";
import { Database } from "../../db/sqlite";
import { initDb } from "../../db/schema";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const id = "00000000-0000-4000-8000-000000000001";
test("inference accepts only one exact structured path match", () => {
  const projects = new Set([id, "second"]);
  expect(inferProject([{ content: [{ structured_content: { documents: [{ path_segments: ["notes", id] }] } }] }], projects)).toBe(id);
  expect(inferProject([{ content: [{ text: id, input: { path: `/${id}` } }] }], projects)).toBeNull();
  expect(inferProject([{ content: [{ structured_content: { path_segments: [id, "second"] } }] }], projects)).toBeNull();
});

test("projects preserve documents, are idempotent and version edits through ZIP imports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-projects-"));
  const db = new Database(":memory:");
  initDb(db);
  try {
    await mkdir(join(dir, "projects"));
    const zip = join(dir, "projects-000.zip");
    const write = async (name: string) => {
      await writeFile(join(dir, `projects/${id}.json`), JSON.stringify({ uuid: id, name, description: "Description", prompt_template: "Instructions", is_private: true, is_starter_project: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z", creator: { uuid: "account", full_name: "Alice" }, docs: [{ uuid: "doc", filename: "notes.md", content: "Complete document", created_at: "2026-01-01T00:00:00Z" }] }));
      const proc = Bun.spawn(["zip", "-q", zip, `projects/${id}.json`], { cwd: dir });
      expect(await proc.exited).toBe(0);
    };
    await write("Project");
    expect(await importClaudeExport(db, zip, "tester", { dryRun: true })).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 0 });
    expect(await importClaudeExport(db, zip, "tester")).toBe(1);
    expect(await importClaudeExport(db, zip, "tester")).toBe(0);
    const row = db.query("SELECT content, raw_data FROM events").get() as { content: string; raw_data: string };
    expect(row.content).toContain("Complete document");
    expect(JSON.parse(row.raw_data).docs[0].content).toBe("Complete document");
    await write("Renamed project");
    await importClaudeExport(db, zip, "tester");
    expect(db.query("SELECT count(*) AS n FROM event_versions").get()).toEqual({ n: 1 });
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("inbox project linking is order-independent and preserves old message content, raw data and attachment tags", async () => {
  const { processAutoDetectZip } = await import("../../inbox/zip-handlers");
  const root = await mkdtemp(join(tmpdir(), "claude-order-"));
  const date = "2026-01-01T00:00:00Z";
  let serial = 0;
  const zip = async (name: string, files: Record<string, unknown>) => {
    const { dirname } = await import("node:path");
    const stage = join(root, `stage-${serial++}`); await mkdir(stage);
    for (const [name, value] of Object.entries(files)) { const path = join(stage, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
    const path = join(root, name);
    const proc = Bun.spawn(["zip", "-q", path, ...Object.keys(files)], { cwd: stage });
    expect(await proc.exited).toBe(0); return path;
  };
  const databases: Database[] = [];
  try {
    const oldMessage = { uuid: "old", text: "Original text", sender: "human", created_at: date, attachments: [{ file_name: "notes.txt", extracted_content: "Original attachment", file_type: "text/plain", file_size: 19 }], content: [] };
    const conversation = { uuid: "conversation", name: "Original title", created_at: date, updated_at: date, chat_messages: [oldMessage] };
    const legacy = await zip("legacy.zip", { "conversations.json": [conversation], "memories.json": [{ conversations_memory: "Legacy memory", updated_at: date }] });
    const messages = await zip("conversations-000 (1).zip", { "export/conversations.json": [{ ...conversation, name: "Renamed", chat_messages: [{ ...oldMessage, text: "Changed text", attachments: [] }, { uuid: "new", text: "", sender: "assistant", created_at: date, content: [{ type: "tool_result", structured_content: { documents: [{ path_segments: ["notes", id, "file.md"] }] } }] }] }] });
    const projects = await zip("projects-000 (1).zip", { [`projects/${id}.json`]: { uuid: id, name: "", description: "", prompt_template: "", is_private: true, is_starter_project: false, created_at: date, updated_at: date, creator: { uuid: "account", full_name: null }, docs: [{ uuid: "doc", filename: "", content: "", created_at: date }] } });
    const memories = await zip("memories-000 (1).zip", { "memories/account.json": { account_uuid: "account", conversations_memory: "Legacy memory", project_memories: {}, memory_files: [{ path: `/notes/${id}/file.md`, content: "Memory", updated_at: date }] } });
    const results = [];
    for (const order of [[messages, memories, projects], [projects, memories, messages]]) {
      const db = new Database(":memory:"); databases.push(db); initDb(db);
      await importClaudeExport(db, legacy, "operator");
      const before = db.query("SELECT content, raw_data, timestamp, source_account FROM events WHERE source_id = 'conversation:old'").get();
      for (const path of order) expect((await processAutoDetectZip(db, path, "operator")).detectedType).toBe("claude");
      expect(db.query("SELECT content, raw_data, timestamp, source_account FROM events WHERE source_id = 'conversation:old'").get()).toEqual(before);
      const rows = db.query("SELECT source_id, type, timestamp, title, content, raw_data, tags FROM events ORDER BY source_id").all() as { source_id: string; tags: string | null; title: string }[];
      for (const row of rows.filter((row) => row.source_id.startsWith("conversation:"))) {
        expect(JSON.parse(row.tags ?? "[]")).toContain(`project:${id}`);
        expect(JSON.parse(row.tags ?? "[]")).toContain("project-link:inferred-memory-path");
      }
      expect(JSON.parse(rows.find((row) => row.source_id === "conversation:old")?.tags ?? "[]")).toContain("attachment:has");
      expect(JSON.parse(rows.find((row) => row.source_id.startsWith("memory:file:"))?.tags ?? "[]")).toContain(`project:${id}`);
      expect(rows.find((row) => row.source_id === `project:${id}`)?.title).toBe("Claude Project (00000000)");
      for (const path of order) await importClaudeExport(db, path, "operator");
      expect(db.query("SELECT source_id, type, timestamp, title, content, raw_data, tags FROM events ORDER BY source_id").all()).toEqual(rows);
      results.push(rows);
    }
    expect(results[0]).toEqual(results[1]);
  } finally { for (const db of databases) db.close(); await rm(root, { recursive: true, force: true }); }
});

test("project-only exports refuse overlap with another account despite stray history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-project-account-"));
  const db = new Database(":memory:"); initDb(db);
  try {
    await mkdir(join(dir, "projects"));
    await writeFile(join(dir, `projects/${id}.json`), JSON.stringify({ uuid: id, name: "Project", description: "", prompt_template: "", is_private: true, is_starter_project: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", creator: { uuid: "account", full_name: "Alice" }, docs: [] }));
    const zip = join(dir, "projects-000.zip");
    expect(await Bun.spawn(["zip", "-q", zip, `projects/${id}.json`], { cwd: dir }).exited).toBe(0);
    await importClaudeExport(db, zip, "operator");
    db.prepare("INSERT INTO events (source, source_id, source_account, type, raw_data) VALUES ('claude', 'stray', 'second', 'claude:memory', '{}')").run();
    const { spyOn } = await import("bun:test");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await importClaudeExport(db, zip, "second", { dryRun: true });
      expect(log.mock.calls.flat().join("\n")).toContain("Projects already present under other accounts: 1");
    } finally { log.mockRestore(); }
    await expect(importClaudeExport(db, zip, "second")).rejects.toThrow("--allow-new-account");
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 2 });
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
