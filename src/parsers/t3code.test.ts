import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initDb } from "../db/schema";
import { computeHash } from "../media/storage";
import { activityToBlocks, importT3Code } from "./t3code";

interface EventRow {
  source_id: string;
  type: string;
  timestamp: string;
  title: string;
  content: string;
  people: string;
  tags: string;
  raw_data: string;
  conversation_id: string;
}

interface AttachmentRow {
  source: string;
  source_id: string;
  content_hash: string;
  filename: string;
  mime_type: string;
  file_size: number;
  storage_path: string;
  status: string;
}

const T3_IMAGE_BYTES = Buffer.from("fixture t3 image bytes");

function createT3Fixture(path: string): Database {
  const t3Db = new Database(path);
  t3Db.run(`
    CREATE TABLE projection_projects (
      project_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL
    );
    CREATE TABLE projection_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      model_selection_json TEXT,
      archived_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE projection_thread_sessions (
      thread_id TEXT PRIMARY KEY,
      provider_name TEXT
    );
    CREATE TABLE projection_thread_messages (
      message_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      is_streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      attachments_json TEXT
    );
    CREATE TABLE projection_thread_activities (
      activity_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      tone TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sequence INTEGER
    );
  `);
  return t3Db;
}

// claudeAgent-shaped payloads carry Anthropic tool_use/tool_result data.
const claudeReadPayload = JSON.stringify({
  itemType: "dynamic_tool_call",
  detail: 'Read: {"file_path":"/tmp/a.ts"}',
  data: {
    toolName: "Read",
    input: { file_path: "/tmp/a.ts" },
    result: {
      tool_use_id: "toolu_1",
      type: "tool_result",
      content: "file contents",
      is_error: false,
    },
  },
});

const claudeBashErrorPayload = JSON.stringify({
  itemType: "command_execution",
  data: {
    toolName: "Bash",
    input: { command: "false" },
    result: {
      tool_use_id: "toolu_2",
      type: "tool_result",
      content: "boom",
      is_error: true,
    },
  },
});

// codex-shaped payloads carry an `item` keyed by itemType.
const codexCommandPayload = JSON.stringify({
  itemType: "command_execution",
  data: {
    completedAtMs: 1,
    item: {
      aggregatedOutput: "ok\n",
      command: "/bin/zsh -lc 'git status'",
      commandActions: [{ command: "git status", type: "unknown" }],
      cwd: "/tmp",
      durationMs: 5,
      exitCode: 0,
      id: "call_1",
      status: "completed",
      type: "commandExecution",
    },
  },
});

const codexFileChangePayload = JSON.stringify({
  itemType: "file_change",
  data: {
    item: {
      changes: [
        { diff: "+new line\n", kind: { type: "add" }, path: "/tmp/new.ts" },
        { diff: "-a\n+b\n", kind: { type: "update" }, path: "/tmp/old.ts" },
      ],
      id: "call_2",
      status: "completed",
      type: "fileChange",
    },
  },
});

