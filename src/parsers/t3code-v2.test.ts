import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initDb } from "../db/schema";
import { computeHash } from "../media/storage";
import {
  createT3CodeV2Fixture,
  FIXTURE,
  insertLegacyImport,
  insertMessage,
  insertThread,
  insertTurnItem,
} from "./fixtures/t3code/statev2-fixture";
import { importT3Code } from "./t3code";
import { T3_V2_CURSOR_OVERLAP_MS, T3_V2_TABLES, turnItemToBlocks } from "./t3code-v2";

interface EventRow {
  source_id: string;
  source_account: string;
  type: string;
  timestamp: string;
  title: string;
  content: string;
  people: string;
  tags: string;
  raw_data: string;
  conversation_id: string;
}

const { threads } = FIXTURE;

describe("importT3Code (v2 store)", () => {
  let db: Database;
  let root: string;
  let t3DbPath: string;
  let mediaDir: string;
  let priorMediaPath: string | undefined;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);
    root = join(tmpdir(), `t3code-v2-fixture-${randomUUID()}`);
    t3DbPath = join(root, "statev2.sqlite");
    mediaDir = join(tmpdir(), `t3code-v2-media-${randomUUID()}`);
    await mkdir(join(root, "attachments"), { recursive: true });
    await mkdir(mediaDir, { recursive: true });
    await writeFile(join(root, "attachments", `${FIXTURE.image.id}.png`), FIXTURE.image.bytes);
    createT3CodeV2Fixture(t3DbPath).close();

    priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
    process.env.TIMELINE_MEDIA_PATH = mediaDir;
  });

  afterEach(async () => {
    db.close();
    if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
    else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
    await rm(root, { recursive: true, force: true });
    await rm(mediaDir, { recursive: true, force: true });
  });

  function events(): EventRow[] {
    return db
      .prepare("SELECT * FROM events WHERE source = 't3code' ORDER BY timestamp, source_id")
      .all() as EventRow[];
  }

  function event(sourceId: string): EventRow & { raw: Record<string, unknown> } {
    const row = events().find((e) => e.source_id === sourceId);
    if (!row) throw new Error(`event ${sourceId} not imported`);
    return { ...row, raw: JSON.parse(row.raw_data) };
  }

  function withT3Db(fn: (t3Db: Database) => void): void {
    const t3Db = new Database(t3DbPath);
    try {
      fn(t3Db);
    } finally {
      t3Db.close();
    }
  }

  it("imports messages, tool calls, plans and reasoning; skips incomplete rows", async () => {
    const stats = await importT3Code(db, t3DbPath, "alice");

    expect(stats.store).toBe("v2");
    // main: 4 messages; sub, archived, deleted, legacy: 1 each.
    expect(stats.messages).toBe(8);
    // main: Read, Task, 2× Bash, Edit, WebSearch; legacy: Bash.
    expect(stats.toolCalls).toBe(7);
    expect(stats.plans).toBe(1);
    expect(stats.reasoning).toBe(1);
    expect(stats.skippedByReason).toEqual({ empty_message: 1, pending_transcript: 1 });
    expect(stats.pendingTranscriptThreads).toBe(1);
    expect(stats.threads).toEqual(
      new Set([threads.main, threads.sub, threads.archived, threads.deleted, threads.legacy])
    );

    const ids = events().map((e) => e.source_id);
    expect(ids).not.toContain(`${threads.main}:main-streaming`);
    expect(ids).not.toContain(`${threads.main}:item-running`);
    expect(ids).not.toContain(`${threads.main}:item-handoff`);
    expect(ids).not.toContain(`${threads.main}:item-assistant-message`);
    expect(ids.some((id) => id.startsWith(`${threads.pending}:`))).toBe(false);
  });

  it("attributes each turn to the provider and model of its run", async () => {
    await importT3Code(db, t3DbPath, "alice");
    const claudeTurn = event(`${threads.main}:main-assistant-1`);
    const codexTurn = event(`${threads.main}:main-assistant-2`);

    // A custom instance is attributed to its driver; the instance is kept.
    expect(claudeTurn.raw.provider).toBe("claudeAgent");
    expect(claudeTurn.raw.provider_instance_id).toBe(FIXTURE.claudeInstance);
    expect(claudeTurn.raw.model).toBe(FIXTURE.models.claude);
    expect(JSON.parse(claudeTurn.tags)).toContain(`model:${FIXTURE.models.claude}`);
    expect(JSON.parse(claudeTurn.people)).toEqual([
      `t3code:${FIXTURE.models.claude}`,
      "t3code:alice",
    ]);
    expect(codexTurn.raw.provider).toBe("codex");
    expect(codexTurn.raw.model).toBe(FIXTURE.models.codex);
    expect(JSON.parse(codexTurn.tags)).toEqual([
      "editor:t3code",
      `project:${FIXTURE.projectTitle}`,
      `model:${FIXTURE.models.codex}`,
      "provider:codex",
      "branch:feature/login",
    ]);
    expect(codexTurn.title).toBe(`${FIXTURE.projectTitle}: Add login form`);
    expect(codexTurn.conversation_id).toBe(threads.main);
  });

  it("records thread metadata and the provider-native sessions it drove", async () => {
    await importT3Code(db, t3DbPath, "alice");
    const raw = event(`${threads.main}:main-user-1`).raw;

    expect(raw).toMatchObject({
      store: "v2",
      thread_id: threads.main,
      thread_title: "Add login form",
      thread_archived: false,
      thread_deleted: false,
      branch: "feature/login",
      worktree_path: "/home/alice/.t3/worktrees/demo-app/demo-1a2b",
      project_title: FIXTURE.projectTitle,
      workspace_root: FIXTURE.workspaceRoot,
      parent_thread_id: null,
      thread_relationship: null,
      created_by: "user",
    });
    expect(raw.provider_sessions).toEqual([
      { driver: "claudeAgent", native_id: FIXTURE.nativeSessions.claudeAgent },
      { driver: "codex", native_id: FIXTURE.nativeSessions.codex },
      { driver: "antigravity", native_id: FIXTURE.nativeSessions.antigravity },
    ]);
    expect(event(`${threads.archived}:archived-user-1`).raw.thread_archived).toBe(true);
    expect(event(`${threads.deleted}:deleted-user-1`).raw.thread_deleted).toBe(true);
  });

  it("keeps subagent threads as their own conversations linked to the parent", async () => {
    await importT3Code(db, t3DbPath, "alice");
    const child = event(`${threads.sub}:sub-assistant-1`);
    expect(child.conversation_id).toBe(threads.sub);
    expect(child.raw).toMatchObject({
      parent_thread_id: threads.main,
      root_thread_id: threads.main,
      thread_relationship: "subagent",
      thread_creation_source: "provider",
    });

    const task = event(`${threads.main}:item-subagent`);
    expect(task.conversation_id).toBe(threads.main);
    expect(task.raw.child_thread_id).toBe(threads.sub);
    expect(task.raw.content).toEqual([
      {
        type: "tool_use",
        name: "Task",
        id: "toolu_fixture_task",
        input: { prompt: "Find existing form components", description: "Find form components" },
      },
      { type: "tool_result", tool_use_id: "toolu_fixture_task", content: "Found two form components." },
    ]);
  });

  it("maps tool items to tool blocks and keeps the original payload", async () => {
    await importT3Code(db, t3DbPath, "alice");
    const failed = event(`${threads.main}:item-bash-fail`);
    expect(failed.type).toBe("t3code:message:assistant");
    expect(failed.content).toBe("");
    expect(failed.raw.content).toEqual([
      { type: "tool_use", name: "Bash", id: "call_fixture_fail", input: { command: "bun run lint" } },
      { type: "tool_result", tool_use_id: "call_fixture_fail", error: "1 problem" },
    ]);
    expect((failed.raw.item as Record<string, unknown>).exitCode).toBe(1);

    expect(event(`${threads.main}:item-read`).raw.content).toEqual([
      {
        type: "tool_use",
        name: "Read",
        id: "toolu_fixture_read",
        input: { file_path: "/home/alice/code/demo-app/src/App.tsx" },
      },
      { type: "tool_result", tool_use_id: "toolu_fixture_read", content: "export function App() {}" },
    ]);
    expect(event(`${threads.main}:item-search`).raw.content).toMatchObject([
      { type: "tool_use", name: "WebSearch", input: { query: "solid form validation" } },
      { type: "tool_result", content: [{ title: "Forms", url: "https://example.com/forms" }] },
    ]);
  });

  it("imports plans as assistant text and reasoning as thinking blocks", async () => {
    await importT3Code(db, t3DbPath, "alice");
    const plan = event(`${threads.main}:item-plan`);
    expect(plan.content).toBe("# Plan\n- Add a LoginForm component");
    expect(plan.raw.plan_id).toBe("plan-1");

    const reasoning = event(`${threads.main}:item-reasoning`);
    expect(reasoning.content).toBe("");
    expect(reasoning.raw.content).toEqual([
      { type: "thinking", thinking: "Considering where the tests should live." },
    ]);
  });

  it("stores image attachments from the attachments directory", async () => {
    await importT3Code(db, t3DbPath, "alice");
    const rows = db.prepare(`
      SELECT a.source_id, a.filename, a.content_hash
      FROM attachments a JOIN events e ON e.id = a.event_id
      WHERE e.source_id = ?
    `).all(`${threads.main}:main-user-1`);
    expect(rows).toEqual([
      { source_id: FIXTURE.image.id, filename: FIXTURE.image.name, content_hash: computeHash(FIXTURE.image.bytes) },
    ]);
  });

  it("reuses v1 message and activity ids for migrated threads", async () => {
    await importT3Code(db, t3DbPath, "alice");
    expect(event(`${threads.legacy}:${FIXTURE.legacy.messageId}`).content).toBe("Legacy question");
    expect(event(`${threads.legacy}:${FIXTURE.legacy.completedActivityId}`).raw.content).toEqual([
      { type: "tool_use", name: "Bash", id: `import:v1:activity:${threads.legacy}:exec-1`, input: { command: "git status" } },
      {
        type: "tool_result",
        tool_use_id: `import:v1:activity:${threads.legacy}:exec-1`,
        content: "clean",
      },
    ]);
  });

  it("is idempotent and keeps accounts apart", async () => {
    await importT3Code(db, t3DbPath, "alice");
    const again = await importT3Code(db, t3DbPath, "alice");
    expect(again.messages + again.toolCalls + again.plans + again.reasoning).toBe(0);

    const otherHost = await importT3Code(db, t3DbPath, "alice-laptop");
    expect(otherHost.messages).toBe(8);
    const accounts = db
      .prepare("SELECT source_account, COUNT(*) AS n FROM events WHERE source = 't3code' GROUP BY 1 ORDER BY 1")
      .all();
    expect(accounts).toEqual([
      { source_account: "alice", n: 17 },
      { source_account: "alice-laptop", n: 17 },
    ]);
  });

  it("plans without writing on a dry run", async () => {
    const stats = await importT3Code(null, t3DbPath, "alice", { dryRun: true });
    expect(stats.messages).toBe(8);
    expect(stats.toolCalls).toBe(7);
    expect(events()).toEqual([]);
  });

  describe("cursor", () => {
    it("returns the latest change timestamp", async () => {
      const stats = await importT3Code(db, t3DbPath, "alice");
      expect(stats.cursor).toBe("2026-05-02T10:00:00.000Z");
    });

    it("reads only rows changed since the cursor", async () => {
      const first = await importT3Code(db, t3DbPath, "alice");
      const cursor = first.cursor;
      if (!cursor) throw new Error("expected a cursor");
      const later = new Date(Date.parse(cursor) + T3_V2_CURSOR_OVERLAP_MS * 2).toISOString();

      withT3Db((t3Db) => {
        insertMessage(t3Db, {
          id: "main-user-3",
          threadId: threads.main,
          runId: FIXTURE.runs.codex,
          role: "user",
          text: "One more thing",
          createdAt: later,
        });
        // A pending tool call completes: its row is updated in place.
        t3Db.prepare(`
          UPDATE orchestration_v2_projection_turn_items
          SET status = 'completed', updated_at = ?,
              payload_json = json_set(payload_json, '$.status', 'completed', '$.output', 'ready')
          WHERE turn_item_id = 'item-running'
        `).run(later);
      });

      const second = await importT3Code(db, t3DbPath, "alice", { cursor });
      expect(second.messages).toBe(1);
      expect(second.toolCalls).toBe(1);
      // Besides the two changed rows, only the overlap window is re-read
      // (the deleted thread's message, skipped as a duplicate).
      expect(second.skipped).toBe(1);
      expect(second.cursor).toBe(later);
      expect(event(`${threads.main}:item-running`).raw.content).toMatchObject([
        { type: "tool_use", name: "Bash" },
        { type: "tool_result", content: "ready" },
      ]);
    });

    it("reads whole threads that are new or whose v1 transcript just landed", async () => {
      const first = await importT3Code(db, t3DbPath, "alice");
      const cursor = first.cursor;
      if (!cursor) throw new Error("expected a cursor");
      const later = new Date(Date.parse(cursor) + T3_V2_CURSOR_OVERLAP_MS * 2).toISOString();

      withT3Db((t3Db) => {
        // T3 copies the pending transcript in; its rows keep old timestamps.
        t3Db.prepare(`
          UPDATE orchestration_v2_legacy_imports SET transcript_imported_at = ? WHERE thread_id = ?
        `).run(later, threads.pending);
        insertMessage(t3Db, {
          id: "pending-assistant-1",
          threadId: threads.pending,
          runId: null,
          role: "assistant",
          text: "Pending answer",
          createdAt: "2026-04-02T09:01:00.000Z",
        });
        // A fork copies history into a new thread, also with old timestamps.
        insertThread(t3Db, {
          id: "thread-fork",
          title: "Forked",
          provider: "codex",
          model: FIXTURE.models.codex,
          createdAt: later,
          lineage: { parentThreadId: threads.main, relationshipToParent: "fork", rootThreadId: threads.main },
        });
        insertMessage(t3Db, {
          id: "fork-user-1",
          threadId: "thread-fork",
          runId: null,
          role: "user",
          text: "Copied question",
          createdAt: "2026-05-01T10:00:00.000Z",
        });
        insertTurnItem(t3Db, {
          id: "fork-bash",
          threadId: "thread-fork",
          runId: null,
          type: "command_execution",
          status: "completed",
          at: "2026-05-01T10:12:00.000Z",
          fields: { input: "ls", output: "src", exitCode: 0 },
        });
      });

      const second = await importT3Code(db, t3DbPath, "alice", { cursor });
      expect(second.pendingTranscriptThreads).toBe(0);
      expect(second.messages).toBe(3);
      expect(second.toolCalls).toBe(1);
      expect(event(`${threads.pending}:pending-user-1`).content).toBe("Pending question");
      expect(event("thread-fork:fork-user-1").raw.thread_relationship).toBe("fork");
    });
  });

  it("imports a snapshot holding only the tables it reads", async () => {
    const snapshotPath = join(root, "snapshot.sqlite");
    const snapshot = new Database(snapshotPath);
    snapshot.run("ATTACH DATABASE ? AS full", [t3DbPath]);
    for (const table of T3_V2_TABLES) {
      const { sql } = snapshot
        .prepare("SELECT sql FROM full.sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) as { sql: string };
      snapshot.run(sql);
      snapshot.run(`INSERT INTO main.${table} SELECT * FROM full.${table}`);
    }
    snapshot.run("DETACH DATABASE full");
    snapshot.close();

    const full = await importT3Code(null, t3DbPath, "alice", { dryRun: true });
    const partial = await importT3Code(null, snapshotPath, "alice", { dryRun: true });
    expect(partial).toEqual(full);
  });

  describe("changed rows", () => {
    async function importThenLater() {
      const first = await importT3Code(db, t3DbPath, "alice");
      if (!first.cursor) throw new Error("expected a cursor");
      const later = new Date(Date.parse(first.cursor) + T3_V2_CURSOR_OVERLAP_MS * 2).toISOString();
      return { cursor: first.cursor, later };
    }

    it("rewrites an edited message and a reopened subagent result", async () => {
      const { cursor, later } = await importThenLater();
      withT3Db((t3Db) => {
        t3Db.prepare(`
          UPDATE orchestration_v2_projection_messages
          SET updated_at = ?, payload_json = json_set(payload_json, '$.text', 'Now add tests and docs')
          WHERE message_id = 'main-user-2'
        `).run(later);
        t3Db.prepare(`
          UPDATE orchestration_v2_projection_turn_items
          SET updated_at = ?, payload_json = json_set(payload_json, '$.result', 'Found three form components.')
          WHERE turn_item_id = 'item-subagent'
        `).run(later);
      });

      const second = await importT3Code(db, t3DbPath, "alice", { cursor });
      expect(second.refreshed).toBe(2);
      expect(second.messages + second.toolCalls).toBe(0);
      expect(event(`${threads.main}:main-user-2`).content).toBe("Now add tests and docs");
      expect(event(`${threads.main}:item-subagent`).raw.content).toContainEqual({
        type: "tool_result",
        tool_use_id: "toolu_fixture_task",
        content: "Found three form components.",
      });
    });

    it("re-attributes the assistant identity when a turn's model changes", async () => {
      const { cursor, later } = await importThenLater();
      withT3Db((t3Db) => {
        t3Db.prepare(`
          UPDATE orchestration_v2_projection_runs
          SET payload_json = json_set(payload_json, '$.modelSelection.model', 'gpt-6.2')
          WHERE run_id = ?
        `).run(FIXTURE.runs.codex);
        t3Db.prepare("UPDATE orchestration_v2_projection_threads SET updated_at = ? WHERE thread_id = ?")
          .run(later, threads.main);
      });

      await importT3Code(db, t3DbPath, "alice", { cursor });
      const turn = event(`${threads.main}:main-assistant-2`);
      expect(turn.raw.model).toBe("gpt-6.2");
      expect(JSON.parse(turn.people)).toEqual(["t3code:gpt-6.2", "t3code:alice"]);
    });

    it("retries a missing image on an explicit refresh", async () => {
      await rm(join(root, "attachments", `${FIXTURE.image.id}.png`));
      await importT3Code(db, t3DbPath, "alice");
      const attachmentCount = () =>
        (db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE source = 't3code'").get() as { n: number }).n;
      expect(attachmentCount()).toBe(0);

      await writeFile(join(root, "attachments", `${FIXTURE.image.id}.png`), FIXTURE.image.bytes);
      await importT3Code(db, t3DbPath, "alice", { refreshRawData: true });
      expect(attachmentCount()).toBe(1);
    });

    it("propagates a rename or archive with no new messages to every event", async () => {
      const { cursor, later } = await importThenLater();
      withT3Db((t3Db) => {
        t3Db.prepare(`
          UPDATE orchestration_v2_projection_threads
          SET title = 'Login form', archived_at = ?, updated_at = ?
          WHERE thread_id = ?
        `).run(later, later, threads.main);
      });

      const second = await importT3Code(db, t3DbPath, "alice", { cursor });
      const mainEvents = events().filter((e) => e.conversation_id === threads.main);
      expect(second.refreshed).toBe(mainEvents.length);
      for (const row of mainEvents) {
        expect(row.title).toBe(`${FIXTURE.projectTitle}: Login form`);
        expect(JSON.parse(row.raw_data).thread_archived).toBe(true);
      }

      // Re-reading the unchanged thread writes nothing.
      const third = await importT3Code(db, t3DbPath, "alice", { cursor: second.cursor });
      expect(third.refreshed).toBe(0);
    });
  });

  describe("schema detection", () => {
    it("rejects a database that is not a T3 Code store", async () => {
      withT3Db((t3Db) => {
        for (const { name } of t3Db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%projection_threads'")
          .all() as { name: string }[]) {
          t3Db.run(`DROP TABLE ${name}`);
        }
      });
      await expect(importT3Code(db, t3DbPath, "alice")).rejects.toThrow(
        /Unrecognised T3 Code database/
      );
    });

    it("fails instead of importing partially when a v2 column is missing", async () => {
      withT3Db((t3Db) => {
        t3Db.run("ALTER TABLE orchestration_v2_projection_runs DROP COLUMN provider_instance_id");
      });
      await expect(importT3Code(db, t3DbPath, "alice")).rejects.toThrow(
        "missing orchestration_v2_projection_runs.provider_instance_id"
      );
      expect(events()).toEqual([]);
    });
  });
});

describe("turnItemToBlocks", () => {
  it("returns no blocks for item types without a tool mapping", () => {
    expect(turnItemToBlocks({ type: "checkpoint", id: "x", status: "completed" })).toEqual([]);
  });

  it("marks a failed dynamic tool with its output as the error", () => {
    expect(
      turnItemToBlocks({
        type: "dynamic_tool",
        id: "item-1",
        status: "failed",
        toolName: "mcp__demo__fetch",
        input: { url: "https://example.com" },
        output: { message: "timeout" },
      })
    ).toEqual([
      { type: "tool_use", name: "mcp__demo__fetch", id: "item-1", input: { url: "https://example.com" } },
      { type: "tool_result", tool_use_id: "item-1", error: '{"message":"timeout"}' },
    ]);
  });

  it("keeps a lone tool_use when a command has no output", () => {
    expect(
      turnItemToBlocks({ type: "command_execution", id: "item-2", status: "interrupted", input: "sleep 100" })
    ).toEqual([{ type: "tool_use", name: "Bash", id: "item-2", input: { command: "sleep 100" } }]);
  });
});
