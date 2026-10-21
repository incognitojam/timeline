import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initDb } from "../db/schema";
import { computeHash } from "../media/storage";
import { importConductor } from "./conductor";

interface EventRow {
  source_id: string;
  content: string;
  raw_data: string;
}

interface AttachmentRow {
  source_id: string;
  content_hash: string;
  filename: string;
  mime_type: string;
  file_size: number;
  storage_path: string;
  status: string;
}

describe("importConductor", () => {
  let db: Database;
  let conductorDbPath: string;
  let mediaDir: string;
  let priorMediaPath: string | undefined;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);

    const fixtureDir = join(tmpdir(), `conductor-fixture-${randomUUID()}`);
    mediaDir = join(tmpdir(), `conductor-media-${randomUUID()}`);
    await mkdir(fixtureDir, { recursive: true });
    await mkdir(mediaDir, { recursive: true });
    conductorDbPath = join(fixtureDir, "conductor.db");

    const conductorDb = new Database(conductorDbPath);
    conductorDb.exec(`
      CREATE TABLE repos (
        id TEXT PRIMARY KEY,
        name TEXT,
        root_path TEXT
      );
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        directory_name TEXT,
        branch TEXT,
        repository_id TEXT
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        status TEXT,
        agent_type TEXT,
        workspace_id TEXT
      );
      CREATE TABLE session_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        role TEXT,
        content TEXT,
        model TEXT,
        sent_at TEXT,
        created_at TEXT,
        turn_id TEXT,
        cancelled_at TEXT
      );
      INSERT INTO repos (id, name, root_path)
      VALUES ('repo-1', 'timeline', '/Users/alice/projects/timeline');
      INSERT INTO workspaces (id, directory_name, branch, repository_id)
      VALUES ('workspace-1', 'timeline-feature', 'alice/image-import', 'repo-1');
      INSERT INTO sessions (id, title, status, agent_type, workspace_id)
      VALUES ('session-1', 'Image session', 'completed', 'codex', 'workspace-1');
    `);
    conductorDb.close();

    priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
    process.env.TIMELINE_MEDIA_PATH = mediaDir;
  });

  afterEach(async () => {
    db.close();
    if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
    else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
    await rm(mediaDir, { recursive: true, force: true });
    await rm(join(conductorDbPath, ".."), { recursive: true, force: true });
  });

  function insertConductorMessage(
    id: string,
    content: unknown[],
    sentAt = "2026-04-01T00:00:00.000Z",
  ) {
    const conductorDb = new Database(conductorDbPath);
    conductorDb.prepare(`
      INSERT INTO session_messages (
        id, session_id, role, content, model, sent_at, created_at, turn_id, cancelled_at
      ) VALUES (?, 'session-1', 'assistant', ?, 'claude-sonnet-4-5', ?, ?, ?, NULL)
    `).run(
      id,
      JSON.stringify({
        uuid: `${id}-uuid`,
        message: {
          content,
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      }),
      sentAt,
      sentAt,
      `turn-${id}`,
    );
    conductorDb.close();
  }

  function getRow(sourceId: string): EventRow | undefined {
    return db
      .prepare(
        "SELECT source_id, content, raw_data FROM events WHERE source = 'conductor' AND source_id = ?"
      )
      .get(sourceId) as EventRow | undefined;
  }

  function getAttachments(eventSourceId: string): AttachmentRow[] {
    return db
      .prepare(
        `SELECT a.source_id, a.content_hash, a.filename, a.mime_type,
                a.file_size, a.storage_path, a.status
         FROM attachments a
         JOIN events e ON e.id = a.event_id
         WHERE e.source = 'conductor' AND e.source_id = ?
         ORDER BY a.id`,
      )
      .all(eventSourceId) as AttachmentRow[];
  }

  it("stores top-level and nested base64 image blocks as attachments", async () => {
    const topBytes = Buffer.from("top-level image bytes");
    const nestedBytes = Buffer.from("nested image bytes");
    const topData = topBytes.toString("base64");
    const nestedData = nestedBytes.toString("base64");
    insertConductorMessage("msg-image", [
      { type: "text", text: "Here is the screenshot." },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: topData },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_1",
        content: [
          { type: "text", text: "tool output" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: nestedData },
          },
        ],
      },
    ]);

    await importConductor(db, conductorDbPath, "tester");

    const row = getRow("session-1:msg-image");
    expect(row).toBeDefined();
    expect(row?.content).toBe("Here is the screenshot.");
    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual([
      { type: "text", text: "Here is the screenshot." },
      { type: "image", media_type: "image/png" },
      {
        type: "tool_result",
        tool_use_id: "tool_1",
        content: [
          { type: "text", text: "tool output" },
          { type: "image", media_type: "image/jpeg" },
        ],
      },
    ]);
    expect(JSON.stringify(raw)).not.toContain(topData);
    expect(JSON.stringify(raw)).not.toContain(nestedData);

    expect(getAttachments("session-1:msg-image")).toEqual([
      {
        source_id: "1",
        content_hash: computeHash(topBytes),
        filename: "image-1.png",
        mime_type: "image/png",
        file_size: topBytes.length,
        storage_path: join("conductor", "tester/session-1/msg-image/image-1.png"),
        status: "stored",
      },
      {
        source_id: "2.content.1",
        content_hash: computeHash(nestedBytes),
        filename: "image-2-content-1.jpg",
        mime_type: "image/jpeg",
        file_size: nestedBytes.length,
        storage_path: join("conductor", "tester/session-1/msg-image/image-2-content-1.jpg"),
        status: "stored",
      },
    ]);
  });

  it("preserves non-base64 image sources unchanged", async () => {
    const blocks = [
      {
        type: "image",
        media_type: "image/png",
        source: {
          type: "url",
          url: "https://example.com/image.png",
        },
      },
    ];
    insertConductorMessage("msg-url-image", blocks);

    await importConductor(db, conductorDbPath, "tester");

    const row = getRow("session-1:msg-url-image");
    expect(row).toBeDefined();
    expect(JSON.parse(row!.raw_data).content).toEqual(blocks);
    expect(getAttachments("session-1:msg-url-image")).toHaveLength(0);
  });

  it("keeps invalid base64 inline and continues importing later messages", async () => {
    const invalidImage = {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "$$$not-base64$$$",
      },
    };
    insertConductorMessage("msg-bad-image", [invalidImage]);
    insertConductorMessage(
      "msg-after-bad-image",
      [{ type: "text", text: "still imports" }],
      "2026-04-01T00:01:00.000Z",
    );

    await importConductor(db, conductorDbPath, "tester");

    const badRow = getRow("session-1:msg-bad-image");
    expect(badRow).toBeDefined();
    expect(JSON.parse(badRow!.raw_data).content).toEqual([invalidImage]);
    expect(getAttachments("session-1:msg-bad-image")).toHaveLength(0);

    const laterRow = getRow("session-1:msg-after-bad-image");
    expect(laterRow?.content).toBe("still imports");
  });

  it("is idempotent across runs", async () => {
    const imageData = Buffer.from("image bytes").toString("base64");
    insertConductorMessage("msg-1", [
      { type: "text", text: "hello world" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: imageData },
      },
    ]);

    const first = await importConductor(db, conductorDbPath, "tester");
    expect(first.messages).toBe(1);
    expect(getAttachments("session-1:msg-1")).toHaveLength(1);

    const second = await importConductor(db, conductorDbPath, "tester");
    expect(second.messages).toBe(0);
    expect(second.refreshed).toBe(0);
    expect(second.skipped).toBe(1);

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'conductor'")
      .get() as { n: number };
    expect(count.n).toBe(1);
    expect(getAttachments("session-1:msg-1")).toHaveLength(1);
  });

  it("refreshes existing rows when refreshRawData is set", async () => {
    insertConductorMessage("msg-1", [{ type: "text", text: "hello world" }]);
    await importConductor(db, conductorDbPath, "tester");
    db.run("UPDATE events SET content = 'stale', raw_data = '{}' WHERE source = 'conductor'");

    const stats = await importConductor(db, conductorDbPath, "tester", {
      refreshRawData: true,
    });
    expect(stats.messages).toBe(0);
    expect(stats.refreshed).toBe(1);

    const row = getRow("session-1:msg-1");
    expect(row?.content).toBe("hello world");
    expect(JSON.parse(row!.raw_data).message_id).toBe("msg-1");
  });
});