describe("importT3Code", () => {
  let db: Database;
  let t3Root: string;
  let t3DbPath: string;
  let attachmentsDir: string;
  let mediaDir: string;
  let priorMediaPath: string | undefined;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);
    t3Root = join(tmpdir(), `t3code-fixture-${randomUUID()}`);
    t3DbPath = join(t3Root, "state.sqlite");
    attachmentsDir = join(t3Root, "attachments");
    mediaDir = join(tmpdir(), `t3code-media-${randomUUID()}`);
    await mkdir(attachmentsDir, { recursive: true });
    await mkdir(mediaDir, { recursive: true });
    await writeFile(join(attachmentsDir, "att-1.png"), T3_IMAGE_BYTES);

    priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
    process.env.TIMELINE_MEDIA_PATH = mediaDir;

    const t3Db = createT3Fixture(t3DbPath);
    t3Db.run(
      `INSERT INTO projection_projects VALUES ('proj-1', 'my-project', '/tmp/my-project')`
    );
    t3Db.run(
      `INSERT INTO projection_threads VALUES
        ('thread-1', 'proj-1', 'Fix the widget', 'main', NULL,
         '{"instanceId":"claudeAgent","model":"claude-sonnet-5","options":[{"id":"effort","value":"high"}]}',
         NULL, NULL),
        ('thread-2', 'proj-1', 'Deleted thread', 'alice/branch', '/tmp/wt',
         '{"instanceId":"codex","model":"gpt-5.5"}',
         '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z')`
    );
    t3Db.run(
      `INSERT INTO projection_thread_sessions VALUES
        ('thread-1', 'claudeAgent'), ('thread-2', 'codex')`
    );
    t3Db.run(
      `INSERT INTO projection_thread_messages VALUES
        ('msg-1', 'thread-1', 'turn-1', 'user', 'Please fix the widget', 0,
         '2026-06-10T10:00:00.000Z',
         '[{"type":"image","id":"att-1","name":"shot.png","mimeType":"image/png","sizeBytes":${T3_IMAGE_BYTES.length}}]'),
        ('msg-2', 'thread-1', 'turn-1', 'assistant', 'Fixed it', 0,
         '2026-06-10T10:01:00.000Z', NULL),
        ('msg-3', 'thread-1', 'turn-2', 'assistant', 'Still writing...', 1,
         '2026-06-10T10:02:00.000Z', NULL),
        ('msg-4', 'thread-2', NULL, 'user', 'Message in deleted thread', 0,
         '2026-06-11T09:00:00.000Z', NULL),
        ('msg-5', 'thread-2', NULL, 'assistant', '   ', 0,
         '2026-06-11T09:01:00.000Z', NULL)`
    );
    const insertActivity = t3Db.prepare(
      `INSERT INTO projection_thread_activities VALUES (?, ?, ?, 'tool', ?, ?, ?, ?, ?)`
    );
    insertActivity.run(
      "act-1", "thread-1", "turn-1", "tool.completed", "Tool call",
      claudeReadPayload, "2026-06-10T10:00:30.000Z", 1
    );
    insertActivity.run(
      "act-2", "thread-1", "turn-1", "tool.completed", "Command run",
      claudeBashErrorPayload, "2026-06-10T10:01:30.000Z", 2
    );
    // In-flight tool call: must not import until a tool.completed row exists.
    insertActivity.run(
      "act-3", "thread-1", "turn-2", "tool.started", "Tool call",
      claudeReadPayload, "2026-06-10T10:02:00.000Z", 3
    );
    insertActivity.run(
      "act-4", "thread-2", null, "tool.completed", "Command run",
      codexCommandPayload, "2026-06-11T09:00:30.000Z", 1
    );
    insertActivity.run(
      "act-5", "thread-2", null, "tool.completed", "File change",
      codexFileChangePayload, "2026-06-11T09:00:45.000Z", 2
    );
    // Unrecognized payload with no data: produces no blocks, counted skipped.
    insertActivity.run(
      "act-6", "thread-2", null, "tool.completed", "Mystery",
      '{"itemType":"mystery","data":{}}', "2026-06-11T09:00:50.000Z", 3
    );
    t3Db.close();
  });

  afterEach(async () => {
    db.close();
    if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
    else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
    await rm(t3Root, { recursive: true, force: true });
    await rm(mediaDir, { recursive: true, force: true });
  });

  function getEvents(): EventRow[] {
    return db
      .prepare("SELECT * FROM events WHERE source = 't3code' ORDER BY timestamp")
      .all() as EventRow[];
  }

  function getEvent(sourceId: string): EventRow {
    const event = getEvents().find((e) => e.source_id === sourceId);
    if (!event) throw new Error(`event ${sourceId} not imported`);
    return event;
  }

  function getAttachments(sourceId: string): AttachmentRow[] {
    return db
      .prepare(
        `SELECT a.source, a.source_id, a.content_hash, a.filename, a.mime_type,
                a.file_size, a.storage_path, a.status
         FROM attachments a
         JOIN events e ON e.id = a.event_id
         WHERE e.source = 't3code' AND e.source_id = ?
         ORDER BY a.id`
      )
      .all(sourceId) as AttachmentRow[];
  }

  it("imports messages and tool calls, skipping streaming/empty/blockless rows", async () => {
    const stats = await importT3Code(db, t3DbPath, "alice");

    expect(stats.messages).toBe(3);
    expect(stats.toolCalls).toBe(4);
    expect(stats.skipped).toBe(2); // blank assistant message + blockless activity
    expect(stats.threads).toEqual(new Set(["thread-1", "thread-2"]));

    // Tool calls interleave with messages chronologically.
    const events = getEvents();
    expect(events.map((e) => e.source_id)).toEqual([
      "thread-1:msg-1",
      "thread-1:act-1",
      "thread-1:msg-2",
      "thread-1:act-2",
      "thread-2:msg-4",
      "thread-2:act-4",
      "thread-2:act-5",
    ]);
  });

  it("maps roles, title, conversation and tags", async () => {
    await importT3Code(db, t3DbPath, "alice");
    const userMsg = getEvent("thread-1:msg-1");
    const assistantMsg = getEvent("thread-1:msg-2");
    const deletedThreadMsg = getEvent("thread-2:msg-4");

    expect(userMsg.type).toBe("t3code:message:user");
    expect(userMsg.title).toBe("my-project: Fix the widget");
    expect(userMsg.content).toBe("Please fix the widget");
    expect(userMsg.conversation_id).toBe("thread-1");
    expect(JSON.parse(userMsg.tags)).toEqual([
      "editor:t3code",
      "project:my-project",
      "model:claude-sonnet-5",
      "provider:claudeAgent",
      "branch:main",
    ]);
    expect(JSON.parse(userMsg.people)).toEqual(["t3code:alice"]);

    expect(assistantMsg.type).toBe("t3code:message:assistant");
    expect(JSON.parse(assistantMsg.people)).toEqual([
      "t3code:claude-sonnet-5",
      "t3code:alice",
    ]);

    expect(JSON.parse(deletedThreadMsg.tags)).toContain("provider:codex");
  });

  it("preserves thread metadata and attachments in raw_data", async () => {
    await importT3Code(db, t3DbPath, "alice");
    const userMsg = getEvent("thread-1:msg-1");
    const deletedThreadMsg = getEvent("thread-2:msg-4");

    const raw = JSON.parse(userMsg.raw_data);
    expect(raw.thread_id).toBe("thread-1");
    expect(raw.turn_id).toBe("turn-1");
    expect(raw.model).toBe("claude-sonnet-5");
    expect(raw.model_options).toEqual([{ id: "effort", value: "high" }]);
    expect(raw.workspace_root).toBe("/tmp/my-project");
    expect(raw.attachments).toEqual([
      {
        type: "image",
        id: "att-1",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: T3_IMAGE_BYTES.length,
      },
    ]);
    expect(JSON.stringify(raw.attachments)).toBe(
      `[{"type":"image","id":"att-1","name":"shot.png","mimeType":"image/png","sizeBytes":${T3_IMAGE_BYTES.length}}]`
    );

    const deletedRaw = JSON.parse(deletedThreadMsg.raw_data);
    expect(deletedRaw.thread_deleted).toBe(true);
    expect(deletedRaw.thread_archived).toBe(true);
    expect(deletedRaw.worktree_path).toBe("/tmp/wt");
  });

  it("is idempotent across runs", async () => {
    const first = await importT3Code(db, t3DbPath, "alice");
    const second = await importT3Code(db, t3DbPath, "alice");

    expect(first.messages).toBe(3);
    expect(first.toolCalls).toBe(4);
    expect(second.messages).toBe(0);
    expect(second.toolCalls).toBe(0);
    expect(second.skipped).toBe(9); // 7 duplicates + 1 blank + 1 blockless
    expect(getEvents().length).toBe(7);
    expect(getAttachments("thread-1:msg-1")).toHaveLength(1);
  });

  it("does not re-read image files for skipped duplicate events", async () => {
    await importT3Code(db, t3DbPath, "alice");
    await rm(join(attachmentsDir, "att-1.png"), { force: true });

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      const second = await importT3Code(db, t3DbPath, "alice");
      expect(second.messages).toBe(0);
      expect(second.toolCalls).toBe(0);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toEqual([]);
    expect(getAttachments("thread-1:msg-1")).toHaveLength(1);
  });

  it("stores image attachment rows with native T3 attachment ids", async () => {
    await importT3Code(db, t3DbPath, "alice");

    expect(getAttachments("thread-1:msg-1")).toEqual([
      {
        source: "t3code",
        source_id: "att-1",
        content_hash: computeHash(T3_IMAGE_BYTES),
        filename: "shot.png",
        mime_type: "image/png",
        file_size: T3_IMAGE_BYTES.length,
        storage_path: join(
          "t3code",
          "alice/thread-1/msg-1/attachment-att-1.png"
        ),
        status: "stored",
      },
    ]);
  });

  it("logs and skips missing image files without blocking later messages", async () => {
    const laterBytes = Buffer.from("later valid t3 image bytes");
    await writeFile(join(attachmentsDir, "att-later.png"), laterBytes);
    const t3Db = new Database(t3DbPath);
    t3Db.run(
      `INSERT INTO projection_thread_messages VALUES
        ('msg-missing', 'thread-1', 'turn-3', 'user', 'Missing image', 0,
         '2026-06-10T10:03:00.000Z',
         '[{"type":"image","id":"att-missing","name":"missing.png","mimeType":"image/png","sizeBytes":12}]'),
        ('msg-later', 'thread-1', 'turn-4', 'user', 'Later image', 0,
         '2026-06-10T10:04:00.000Z',
         '[{"type":"image","id":"att-later","name":"later.png","mimeType":"image/png","sizeBytes":${laterBytes.length}}]')`
    );
    t3Db.close();

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      await importT3Code(db, t3DbPath, "alice");
    } finally {
      console.warn = originalWarn;
    }

    expect(getEvent("thread-1:msg-missing").content).toBe("Missing image");
    expect(getEvent("thread-1:msg-later").content).toBe("Later image");
    expect(getAttachments("thread-1:msg-missing")).toHaveLength(0);
    expect(getAttachments("thread-1:msg-later")).toEqual([
      {
        source: "t3code",
        source_id: "att-later",
        content_hash: computeHash(laterBytes),
        filename: "later.png",
        mime_type: "image/png",
        file_size: laterBytes.length,
        storage_path: join(
          "t3code",
          "alice/thread-1/msg-later/attachment-att-later.png"
        ),
        status: "stored",
      },
    ]);
    expect(warnings.some((w) => w.includes("thread-1:msg-missing"))).toBe(true);
    expect(warnings.some((w) => w.includes("att-missing"))).toBe(true);
  });

  it("logs and skips media storage failures without rolling back the import", async () => {
    const blockedMediaPath = join(t3Root, "not-a-directory");
    await writeFile(blockedMediaPath, "blocking file");
    process.env.TIMELINE_MEDIA_PATH = blockedMediaPath;

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      const stats = await importT3Code(db, t3DbPath, "alice");
      expect(stats.messages).toBe(3);
      expect(stats.toolCalls).toBe(4);
    } finally {
      console.warn = originalWarn;
    }

    expect(getEvents()).toHaveLength(7);
    expect(getAttachments("thread-1:msg-1")).toHaveLength(0);
    expect(warnings.some((w) => w.includes("thread-1:msg-1"))).toBe(true);
    expect(warnings.some((w) => w.includes("att-1"))).toBe(true);
    expect(warnings.some((w) => w.includes("cannot store media"))).toBe(true);
  });

  it("stores image files with missing or uppercase name extensions", async () => {
    const noExtBytes = Buffer.from("no extension t3 image bytes");
    const upperBytes = Buffer.from("uppercase extension t3 image bytes");
    await writeFile(join(attachmentsDir, "att-no-ext.png"), noExtBytes);
    await writeFile(join(attachmentsDir, "att-upper.PNG"), upperBytes);

    const t3Db = new Database(t3DbPath);
    t3Db.run(
      `INSERT INTO projection_thread_messages VALUES
        ('msg-no-ext', 'thread-1', 'turn-3', 'user', 'No extension image', 0,
         '2026-06-10T10:03:00.000Z',
         '[{"type":"image","id":"att-no-ext","name":"Screenshot","mimeType":"image/png","sizeBytes":${noExtBytes.length}}]'),
        ('msg-upper', 'thread-1', 'turn-4', 'user', 'Uppercase extension image', 0,
         '2026-06-10T10:04:00.000Z',
         '[{"type":"image","id":"att-upper","name":"Upper.PNG","mimeType":"image/png","sizeBytes":${upperBytes.length}}]')`
    );
    t3Db.close();

    await importT3Code(db, t3DbPath, "alice");

    expect(getAttachments("thread-1:msg-no-ext")).toEqual([
      {
        source: "t3code",
        source_id: "att-no-ext",
        content_hash: computeHash(noExtBytes),
        filename: "Screenshot",
        mime_type: "image/png",
        file_size: noExtBytes.length,
        storage_path: join(
          "t3code",
          "alice/thread-1/msg-no-ext/attachment-att-no-ext.png"
        ),
        status: "stored",
      },
    ]);
    expect(getAttachments("thread-1:msg-upper")).toEqual([
      {
        source: "t3code",
        source_id: "att-upper",
        content_hash: computeHash(upperBytes),
        filename: "Upper.PNG",
        mime_type: "image/png",
        file_size: upperBytes.length,
        storage_path: join(
          "t3code",
          "alice/thread-1/msg-upper/attachment-att-upper.png"
        ),
        status: "stored",
      },
    ]);
  });

  it("refreshes existing rows when refreshRawData is set", async () => {
    await importT3Code(db, t3DbPath, "alice");

    const t3Db = new Database(t3DbPath);
    t3Db.run("UPDATE projection_thread_messages SET text = 'Edited' WHERE message_id = 'msg-2'");
    t3Db.close();

    const stats = await importT3Code(db, t3DbPath, "alice", {
      refreshRawData: true,
    });
    expect(stats.refreshed).toBe(7);

    const edited = getEvent("thread-1:msg-2");
    expect(edited.content).toBe("Edited");
  });

  it("imports claudeAgent tool calls as tool_use/tool_result blocks", async () => {
    await importT3Code(db, t3DbPath, "alice");
    const event = getEvent("thread-1:act-1");

    expect(event.type).toBe("t3code:message:assistant");
    expect(event.content).toBe(""); // tool noise stays out of FTS
    expect(event.conversation_id).toBe("thread-1");
    expect(JSON.parse(event.people)).toEqual(["t3code:claude-sonnet-5", "t3code:alice"]);

    const raw = JSON.parse(event.raw_data);
    expect(raw.activity_id).toBe("act-1");
    expect(raw.content).toEqual([
      {
        type: "tool_use",
        name: "Read",
        id: "toolu_1",
        input: { file_path: "/tmp/a.ts" },
      },
      { type: "tool_result", tool_use_id: "toolu_1", content: "file contents" },
    ]);
    expect(raw.activity).toEqual(JSON.parse(claudeReadPayload));
  });

  it("maps failed claudeAgent results to the error field", async () => {
    await importT3Code(db, t3DbPath, "alice");
    const raw = JSON.parse(getEvent("thread-1:act-2").raw_data);

    expect(raw.content[1]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_2",
      error: "boom",
    });
  });

  it("normalizes codex command executions and file changes", async () => {
    await importT3Code(db, t3DbPath, "alice");

    const command = JSON.parse(getEvent("thread-2:act-4").raw_data);
    expect(command.content).toEqual([
      {
        type: "tool_use",
        name: "Bash",
        id: "call_1",
        input: { command: "git status", cwd: "/tmp" },
      },
      { type: "tool_result", tool_use_id: "call_1", content: "ok\n" },
    ]);

    const fileChange = JSON.parse(getEvent("thread-2:act-5").raw_data);
    expect(fileChange.content).toEqual([
      {
        type: "tool_use",
        name: "Write",
        id: "call_2:0",
        input: { file_path: "/tmp/new.ts" },
      },
      { type: "tool_result", tool_use_id: "call_2:0", content: "+new line\n" },
      {
        type: "tool_use",
        name: "Edit",
        id: "call_2:1",
        input: { file_path: "/tmp/old.ts" },
      },
      { type: "tool_result", tool_use_id: "call_2:1", content: "-a\n+b\n" },
    ]);
  });

  it("upserts user and assistant identities", async () => {
    const stats = await importT3Code(db, t3DbPath, "alice");
    expect(stats.identitiesUpserted).toBe(3); // alice + 2 models

    const identity = db
      .prepare(
        "SELECT display_name FROM identities WHERE platform = 't3code' AND platform_id = 'claude-sonnet-5'"
      )
      .get() as { display_name: string } | null;
    expect(identity?.display_name).toBe("Claude Sonnet 5");
  });
});

