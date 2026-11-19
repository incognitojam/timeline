import { test, expect } from "bun:test";
import { Database } from "../../db/sqlite";
import { initDb } from "../../db/schema";
import { importClaudeExport } from "./parser";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("category memory imports reuse legacy identity and version edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-memories-"));
  const db = new Database(":memory:");
  initDb(db);
  try {
    db.prepare("INSERT INTO events (source, source_id, source_account, type, timestamp, content, raw_data) VALUES ('claude', 'memory:0', 'tester', 'claude:memory', '2026-04-17T00:00:00Z', 'Old memory', ?)").run('{"conversations_memory":"Old memory"}');
    await mkdir(join(dir, "memories"));
    const zip = join(dir, "memories-000.zip");
    const write = async (content: string) => {
      await writeFile(join(dir, "memories/account.json"), JSON.stringify({ account_uuid: "account", conversations_memory: content, project_memories: {}, memory_files: [{ path: "/notes/a.md", content: "A note", updated_at: "2026-05-01T00:00:00Z" }] }));
      const proc = Bun.spawn(["zip", "-q", zip, "memories/account.json"], { cwd: dir });
      expect(await proc.exited).toBe(0);
    };
    await write("New memory");
    expect(await importClaudeExport(db, zip, "tester", { dryRun: true })).toBe(1);
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 1 });
    expect(await importClaudeExport(db, zip, "tester")).toBe(1);
    expect(await importClaudeExport(db, zip, "tester")).toBe(0);
    expect(db.query("SELECT count(*) AS n FROM event_versions").get()).toEqual({ n: 1 });
    expect(db.query("SELECT timestamp FROM events WHERE source_id = 'memory:0'").get()).toEqual({ timestamp: "2026-04-17T00:00:00Z" });
    await write("Another edit");
    await importClaudeExport(db, zip, "tester");
    expect(db.query("SELECT count(*) AS n FROM event_versions").get()).toEqual({ n: 2 });
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 2 });
    await writeFile(join(dir, "memories/account.json"), JSON.stringify({ account_uuid: "account", conversations_memory: "", project_memories: {}, memory_files: [{ path: "/notes/a.md", content: "", updated_at: "2026-05-01T00:00:00Z" }] }));
    const empty = Bun.spawn(["zip", "-q", zip, "memories/account.json"], { cwd: dir });
    expect(await empty.exited).toBe(0);
    expect(await importClaudeExport(db, zip, "tester")).toBe(0);
    expect(db.query("SELECT content FROM events WHERE source_id = 'memory:0'").get()).toEqual({ content: "Another edit" });
    expect(db.query("SELECT content FROM events WHERE source_id = 'memory:file:/notes/a.md'").get()).toEqual({ content: "A note" });
    expect(db.query("SELECT count(*) AS n FROM event_versions").get()).toEqual({ n: 2 });
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("memory-only exports refuse overlap with another account despite stray history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-memory-account-"));
  const db = new Database(":memory:"); initDb(db);
  try {
    await mkdir(join(dir, "memories"));
    await writeFile(join(dir, "memories/account.json"), JSON.stringify({ account_uuid: "account", conversations_memory: "Memory", project_memories: { "00000000-0000-4000-8000-000000000001": "Project memory" }, memory_files: [{ path: "/notes.md", content: "Note", updated_at: "2026-01-01T00:00:00Z" }] }));
    const zip = join(dir, "memories-000.zip");
    expect(await Bun.spawn(["zip", "-q", zip, "memories/account.json"], { cwd: dir }).exited).toBe(0);
    await importClaudeExport(db, zip, "operator");
    db.prepare("INSERT INTO events (source, source_id, source_account, type, raw_data) VALUES ('claude', 'stray', 'second', 'claude:memory', '{}')").run();
    const { spyOn } = await import("bun:test");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await importClaudeExport(db, zip, "second", { dryRun: true });
      expect(log.mock.calls.flat().join("\n")).toContain("Memories already present under other accounts: 3");
    } finally { log.mockRestore(); }
    await expect(importClaudeExport(db, zip, "second")).rejects.toThrow("--allow-new-account");
    expect(db.query("SELECT count(*) AS n FROM events").get()).toEqual({ n: 4 });
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
