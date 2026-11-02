import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { initDb } from "../db/schema";
import { opencodeSyncSource } from "../sync/sources/opencode";
import {
  importOpenCode,
  normalizePartsToBlocks,
  normalizeV2Content,
  type OpenCodePart,
} from "./opencode";
import { writeOpenCodeFixture } from "./opencode.fixture";

function part(overrides: Partial<OpenCodePart>): OpenCodePart {
  return {
    id: "p1",
    sessionID: "s1",
    messageID: "m1",
    type: "text",
    ...overrides,
  };
}

describe("normalizePartsToBlocks", () => {
  it("converts text parts to text blocks", () => {
    const blocks = normalizePartsToBlocks([
      part({ type: "text", text: "hello" }),
    ]);
    expect(blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("skips text parts with no text content", () => {
    const blocks = normalizePartsToBlocks([part({ type: "text" })]);
    expect(blocks).toEqual([]);
  });

  it("emits a tool_use block for tool parts without output", () => {
    const blocks = normalizePartsToBlocks([
      part({
        type: "tool",
        tool: "Bash",
        callID: "call_1",
        state: { status: "running", input: { command: "ls" } },
      }),
    ]);
    expect(blocks).toEqual([
      {
        type: "tool_use",
        name: "Bash",
        id: "call_1",
        input: { command: "ls" },
      },
    ]);
  });

  it("emits tool_use + tool_result linked by id when output is present", () => {
    const blocks = normalizePartsToBlocks([
      part({
        type: "tool",
        tool: "Read",
        callID: "call_42",
        state: {
          status: "success",
          input: { path: "/tmp/foo" },
          output: "line1\nline2",
        },
      }),
    ]);
    expect(blocks).toEqual([
      {
        type: "tool_use",
        name: "Read",
        id: "call_42",
        input: { path: "/tmp/foo" },
      },
      {
        type: "tool_result",
        tool_use_id: "call_42",
        content: "line1\nline2",
      },
    ]);
  });

  it("routes error-status output into the error field", () => {
    const blocks = normalizePartsToBlocks([
      part({
        type: "tool",
        tool: "Bash",
        callID: "call_99",
        state: {
          status: "error",
          input: { command: "nope" },
          output: "command not found",
        },
      }),
    ]);
    expect(blocks[1]).toEqual({
      type: "tool_result",
      tool_use_id: "call_99",
      error: "command not found",
    });
  });

  it("falls back to metadata.output when state.output is missing", () => {
    const blocks = normalizePartsToBlocks([
      part({
        type: "tool",
        tool: "Bash",
        callID: "call_5",
        state: {
          status: "success",
          input: {},
          metadata: { output: "from metadata" },
        },
      }),
    ]);
    expect(blocks[1]).toEqual({
      type: "tool_result",
      tool_use_id: "call_5",
      content: "from metadata",
    });
  });

  it("skips step-start and step-finish parts", () => {
    const blocks = normalizePartsToBlocks([
      part({ type: "step-start" }),
      part({ type: "text", text: "kept" }),
      part({ type: "step-finish", reason: "stop" }),
    ]);
    expect(blocks).toEqual([{ type: "text", text: "kept" }]);
  });

  it("converts reasoning parts to thinking blocks", () => {
    const blocks = normalizePartsToBlocks([
      part({ type: "reasoning", text: "consider options" }),
    ]);
    expect(blocks).toEqual([{ type: "thinking", thinking: "consider options" }]);
  });

  it("uses state.error for failed tools without output", () => {
    const blocks = normalizePartsToBlocks([
      part({
        type: "tool",
        tool: "read",
        callID: "call_7",
        state: { status: "error", input: {}, error: "File not found" },
      }),
    ]);
    expect(blocks[1]).toEqual({
      type: "tool_result",
      tool_use_id: "call_7",
      error: "File not found",
    });
  });

  it("drops tool parts with no tool name", () => {
    const blocks = normalizePartsToBlocks([
      part({ type: "tool", state: { status: "success" } }),
    ]);
    expect(blocks).toEqual([]);
  });
});

interface EventRow {
  source_id: string;
  content: string;
  raw_data: string;
}

describe("importOpenCode raw_data preservation", () => {
  let db: Database;
  let openCodeDir: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);

    openCodeDir = join(tmpdir(), `opencode-fixture-${randomUUID()}`);
    await mkdir(openCodeDir, { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(openCodeDir, { recursive: true, force: true });
  });

  async function writeJson(dir: string, name: string, data: unknown) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.json`), JSON.stringify(data));
  }

  it("preserves the original parts array (including step-finish) in raw_data.source_parts", async () => {
    const projectId = "proj-1";
    const sessionId = "sess-1";
    const messageId = "msg-1";

    await writeJson(join(openCodeDir, "project"), projectId, {
      id: projectId,
      worktree: "/tmp/project",
      time: { created: Date.UTC(2026, 3, 1), updated: Date.UTC(2026, 3, 1) },
    });

    await writeJson(join(openCodeDir, "session", projectId), sessionId, {
      id: sessionId,
      projectID: projectId,
      directory: "/tmp/project",
      title: "fixture",
      time: { created: Date.UTC(2026, 3, 1), updated: Date.UTC(2026, 3, 1) },
    });

    await writeJson(join(openCodeDir, "message", sessionId), messageId, {
      id: messageId,
      sessionID: sessionId,
      role: "assistant",
      time: { created: Date.UTC(2026, 3, 1), completed: Date.UTC(2026, 3, 1) },
      modelID: "claude-sonnet-4-5",
      providerID: "anthropic",
    });

    const originalParts: OpenCodePart[] = [
      {
        id: "part-1",
        sessionID: sessionId,
        messageID: messageId,
        type: "step-start",
      },
      {
        id: "part-2",
        sessionID: sessionId,
        messageID: messageId,
        type: "text",
        text: "hello",
      },
      {
        id: "part-3",
        sessionID: sessionId,
        messageID: messageId,
        type: "tool",
        tool: "Bash",
        callID: "call_1",
        state: {
          status: "success",
          input: { command: "ls" },
          output: "file.txt",
          metadata: { exit: 0, truncated: false },
        },
      },
      {
        id: "part-4",
        sessionID: sessionId,
        messageID: messageId,
        type: "step-finish",
        reason: "stop",
        cost: 0.001,
        tokens: {
          input: 10,
          output: 5,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    ];

    for (const part of originalParts) {
      await writeJson(
        join(openCodeDir, "part", messageId),
        part.id,
        part,
      );
    }

    await importOpenCode(db, openCodeDir, "tester");

    const row = db
      .prepare(
        "SELECT source_id, content, raw_data FROM events WHERE source = 'opencode' LIMIT 1",
      )
      .get() as EventRow | undefined;
    expect(row).toBeDefined();
    const raw = JSON.parse(row!.raw_data);
    // source_parts preserves step-start / step-finish and state.metadata
    // that normalizePartsToBlocks would otherwise drop.
    expect(raw.source_parts).toEqual(originalParts);
    // content stays the standardized ContentBlock[] form.
    expect(raw.content).toEqual([
      { type: "text", text: "hello" },
      {
        type: "tool_use",
        name: "Bash",
        id: "call_1",
        input: { command: "ls" },
      },
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: "file.txt",
      },
    ]);
  });
});

describe("normalizeV2Content", () => {
  it("maps text, reasoning, and completed tools to shared blocks", () => {
    const blocks = normalizeV2Content([
      { type: "reasoning", text: "plan" },
      {
        type: "tool",
        id: "call_1",
        name: "bash",
        state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "a.txt" }] },
      },
      { type: "text", text: "done" },
    ]);
    expect(blocks).toEqual([
      { type: "thinking", thinking: "plan" },
      { type: "tool_use", name: "bash", id: "call_1", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "call_1", content: "a.txt" },
      { type: "text", text: "done" },
    ]);
  });

  it("uses the structured error message for failed tools", () => {
    const blocks = normalizeV2Content([
      {
        type: "tool",
        id: "call_2",
        name: "webfetch",
        state: { status: "error", input: {}, error: { type: "Tool.Error", message: "timed out" } },
      },
    ]);
    expect(blocks[1]).toEqual({ type: "tool_result", tool_use_id: "call_2", error: "timed out" });
  });

  it("emits only tool_use while a tool is running or streaming", () => {
    const blocks = normalizeV2Content([
      { type: "tool", id: "c3", name: "read", state: { status: "running", input: { filePath: "x" }, metadata: {} } },
      { type: "tool", id: "c4", name: "read", state: { status: "streaming", input: "{\"filePa" } },
    ]);
    expect(blocks).toEqual([
      { type: "tool_use", name: "read", id: "c3", input: { filePath: "x" } },
      { type: "tool_use", name: "read", id: "c4", input: "{\"filePa" },
    ]);
  });

  it("keeps file output as the original array", () => {
    const content = [
      { type: "text", text: "see image" },
      { type: "file", uri: "file:///tmp/a.png", mime: "image/png" },
    ];
    const blocks = normalizeV2Content([
      { type: "tool", id: "c5", name: "read", state: { status: "completed", input: {}, content } },
    ]);
    expect(blocks[1]).toEqual({ type: "tool_result", tool_use_id: "c5", content });
  });

  it("preserves unrecognized items as unknown blocks", () => {
    const item = { type: "hologram", text: "?" };
    expect(normalizeV2Content([item])).toEqual([{ type: "unknown", raw: item }]);
  });
});

interface ImportedRow {
  source_id: string;
  type: string;
  timestamp: string;
  end_timestamp: string | null;
  duration_ms: number | null;
  title: string;
  content: string;
  people: string;
  tags: string;
  raw_data: string;
  conversation_id: string;
}

const ALL_SOURCE_IDS = [
  "ses_alpha:msg_a1",
  "ses_alpha:msg_a2",
  "ses_alpha:msg_a3",
  "ses_alpha:msg_a4",
  "ses_alpha:msg_ac1",
  "ses_bravo:msg_b1",
  "ses_bravo:msg_b2",
];

const LEGACY_SOURCE_IDS = ["ses_alpha:msg_a1", "ses_alpha:msg_a2", "ses_alpha:msg_ac1"];

describe("importOpenCode from opencode.db", () => {
  let db: Database;
  let root: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);
    root = join(tmpdir(), `opencode-sqlite-${randomUUID()}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  function rows(): Map<string, ImportedRow> {
    const all = db
      .prepare("SELECT * FROM events WHERE source = 'opencode' ORDER BY source_id")
      .all() as ImportedRow[];
    return new Map(all.map((row) => [row.source_id, row]));
  }

  function row(sourceId: string): ImportedRow {
    const found = rows().get(sourceId);
    if (!found) throw new Error(`missing event ${sourceId}`);
    return found;
  }

  it("imports an upgraded install once across storage, v1, and v2", async () => {
    const dataDir = join(root, "opencode");
    await writeOpenCodeFixture(dataDir);

    const stats = await importOpenCode(db, dataDir, "alice");

    expect([...rows().keys()]).toEqual(ALL_SOURCE_IDS);
    expect(stats.messages).toBe(7);
    expect(stats.sessions).toBe(2);
    // Alpha's three legacy messages exist in every store; storage wins.
    expect(stats.byStore).toEqual({ storage: 3, "sqlite-v1": 0, "sqlite-v2": 4 });
    expect(stats.overlapping).toBe(3);

    const a2 = row("ses_alpha:msg_a2");
    const a2Raw = JSON.parse(a2.raw_data);
    expect(a2.type).toBe("opencode:message:assistant");
    expect(a2.title).toBe("garden: List garden beds");
    expect(a2.content).toBe("The north and south beds need watering.");
    expect(a2.duration_ms).toBe(90_000);
    expect(a2Raw.store).toBe("storage");
    expect(a2Raw.content).toEqual([
      { type: "thinking", thinking: "Check the beds file first." },
      { type: "tool_use", name: "bash", id: "call_ls", input: { command: "ls beds" } },
      { type: "tool_result", tool_use_id: "call_ls", content: "north.txt\nsouth.txt" },
      { type: "tool_use", name: "read", id: "call_read", input: { filePath: "beds/east.txt" } },
      { type: "tool_result", tool_use_id: "call_read", error: "File not found: beds/east.txt" },
      { type: "text", text: "The north and south beds need watering." },
    ]);
    expect(a2Raw.project_path).toBe("/home/alice/projects/garden");
    expect(a2Raw.model).toBe("claude-sonnet-4-5");
    expect(a2Raw.tokens.cache.read).toBe(300);
    expect(JSON.parse(a2.tags)).toEqual([
      "editor:opencode",
      "project:garden",
      "model:claude-sonnet-4-5",
      "provider:anthropic",
      "agent:build",
      "mode:build",
    ]);

    // Subagent messages fold into the top-level session.
    const ac1 = row("ses_alpha:msg_ac1");
    expect(ac1.conversation_id).toBe("ses_alpha");
    expect(ac1.title).toBe("garden: Explore subagent");
    expect(JSON.parse(ac1.raw_data).message_session_id).toBe("ses_alpha_child");

    // Written after the upgrade: only v2 has it, with a multi-part assistant turn.
    const a4 = row("ses_alpha:msg_a4");
    const a4Raw = JSON.parse(a4.raw_data);
    expect(a4Raw.store).toBe("sqlite-v2");
    expect(a4.content).toBe("Creating the note.\n\nDone: the east bed note is in beds/east.txt.");
    expect(a4Raw.content).toEqual([
      { type: "text", text: "Creating the note." },
      {
        type: "tool_use",
        name: "write",
        id: "call_write",
        input: { filePath: "beds/east.txt", content: "plant tomatoes" },
      },
      { type: "tool_result", tool_use_id: "call_write", content: "Wrote beds/east.txt" },
      { type: "text", text: "Done: the east bed note is in beds/east.txt." },
    ]);
    expect(a4Raw.tool_usage).toEqual({ write: 1 });
    expect(a4Raw.cwd).toBe("/home/alice/projects/garden");
    expect(a4Raw.source_message.model.id).toBe("claude-sonnet-4-5");
    expect(a4.end_timestamp).toBe(new Date(Date.UTC(2026, 0, 10, 9, 11)).toISOString());

    expect(row("ses_alpha:msg_a3").type).toBe("opencode:message:user");

    // v2-only session in OpenCode's "global" project uses the session directory.
    const b2 = row("ses_bravo:msg_b2");
    const b2Raw = JSON.parse(b2.raw_data);
    expect(b2.title).toBe("scratch: Weather notes");
    expect(b2Raw.project_path).toBe("/home/bob/scratch");
    expect(b2Raw.provider).toBe("openai");
    expect(JSON.parse(b2.people)).toEqual(["opencode:gpt-5", "opencode:alice"]);
    expect(b2Raw.content.filter((b: { type: string }) => b.type === "tool_result")).toEqual([
      { type: "tool_result", tool_use_id: "call_fetch", error: "Request timed out" },
    ]);
  });

  it("is idempotent across runs", async () => {
    const dataDir = join(root, "opencode");
    await writeOpenCodeFixture(dataDir);

    await importOpenCode(db, dataDir, "alice");
    const again = await importOpenCode(db, dataDir, "alice");

    expect(again.messages).toBe(0);
    expect(again.skipped).toBe(7);
    expect(rows().size).toBe(7);
  });

  it("lines up with events already imported from legacy storage", async () => {
    const dataDir = join(root, "opencode");
    await writeOpenCodeFixture(dataDir);

    const legacy = await importOpenCode(db, join(dataDir, "storage"), "alice");
    expect(legacy.messages).toBe(3);
    expect([...rows().keys()]).toEqual(LEGACY_SOURCE_IDS);

    const full = await importOpenCode(db, dataDir, "alice");
    expect(full.messages).toBe(4);
    expect([...rows().keys()]).toEqual(ALL_SOURCE_IDS);
  });

  it("lines up v1 and v2 table generations", async () => {
    const v1Dir = join(root, "v1");
    const v2Dir = join(root, "v2");
    await writeOpenCodeFixture(v1Dir, { storage: false, v1: true, v2: false });
    await writeOpenCodeFixture(v2Dir, { storage: false, v1: false, v2: true });

    const fromV1 = await importOpenCode(db, join(v1Dir, "opencode.db"), "alice");
    expect(fromV1.byStore["sqlite-v1"]).toBe(3);
    expect([...rows().keys()]).toEqual(LEGACY_SOURCE_IDS);
    expect(JSON.parse(row("ses_alpha:msg_a2").raw_data).source_parts).toHaveLength(6);

    const fromV2 = await importOpenCode(db, v2Dir, "alice");
    expect(fromV2.messages).toBe(4);
    expect(fromV2.skipped).toBe(3);
    expect([...rows().keys()]).toEqual(ALL_SOURCE_IDS);
  });

  it("reports counts without writing in dry-run mode", async () => {
    const dataDir = join(root, "opencode");
    await writeOpenCodeFixture(dataDir);

    const stats = await importOpenCode(db, dataDir, "alice", { dryRun: true });

    expect(stats.messages).toBe(7);
    expect(rows().size).toBe(0);
  });

  it("reads without modifying opencode.db while OpenCode holds a write transaction", async () => {
    const dataDir = join(root, "opencode");
    await writeOpenCodeFixture(dataDir, { storage: false });
    const dbPath = join(dataDir, "opencode.db");
    const before = await readFile(dbPath);

    const writer = new Database(dbPath);
    writer.run("BEGIN IMMEDIATE");
    writer.run(
      `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
       VALUES ('msg_b9', 'ses_bravo', 'user', 99, 0, 0, '{"text":"uncommitted"}')`
    );
    try {
      const stats = await importOpenCode(db, dataDir, "alice");
      expect(stats.messages).toBe(7);
      expect(rows().has("ses_bravo:msg_b9")).toBe(false);
    } finally {
      writer.run("ROLLBACK");
      writer.close();
    }

    expect(Buffer.compare(await readFile(dbPath), before)).toBe(0);
  });

  it("completes an assistant turn first imported mid-stream", async () => {
    const dataDir = join(root, "opencode");
    await writeOpenCodeFixture(dataDir, { storage: false });
    const opencodeDb = new Database(join(dataDir, "opencode.db"));
    const finished = (
      opencodeDb.prepare("SELECT data FROM session_message WHERE id = 'msg_a4'").get() as { data: string }
    ).data;
    const streaming = JSON.parse(finished);
    streaming.content = streaming.content.slice(0, 1);
    delete streaming.time.completed;
    const setData = opencodeDb.prepare("UPDATE session_message SET data = ? WHERE id = 'msg_a4'");
    setData.run(JSON.stringify(streaming));

    await importOpenCode(db, dataDir, "alice");
    expect(row("ses_alpha:msg_a4").content).toBe("Creating the note.");
    expect(row("ses_alpha:msg_a4").end_timestamp).toBeNull();

    setData.run(finished);
    opencodeDb.close();
    const second = await importOpenCode(db, dataDir, "alice");
    expect(second.updated).toBe(1);
    const a4 = row("ses_alpha:msg_a4");
    expect(a4.content).toBe("Creating the note.\n\nDone: the east bed note is in beds/east.txt.");
    expect(a4.end_timestamp).toBe(new Date(Date.UTC(2026, 0, 10, 9, 11)).toISOString());
    expect(a4.duration_ms).toBe(30_000);

    const third = await importOpenCode(db, dataDir, "alice");
    expect(third.updated).toBe(0);
  });

  it("closes a v1 turn whose only later change is its completion time", async () => {
    const dataDir = join(root, "opencode");
    await writeOpenCodeFixture(dataDir, { storage: false, v2: false });
    const opencodeDb = new Database(join(dataDir, "opencode.db"));
    const completed = (
      opencodeDb.prepare("SELECT data FROM message WHERE id = 'msg_a2'").get() as { data: string }
    ).data;
    const pending = JSON.parse(completed);
    delete pending.time.completed;
    const setData = opencodeDb.prepare("UPDATE message SET data = ? WHERE id = 'msg_a2'");
    setData.run(JSON.stringify(pending));

    await importOpenCode(db, dataDir, "alice");
    expect(row("ses_alpha:msg_a2").end_timestamp).toBeNull();

    setData.run(completed);
    opencodeDb.close();
    const second = await importOpenCode(db, dataDir, "alice");
    expect(second.updated).toBe(1);
    expect(row("ses_alpha:msg_a2").end_timestamp).toBe(new Date(Date.UTC(2026, 0, 10, 9, 3)).toISOString());
    expect(row("ses_alpha:msg_a2").duration_ms).toBe(90_000);

    const third = await importOpenCode(db, dataDir, "alice");
    expect(third.updated).toBe(0);
  });

  it("previews refreshes in dry-run mode", async () => {
    const dataDir = join(root, "opencode");
    await writeOpenCodeFixture(dataDir);
    await importOpenCode(db, dataDir, "alice");

    const preview = await importOpenCode(db, dataDir, "alice", { dryRun: true, refreshRawData: true });
    expect(preview).toMatchObject({ messages: 0, updated: 7, skipped: 0 });
  });

  it("reads v1 message/part left beside v2 without a v1 session table", async () => {
    const dataDir = join(root, "opencode");
    await writeOpenCodeFixture(dataDir, { storage: false, v1SessionTable: false });

    const stats = await importOpenCode(db, dataDir, "alice");

    expect([...rows().keys()]).toEqual(ALL_SOURCE_IDS);
    expect(stats.byStore).toEqual({ storage: 0, "sqlite-v1": 3, "sqlite-v2": 4 });
  });

  it("prefers a later store's copy when the legacy copy has no content", async () => {
    const dataDir = join(root, "opencode");
    await writeOpenCodeFixture(dataDir);
    await rm(join(dataDir, "storage", "part", "msg_a2"), { recursive: true });

    await importOpenCode(db, dataDir, "alice");

    const a2Raw = JSON.parse(row("ses_alpha:msg_a2").raw_data);
    expect(a2Raw.store).toBe("sqlite-v1");
    expect(a2Raw.content).toHaveLength(6);
  });

  it("fails on a v2 assistant message without a content array", async () => {
    const dataDir = join(root, "opencode");
    await writeOpenCodeFixture(dataDir, { storage: false });
    const writer = new Database(join(dataDir, "opencode.db"));
    writer.run(`UPDATE session_message SET data = '{"agent":"build"}' WHERE id = 'msg_b2'`);
    writer.close();

    await expect(importOpenCode(db, dataDir, "alice")).rejects.toThrow(
      "msg_b2 (assistant) has no content array"
    );
    expect(rows().size).toBe(0);
  });

  it("fails on an unrecognized v2 message type", async () => {
    const dataDir = join(root, "opencode");
    await writeOpenCodeFixture(dataDir, { storage: false });
    const writer = new Database(join(dataDir, "opencode.db"));
    writer.run(
      `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
       VALUES ('msg_x', 'ses_bravo', 'hologram', 50, 0, 0, '{}')`
    );
    writer.close();

    await expect(importOpenCode(db, dataDir, "alice")).rejects.toThrow(
      'unrecognized type "hologram"'
    );
    expect(rows().size).toBe(0);
  });

  it("fails on databases whose layout it does not recognize", async () => {
    const empty = join(root, "empty.db");
    new Database(empty, { create: true }).close();
    await expect(importOpenCode(db, empty, "alice")).rejects.toThrow("no session tables");

    const preSplit = join(root, "pre-split.db");
    const preSplitDb = new Database(preSplit, { create: true });
    preSplitDb.run("CREATE TABLE project (id text, worktree text)");
    preSplitDb.run("CREATE TABLE session (id text)");
    preSplitDb.run("CREATE TABLE session_message (id text)");
    preSplitDb.close();
    await expect(importOpenCode(db, preSplit, "alice")).rejects.toThrow(
      "session_message without session_v2"
    );

    const dataDir = join(root, "opencode");
    await writeOpenCodeFixture(dataDir, { storage: false });
    const writer = new Database(join(dataDir, "opencode.db"));
    writer.run("ALTER TABLE session_message DROP COLUMN data");
    writer.close();
    await expect(importOpenCode(db, dataDir, "alice")).rejects.toThrow(
      "table session_message lacks data"
    );
  });

  it("rejects paths without OpenCode data", async () => {
    await expect(importOpenCode(db, root, "alice")).rejects.toThrow("No OpenCode data");
    await expect(importOpenCode(db, join(root, "missing"), "alice")).rejects.toThrow(
      "OpenCode path not found"
    );
  });

  it("validates the configured path in the sync source", async () => {
    const dataDir = join(root, "opencode");
    await writeOpenCodeFixture(dataDir, { storage: false, v1: false });

    expect(await opencodeSyncSource.canSync({ path: dataDir, account: "alice" })).toBeNull();
    expect(await opencodeSyncSource.canSync({ path: root, account: "alice" })).toContain(
      "No OpenCode data"
    );
  });
});
