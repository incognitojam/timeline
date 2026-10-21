import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { initDb } from "../db/schema";
import {
  importOpenCode,
  normalizePartsToBlocks,
  type OpenCodePart,
} from "./opencode";

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