describe("activityToBlocks", () => {
  it("marks failed codex commands with the error field", () => {
    const blocks = activityToBlocks(
      {
        itemType: "command_execution",
        data: {
          item: { id: "call_9", command: "false", aggregatedOutput: "no such file", exitCode: 1 },
        },
      },
      "act-x"
    );
    expect(blocks[1]).toEqual({
      type: "tool_result",
      tool_use_id: "call_9",
      error: "no such file",
    });
  });

  it("maps codex web searches to a WebSearch tool_use", () => {
    const blocks = activityToBlocks(
      {
        itemType: "web_search",
        data: { item: { id: "ws_1", query: "solid signals", type: "webSearch" } },
      },
      "act-x"
    );
    expect(blocks).toEqual([
      { type: "tool_use", name: "WebSearch", id: "ws_1", input: { query: "solid signals" } },
    ]);
  });

  it("keeps unrecognized item shapes visible as a generic tool row", () => {
    const blocks = activityToBlocks(
      { itemType: "novel_thing", data: { item: { id: "x_1", foo: "bar" } } },
      "act-x"
    );
    expect(blocks).toEqual([
      { type: "tool_use", name: "novel_thing", id: "act-x", input: { id: "x_1", foo: "bar" } },
    ]);
  });

  it("emits a lone tool_use when the result is missing", () => {
    const blocks = activityToBlocks(
      { itemType: "dynamic_tool_call", data: { toolName: "Read", input: { file_path: "/a" } } },
      "act-x"
    );
    expect(blocks).toEqual([
      { type: "tool_use", name: "Read", id: "act-x", input: { file_path: "/a" } },
    ]);
  });

  it("returns no blocks for unparseable payloads", () => {
    expect(activityToBlocks(null, "act-x")).toEqual([]);
    expect(activityToBlocks({ itemType: "command_execution", data: {} }, "act-x")).toEqual([]);
  });
});
