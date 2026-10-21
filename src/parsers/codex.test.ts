import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { initDb } from "../db/schema";
import { computeHash } from "../media/storage";
import { importCodex } from "./codex";

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
  source_id: string;
  content_hash: string;
  filename: string;
  mime_type: string;
  file_size: number;
  storage_path: string;
  status: string;
}

function jsonl(lines: unknown[]): string {
  return `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
}

function sessionMeta(id: string, overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-06-10T10:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      timestamp: "2026-06-10T10:00:00.000Z",
      cwd: "/tmp/my-project",
      originator: "codex_cli_rs",
      cli_version: "0.138.0",
      source: "cli",
      git: { branch: "alice/feature" },
      ...overrides,
    },
  };
}

function turnContext(model: string) {
  return {
    timestamp: "2026-06-10T10:00:01.000Z",
    type: "turn_context",
    payload: { turn_id: "turn-1", cwd: "/tmp/my-project", model },
  };
}

function userMessage(text: string, ts: string, images: string[] = []) {
  return {
    timestamp: ts,
    type: "event_msg",
    payload: { type: "user_message", message: text, images, local_images: [] },
  };
}

function agentMessage(text: string, ts: string, phase = "final_answer") {
  return {
    timestamp: ts,
    type: "event_msg",
    payload: { type: "agent_message", message: text, phase, memory_citation: null },
  };
}

function tokenCount(
  last: { input: number; cached: number; output: number; reasoning: number },
  ts: string
) {
  return {
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 0, cached_input_tokens: 0, output_tokens: 0,
          reasoning_output_tokens: 0, total_tokens: 0,
        },
        last_token_usage: {
          input_tokens: last.input,
          cached_input_tokens: last.cached,
          output_tokens: last.output,
          reasoning_output_tokens: last.reasoning,
          total_tokens: last.input + last.output,
        },
        model_context_window: 258400,
      },
      rate_limits: { limit_id: "codex" },
    },
  };
}

// Injected context appears only as response_item message lines; the parser
// must not import them.
function responseItemMessage(role: string, text: string) {
  return {
    timestamp: "2026-06-10T10:00:00.500Z",
    type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  };
}

function functionCall(callId: string, name: string, args: unknown, ts: string) {
  return {
    timestamp: ts,
    type: "response_item",
    payload: { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) },
  };
}

function functionCallOutput(callId: string, output: string, ts: string) {
  return {
    timestamp: ts,
    type: "response_item",
    payload: { type: "function_call_output", call_id: callId, output },
  };
}

function customToolCall(callId: string, name: string, input: string, ts: string) {
  return {
    timestamp: ts,
    type: "response_item",
    payload: { type: "custom_tool_call", call_id: callId, name, input, status: "completed" },
  };
}

function customToolCallOutput(callId: string, output: unknown, ts: string) {
  return {
    timestamp: ts,
    type: "response_item",
    payload: { type: "custom_tool_call_output", call_id: callId, output },
  };
}

function reasoningItem(summaryTexts: string[], ts: string) {
  return {
    timestamp: ts,
    type: "response_item",
    payload: {
      type: "reasoning",
      id: "rs_1",
      summary: summaryTexts.map((text) => ({ type: "summary_text", text })),
      encrypted_content: "gAAAA...",
    },
  };
}

describe("importCodex", () => {
  let db: Database;
  let sessionsDir: string;
  let mediaDir: string;
  let priorMediaPath: string | undefined;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);
    sessionsDir = join(tmpdir(), `codex-fixture-${randomUUID()}`);
    mediaDir = join(tmpdir(), `codex-media-${randomUUID()}`);
    await mkdir(join(sessionsDir, "2026/06/10"), { recursive: true });
    await mkdir(mediaDir, { recursive: true });

    priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
    process.env.TIMELINE_MEDIA_PATH = mediaDir;
  });

  afterEach(async () => {
    db.close();
    if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
    else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
    await rm(sessionsDir, { recursive: true, force: true });
    await rm(mediaDir, { recursive: true, force: true });
  });

  async function writeRollout(name: string, lines: unknown[]) {
    await writeFile(join(sessionsDir, "2026/06/10", name), jsonl(lines));
  }

  function getEvents(): EventRow[] {
    return db
      .prepare("SELECT * FROM events WHERE source = 'codex' ORDER BY timestamp")
      .all() as EventRow[];
  }

  function getAttachments(eventSourceId: string): AttachmentRow[] {
    return db
      .prepare(
        `SELECT a.source_id, a.content_hash, a.filename, a.mime_type,
                a.file_size, a.storage_path, a.status
         FROM attachments a
         JOIN events e ON e.id = a.event_id
         WHERE e.source = 'codex' AND e.source_id = ?
         ORDER BY a.source_id`,
      )
      .all(eventSourceId) as AttachmentRow[];
  }

  async function writeBasicSession(sessionId = "session-1") {
    await writeRollout(`rollout-2026-06-10T10-00-00-${sessionId}.jsonl`, [
      sessionMeta(sessionId),
      responseItemMessage("developer", "<permissions instructions>ignore me"),
      responseItemMessage("user", "# AGENTS.md instructions for /tmp/my-project"),
      turnContext("gpt-5.5"),
      userMessage("fix the bug", "2026-06-10T10:00:02.000Z"),
      agentMessage("Looking at it now", "2026-06-10T10:00:10.000Z", "commentary"),
      agentMessage("Fixed the bug", "2026-06-10T10:00:30.000Z"),
    ]);
  }

  it("imports user and agent messages, ignoring response_item context", async () => {
    await writeBasicSession();
    const stats = await importCodex(db, sessionsDir, "alice");

    expect(stats.sessions).toBe(1);
    expect(stats.messages).toBe(3);

    const events = getEvents();
    expect(events.map((e) => e.type)).toEqual([
      "codex:message:user",
      "codex:message:assistant",
      "codex:message:assistant",
    ]);
    expect(events.map((e) => e.content)).toEqual([
      "fix the bug",
      "Looking at it now",
      "Fixed the bug",
    ]);
  });

  it("attaches accumulated token usage to the next agent message", async () => {
    await writeRollout("rollout-2026-06-10T10-00-00-usage.jsonl", [
      sessionMeta("session-usage"),
      turnContext("gpt-5.5"),
      userMessage("fix the bug", "2026-06-10T10:00:02.000Z"),
      // Two API calls (e.g. a tool round-trip) before the first reply
      tokenCount({ input: 1000, cached: 600, output: 50, reasoning: 20 }, "2026-06-10T10:00:05.000Z"),
      tokenCount({ input: 2000, cached: 1500, output: 100, reasoning: 0 }, "2026-06-10T10:00:08.000Z"),
      agentMessage("Looking at it now", "2026-06-10T10:00:10.000Z", "commentary"),
      tokenCount({ input: 3000, cached: 2900, output: 200, reasoning: 150 }, "2026-06-10T10:00:20.000Z"),
      agentMessage("Fixed the bug", "2026-06-10T10:00:30.000Z"),
      // Trailing count with no following agent message is dropped
      tokenCount({ input: 99, cached: 0, output: 9, reasoning: 0 }, "2026-06-10T10:00:40.000Z"),
    ]);
    await importCodex(db, sessionsDir, "alice");
    const [userMsg, firstReply, secondReply] = getEvents();

    expect(JSON.parse(userMsg.raw_data).usage).toBeUndefined();
    expect(JSON.parse(firstReply.raw_data).usage).toEqual({
      input_tokens: 3000,
      cached_input_tokens: 2100,
      output_tokens: 150,
      reasoning_output_tokens: 20,
    });
    expect(JSON.parse(secondReply.raw_data).usage).toEqual({
      input_tokens: 3000,
      cached_input_tokens: 2900,
      output_tokens: 200,
      reasoning_output_tokens: 150,
    });
  });

  it("backfills usage via refresh without duplicating events", async () => {
    await writeRollout("rollout-2026-06-10T10-00-00-refresh.jsonl", [
      sessionMeta("session-refresh"),
      turnContext("gpt-5.5"),
      userMessage("hello", "2026-06-10T10:00:02.000Z"),
      tokenCount({ input: 500, cached: 0, output: 40, reasoning: 0 }, "2026-06-10T10:00:05.000Z"),
      agentMessage("hi", "2026-06-10T10:00:10.000Z"),
    ]);
    await importCodex(db, sessionsDir, "alice");
    // Simulate rows imported before usage capture existed
    db.prepare(
      "UPDATE events SET raw_data = json_remove(raw_data, '$.usage') WHERE source = 'codex'"
    ).run();

    const stats = await importCodex(db, sessionsDir, "alice", { refreshRawData: true });
    expect(stats.refreshed).toBe(2);
    expect(stats.messages).toBe(0);

    const assistant = getEvents().find((e) => e.type === "codex:message:assistant");
    if (!assistant) throw new Error("assistant event missing");
    expect(JSON.parse(assistant.raw_data).usage).toEqual({
      input_tokens: 500,
      cached_input_tokens: 0,
      output_tokens: 40,
      reasoning_output_tokens: 0,
    });
  });

  it("maps title, conversation, tags and people", async () => {
    await writeBasicSession();
    await importCodex(db, sessionsDir, "alice");
    const [userMsg, assistantMsg] = getEvents();

    expect(userMsg.title).toBe("my-project");
    expect(userMsg.conversation_id).toBe("session-1");
    expect(JSON.parse(userMsg.tags)).toEqual([
      "editor:codex",
      "project:my-project",
      "model:gpt-5.5",
      "branch:alice/feature",
    ]);
    expect(JSON.parse(userMsg.people)).toEqual(["codex:alice"]);
    expect(JSON.parse(assistantMsg.people)).toEqual([
      "codex:gpt-5.5",
      "codex:alice",
    ]);
  });

  it("preserves session metadata and phase in raw_data", async () => {
    await writeBasicSession();
    await importCodex(db, sessionsDir, "alice");
    const [userMsg, commentaryMsg, finalMsg] = getEvents();

    const raw = JSON.parse(userMsg.raw_data);
    expect(raw.session_id).toBe("session-1");
    expect(raw.cwd).toBe("/tmp/my-project");
    expect(raw.originator).toBe("codex_cli_rs");
    expect(raw.session_source).toBe("cli");
    expect(raw.cli_version).toBe("0.138.0");
    expect(raw.git_branch).toBe("alice/feature");
    expect(raw.phase).toBeUndefined();

    expect(JSON.parse(commentaryMsg.raw_data).phase).toBe("commentary");
    expect(JSON.parse(finalMsg.raw_data).phase).toBe("final_answer");
  });

  it("skips t3code_desktop sessions", async () => {
    await writeRollout("rollout-2026-06-10T11-00-00-t3.jsonl", [
      sessionMeta("t3-session", { originator: "t3code_desktop" }),
      turnContext("gpt-5.5"),
      userMessage("from t3", "2026-06-10T11:00:01.000Z"),
      agentMessage("t3 reply", "2026-06-10T11:00:02.000Z"),
    ]);
    const stats = await importCodex(db, sessionsDir, "alice");

    expect(stats.skippedT3Sessions).toBe(1);
    expect(stats.messages).toBe(0);
    expect(getEvents()).toEqual([]);
  });

  it("records subagent parent thread and emits image blocks", async () => {
    await writeRollout("rollout-2026-06-10T12-00-00-sub.jsonl", [
      sessionMeta("sub-session", {
        source: {
          subagent: { thread_spawn: { parent_thread_id: "parent-1", depth: 1 } },
        },
      }),
      turnContext("gpt-5.5"),
      userMessage("look at this", "2026-06-10T12:00:01.000Z", [
        "data:image/png;base64,xxxx",
      ]),
    ]);
    await importCodex(db, sessionsDir, "alice");

    const event = getEvents()[0];
    // Subagent events group under the parent thread's conversation.
    expect(event.conversation_id).toBe("parent-1");
    const raw = JSON.parse(event.raw_data);
    expect(raw.session_source).toBe("subagent");
    expect(raw.parent_thread_id).toBe("parent-1");
    expect(raw.images).toBe(1);
    expect(raw.content).toEqual([
      { type: "text", text: "look at this" },
      { type: "image", media_type: "image/png" },
    ]);
  });

  it("folds review-mode subagents into the parent conversation without duplicates", async () => {
    const prompt = "Review the code changes against main.";
    // Review mode writes the prompt twice on adjacent lines in the parent.
    await writeRollout("rollout-2026-06-10T20-00-00-review-parent.jsonl", [
      sessionMeta("review-parent", { source: "exec", originator: "codex_exec" }),
      {
        timestamp: "2026-06-10T20:00:00.100Z",
        type: "event_msg",
        payload: { type: "entered_review_mode", target: { type: "custom" } },
      },
      userMessage(prompt, "2026-06-10T20:00:01.000Z"),
      userMessage(prompt, "2026-06-10T20:00:01.005Z"),
    ]);
    // The child holds the actual review conversation; its meta carries a
    // top-level parent_thread_id and its prompt is a copy of the parent's.
    await writeRollout("rollout-2026-06-10T20-00-01-review-child.jsonl", [
      sessionMeta("review-child", {
        source: { subagent: "review" },
        originator: "codex_exec",
        session_id: "review-parent",
        parent_thread_id: "review-parent",
      }),
      turnContext("gpt-5.5"),
      userMessage(prompt, "2026-06-10T20:00:02.000Z"),
      tokenCount({ input: 700, cached: 200, output: 80, reasoning: 10 }, "2026-06-10T20:00:05.000Z"),
      agentMessage("Findings: none", "2026-06-10T20:00:10.000Z"),
    ]);
    const stats = await importCodex(db, sessionsDir, "alice");

    const events = getEvents();
    expect(events.map((e) => [e.type, e.content, e.conversation_id])).toEqual([
      ["codex:message:user", prompt, "review-parent"],
      ["codex:message:assistant", "Findings: none", "review-parent"],
    ]);
    expect(JSON.parse(events[1].raw_data).usage).toEqual({
      input_tokens: 700,
      cached_input_tokens: 200,
      output_tokens: 80,
      reasoning_output_tokens: 10,
    });
    // Duplicated prompt in the parent + prompt copy replayed in the child.
    expect(stats.skipped).toBe(1);
    expect(stats.replayLinesSkipped).toBe(1);
  });

  it("skips parent history replayed into thread_spawn subagent rollouts", async () => {
    const parentMeta = sessionMeta("spawn-parent", { source: "exec", originator: "codex_exec" });
    const parentTurn = turnContext("gpt-5.5");
    const parentUser = userMessage("do the task", "2026-06-10T21:00:01.000Z");
    const parentCount = tokenCount({ input: 1000, cached: 0, output: 50, reasoning: 0 }, "2026-06-10T21:00:04.000Z");
    const parentAgent = agentMessage("working on it", "2026-06-10T21:00:05.000Z", "commentary");
    await writeRollout("rollout-2026-06-10T21-00-00-spawn-parent.jsonl", [
      parentMeta,
      parentTurn,
      parentUser,
      parentCount,
      parentAgent,
    ]);
    // The child replays the parent's items verbatim (payloads identical,
    // envelope timestamps rewritten) before its own turn.
    const replay = (item: { type?: string; payload?: unknown }) => ({
      timestamp: "2026-06-10T21:00:10.000Z",
      type: item.type,
      payload: item.payload,
    });
    await writeRollout("rollout-2026-06-10T21-00-10-spawn-child.jsonl", [
      sessionMeta("spawn-child", {
        source: { subagent: { thread_spawn: { parent_thread_id: "spawn-parent", depth: 1 } } },
        originator: "codex_exec",
        session_id: "spawn-parent",
        parent_thread_id: "spawn-parent",
      }),
      replay(parentMeta),
      replay(parentTurn),
      replay(parentUser),
      replay(parentCount),
      replay(parentAgent),
      {
        timestamp: "2026-06-10T21:00:12.000Z",
        type: "turn_context",
        payload: { turn_id: "turn-child", cwd: "/tmp/my-project", model: "gpt-5.5" },
      },
      tokenCount({ input: 2000, cached: 500, output: 120, reasoning: 40 }, "2026-06-10T21:00:20.000Z"),
      agentMessage("child findings", "2026-06-10T21:00:30.000Z"),
    ]);
    const stats = await importCodex(db, sessionsDir, "alice");

    const events = getEvents();
    expect(events.map((e) => [e.type, e.content, e.conversation_id])).toEqual([
      ["codex:message:user", "do the task", "spawn-parent"],
      ["codex:message:assistant", "working on it", "spawn-parent"],
      ["codex:message:assistant", "child findings", "spawn-parent"],
    ]);
    // The child's usage counts only its own API calls, not the replayed
    // parent token_count.
    expect(JSON.parse(events[2].raw_data).usage).toEqual({
      input_tokens: 2000,
      cached_input_tokens: 500,
      output_tokens: 120,
      reasoning_output_tokens: 40,
    });
    expect(stats.replayLinesSkipped).toBe(5);
  });

  it("keeps a child's own message that matches a parent payload after the replay prefix", async () => {
    const parentMeta = sessionMeta("echo-parent", { source: "exec", originator: "codex_exec" });
    const parentAgent = agentMessage("Done.", "2026-06-10T22:00:05.000Z");
    await writeRollout("rollout-2026-06-10T22-00-00-echo-parent.jsonl", [
      parentMeta,
      turnContext("gpt-5.5"),
      userMessage("first task", "2026-06-10T22:00:01.000Z"),
      parentAgent,
    ]);
    await writeRollout("rollout-2026-06-10T22-00-10-echo-child.jsonl", [
      sessionMeta("echo-child", {
        source: { subagent: { thread_spawn: { parent_thread_id: "echo-parent", depth: 1 } } },
        originator: "codex_exec",
        parent_thread_id: "echo-parent",
      }),
      {
        timestamp: "2026-06-10T22:00:11.000Z",
        type: "turn_context",
        payload: { turn_id: "turn-echo-child", cwd: "/tmp/my-project", model: "gpt-5.5" },
      },
      // Identical payload to the parent's reply, but past the replay prefix
      // (the child's own turn_context ended it) — must be imported.
      agentMessage("Done.", "2026-06-10T22:00:30.000Z"),
    ]);
    const stats = await importCodex(db, sessionsDir, "alice");

    expect(stats.replayLinesSkipped).toBe(0);
    const contents = getEvents().map((e) => e.content);
    expect(contents.filter((c) => c === "Done.")).toHaveLength(2);
  });

  it("keeps legitimate adjacent identical user messages outside review mode", async () => {
    await writeRollout("rollout-2026-06-10T23-00-00-repeat.jsonl", [
      sessionMeta("repeat-session"),
      turnContext("gpt-5.5"),
      userMessage("continue", "2026-06-10T23:00:01.000Z"),
      userMessage("continue", "2026-06-10T23:00:02.000Z"),
    ]);
    const stats = await importCodex(db, sessionsDir, "alice");

    expect(stats.messages).toBe(2);
    expect(getEvents().map((e) => e.content)).toEqual(["continue", "continue"]);
  });

  it("imports image-only prompts with a renderable image block", async () => {
    await writeRollout("rollout-2026-06-10T12-30-00-imgonly.jsonl", [
      sessionMeta("imgonly-session"),
      turnContext("gpt-5.5"),
      userMessage("", "2026-06-10T12:30:01.000Z", ["data:image/jpeg;base64,yyyy"]),
    ]);
    const stats = await importCodex(db, sessionsDir, "alice");

    expect(stats.messages).toBe(1);
    const raw = JSON.parse(getEvents()[0].raw_data);
    expect(raw.content).toEqual([{ type: "image", media_type: "image/jpeg" }]);
  });

  it("stores data URL image attachments with source ids matching block positions", async () => {
    const pngBytes = Buffer.from("tiny synthetic png");
    const jpgBytes = Buffer.from("tiny synthetic jpg");
    await writeRollout("rollout-2026-06-10T12-45-00-images.jsonl", [
      sessionMeta("image-session"),
      turnContext("gpt-5.5"),
      userMessage("look at these", "2026-06-10T12:45:01.000Z", [
        `data:image/png;base64,${pngBytes.toString("base64")}`,
        `data:image/jpeg;base64,${jpgBytes.toString("base64")}`,
      ]),
    ]);

    await importCodex(db, sessionsDir, "alice");

    const event = getEvents()[0];
    const raw = JSON.parse(event.raw_data);
    expect(raw.images).toBe(2);
    expect(raw.content).toEqual([
      { type: "text", text: "look at these" },
      { type: "image", media_type: "image/png" },
      { type: "image", media_type: "image/jpeg" },
    ]);

    const attachments = getAttachments("image-session:2");
    expect(attachments).toEqual([
      {
        source_id: "1",
        content_hash: computeHash(pngBytes),
        filename: "image-1.png",
        mime_type: "image/png",
        file_size: pngBytes.length,
        storage_path: join("codex", "alice/image-session/image-session_2/image-1.png"),
        status: "stored",
      },
      {
        source_id: "2",
        content_hash: computeHash(jpgBytes),
        filename: "image-2.jpg",
        mime_type: "image/jpeg",
        file_size: jpgBytes.length,
        storage_path: join("codex", "alice/image-session/image-session_2/image-2.jpg"),
        status: "stored",
      },
    ]);
  });

  it("keeps malformed data URL images metadata-only and continues importing", async () => {
    await writeRollout("rollout-2026-06-10T12-50-00-bad-images.jsonl", [
      sessionMeta("bad-image-session"),
      turnContext("gpt-5.5"),
      userMessage("bad images", "2026-06-10T12:50:01.000Z", [
        "not-a-data-url",
        "data:;base64,abcd",
        "data:image/png;base64,$$$not-base64$$$",
      ]),
      userMessage("still imports", "2026-06-10T12:51:01.000Z"),
    ]);

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      await importCodex(db, sessionsDir, "alice");
    } finally {
      console.warn = originalWarn;
    }

    const [badRow, laterRow] = getEvents();
    expect(JSON.parse(badRow.raw_data).content).toEqual([
      { type: "text", text: "bad images" },
      { type: "image" },
      { type: "image" },
      { type: "image", media_type: "image/png" },
    ]);
    expect(getAttachments("bad-image-session:2")).toHaveLength(0);
    expect(laterRow.content).toBe("still imports");
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toContain("bad-image-session:2");
    expect(warnings.join("\n")).toContain("image index 1");
    expect(warnings.join("\n")).toContain("image index 2");
    expect(warnings.join("\n")).toContain("image index 3");
  });

  it("imports exec tool calls as Bash tool_use/tool_result blocks", async () => {
    await writeRollout("rollout-2026-06-10T15-00-00-tools.jsonl", [
      sessionMeta("tool-session"),
      turnContext("gpt-5.5"),
      functionCall(
        "call_1",
        "exec_command",
        { cmd: "git status", workdir: "/tmp/my-project", yield_time_ms: 10000 },
        "2026-06-10T15:00:01.000Z"
      ),
      functionCallOutput(
        "call_1",
        "Wall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nclean",
        "2026-06-10T15:00:02.000Z"
      ),
      agentMessage("All clean", "2026-06-10T15:00:03.000Z"),
    ]);
    const stats = await importCodex(db, sessionsDir, "alice");

    expect(stats.toolCalls).toBe(1);
    expect(stats.messages).toBe(1);

    const toolEvent = getEvents()[0];
    expect(toolEvent.type).toBe("codex:message:assistant");
    expect(toolEvent.content).toBe("");
    const raw = JSON.parse(toolEvent.raw_data);
    expect(raw.call_id).toBe("call_1");
    expect(raw.content).toEqual([
      {
        type: "tool_use",
        name: "Bash",
        id: "call_1",
        input: { command: "git status", cwd: "/tmp/my-project" },
      },
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: "Wall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nclean",
      },
    ]);
  });

  it("marks nonzero exec exits as errors", async () => {
    await writeRollout("rollout-2026-06-10T15-30-00-err.jsonl", [
      sessionMeta("err-session"),
      turnContext("gpt-5.5"),
      functionCall("call_e", "shell_command", { command: "false" }, "2026-06-10T15:30:01.000Z"),
      functionCallOutput("call_e", "Process exited with code 1\nOutput:\n", "2026-06-10T15:30:02.000Z"),
    ]);
    await importCodex(db, sessionsDir, "alice");

    const raw = JSON.parse(getEvents()[0].raw_data);
    expect(raw.content[1].error).toContain("exited with code 1");
    expect(raw.content[1].content).toBeUndefined();
  });

  it("imports code-mode exec_command wrappers as Bash blocks with joined output", async () => {
    // Shapes from CLI 0.144.0 rollouts: input is a JS script wrapping
    // tools.exec_command; output is an array of input_text blocks.
    const script =
      'const r = await tools.exec_command({cmd:"rg -n \\"foo\\" src","workdir":"/tmp/my-project","yield_time_ms":10000,"max_output_tokens":6000}); text(r.output);\n';
    await writeRollout("rollout-2026-06-10T20-00-00-codemode.jsonl", [
      sessionMeta("codemode-session", { cli_version: "0.144.0" }),
      turnContext("gpt-5.6"),
      customToolCall("call_cm", "exec", script, "2026-06-10T20:00:01.000Z"),
      customToolCallOutput(
        "call_cm",
        [
          { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
          { type: "input_text", text: "src/a.ts:1:foo" },
        ],
        "2026-06-10T20:00:02.000Z"
      ),
    ]);
    const stats = await importCodex(db, sessionsDir, "alice");

    expect(stats.toolCalls).toBe(1);
    const raw = JSON.parse(getEvents()[0].raw_data);
    expect(raw.call_id).toBe("call_cm");
    expect(raw.tool).toBe("exec");
    expect(raw.content).toEqual([
      {
        type: "tool_use",
        name: "Bash",
        id: "call_cm",
        input: { command: 'rg -n "foo" src', cwd: "/tmp/my-project" },
      },
      {
        type: "tool_result",
        tool_use_id: "call_cm",
        content: "Script completed\nWall time 0.1 seconds\nOutput:\nsrc/a.ts:1:foo",
      },
    ]);
  });

  it("keeps non-wrapper exec scripts as an exec tool_use and flags spawn failures", async () => {
    const script =
      'const xs = ALL_TOOLS.filter(x => /file/.test(x.name)); text(xs);\n';
    await writeRollout("rollout-2026-06-10T20-30-00-codemode-script.jsonl", [
      sessionMeta("codemode-script-session", { cli_version: "0.144.0" }),
      turnContext("gpt-5.6"),
      customToolCall("call_cs", "exec", script, "2026-06-10T20:30:01.000Z"),
      customToolCallOutput(
        "call_cs",
        "failed to spawn code-mode host /opt/homebrew/bin/codex-code-mode-host: No such file or directory (os error 2)",
        "2026-06-10T20:30:02.000Z"
      ),
    ]);
    await importCodex(db, sessionsDir, "alice");

    const raw = JSON.parse(getEvents()[0].raw_data);
    expect(raw.content).toEqual([
      { type: "tool_use", name: "exec", id: "call_cs", input: { code: script } },
      {
        type: "tool_result",
        tool_use_id: "call_cs",
        error:
          "failed to spawn code-mode host /opt/homebrew/bin/codex-code-mode-host: No such file or directory (os error 2)",
      },
    ]);
  });

  it("falls back to an exec tool_use when wrapper args don't parse or trailing code exists", async () => {
    // (a) exec_command arg contains a nested object the literal parser
    // rejects; (b) a clean wrapper followed by extra logic. Both must keep
    // the full script instead of extracting a command.
    const nestedArgs =
      'const r = await tools.exec_command({cmd:"git status",env:{CI:"1"}}); text(r.output);\n';
    const trailingLogic =
      'const r = await tools.exec_command({cmd:"git status"}); if (r.output.length > 5) text("long"); text(r.output);\n';
    await writeRollout("rollout-2026-06-10T20-40-00-codemode-fallback.jsonl", [
      sessionMeta("codemode-fallback-session", { cli_version: "0.144.0" }),
      turnContext("gpt-5.6"),
      customToolCall("call_f1", "exec", nestedArgs, "2026-06-10T20:40:01.000Z"),
      customToolCallOutput("call_f1", [{ type: "input_text", text: "clean" }], "2026-06-10T20:40:02.000Z"),
      customToolCall("call_f2", "exec", trailingLogic, "2026-06-10T20:40:03.000Z"),
      customToolCallOutput("call_f2", [{ type: "input_text", text: "long" }], "2026-06-10T20:40:04.000Z"),
    ]);
    await importCodex(db, sessionsDir, "alice");

    const uses = getEvents().map((e) => JSON.parse(e.raw_data).content[0]);
    expect(uses).toEqual([
      { type: "tool_use", name: "exec", id: "call_f1", input: { code: nestedArgs } },
      { type: "tool_use", name: "exec", id: "call_f2", input: { code: trailingLogic } },
    ]);
  });

  it("keeps tool_use for exec custom calls that never got an output", async () => {
    await writeRollout("rollout-2026-06-10T20-45-00-codemode-cut.jsonl", [
      sessionMeta("codemode-cut-session", { cli_version: "0.144.0" }),
      turnContext("gpt-5.6"),
      customToolCall(
        "call_cc",
        "exec",
        'const r = await tools.exec_command({cmd:"sleep 100"}); text(r.output);\n',
        "2026-06-10T20:45:01.000Z"
      ),
    ]);
    const stats = await importCodex(db, sessionsDir, "alice");

    expect(stats.toolCalls).toBe(1);
    const raw = JSON.parse(getEvents()[0].raw_data);
    expect(raw.content).toEqual([
      { type: "tool_use", name: "Bash", id: "call_cc", input: { command: "sleep 100" } },
    ]);
  });

  it("splits apply_patch envelopes into per-file blocks", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/b.ts",
      "+created",
      "*** End Patch",
    ].join("\n");
    await writeRollout("rollout-2026-06-10T16-00-00-patch.jsonl", [
      sessionMeta("patch-session"),
      turnContext("gpt-5.5"),
      {
        timestamp: "2026-06-10T16:00:01.000Z",
        type: "response_item",
        payload: { type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: patch },
      },
      // The paired output only restates the file list; it must not emit a
      // second event.
      customToolCallOutput(
        "call_p",
        "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM src/a.ts\nA src/b.ts\n",
        "2026-06-10T16:00:02.000Z"
      ),
    ]);
    const stats = await importCodex(db, sessionsDir, "alice");
    expect(stats.toolCalls).toBe(1);

    const raw = JSON.parse(getEvents()[0].raw_data);
    const uses = raw.content.filter((b: { type: string }) => b.type === "tool_use");
    expect(uses).toEqual([
      { type: "tool_use", name: "Edit", id: "call_p:0", input: { file_path: "src/a.ts" } },
      { type: "tool_use", name: "Write", id: "call_p:1", input: { file_path: "src/b.ts" } },
    ]);
    const results = raw.content.filter((b: { type: string }) => b.type === "tool_result");
    expect(results[0].content).toContain("-old");
    expect(results[1].content).toContain("+created");
    expect(results[1].content).not.toContain("End Patch");
  });

  it("imports readable reasoning summaries as thinking blocks", async () => {
    await writeRollout("rollout-2026-06-10T17-00-00-think.jsonl", [
      sessionMeta("think-session"),
      turnContext("gpt-5.5"),
      reasoningItem(["**Reading plan file**", "Checking scope"], "2026-06-10T17:00:01.000Z"),
      reasoningItem([], "2026-06-10T17:00:02.000Z"), // encrypted-only: skipped
      agentMessage("Done", "2026-06-10T17:00:03.000Z"),
    ]);
    const stats = await importCodex(db, sessionsDir, "alice");

    expect(stats.reasoning).toBe(1);
    const raw = JSON.parse(getEvents()[0].raw_data);
    expect(raw.content).toEqual([
      { type: "thinking", thinking: "**Reading plan file**\n\nChecking scope" },
    ]);
  });

  it("keeps tool_use for calls that never got an output", async () => {
    await writeRollout("rollout-2026-06-10T18-00-00-cut.jsonl", [
      sessionMeta("cut-session"),
      turnContext("gpt-5.5"),
      functionCall("call_x", "exec_command", { cmd: "sleep 100" }, "2026-06-10T18:00:01.000Z"),
    ]);
    const stats = await importCodex(db, sessionsDir, "alice");

    expect(stats.toolCalls).toBe(1);
    const raw = JSON.parse(getEvents()[0].raw_data);
    expect(raw.content).toEqual([
      { type: "tool_use", name: "Bash", id: "call_x", input: { command: "sleep 100" } },
    ]);
  });

  it("rolls Conductor workspace cwds up to the repo name", async () => {
    await writeRollout("rollout-2026-06-10T14-00-00-cw.jsonl", [
      sessionMeta("cw-session", {
        cwd: "/Users/alice/conductor/workspaces/timeline/sample-worktree",
      }),
      turnContext("gpt-5.5"),
      userMessage("hi", "2026-06-10T14:00:01.000Z"),
    ]);
    await importCodex(db, sessionsDir, "alice");

    const event = getEvents()[0];
    expect(event.title).toBe("timeline");
    expect(JSON.parse(event.tags)).toContain("project:timeline");
  });

  it("ignores sessions with no conversation", async () => {
    await writeRollout("rollout-2026-06-10T13-00-00-empty.jsonl", [
      sessionMeta("empty-session"),
      responseItemMessage("user", "<environment_context>only injected</environment_context>"),
    ]);
    const stats = await importCodex(db, sessionsDir, "alice");
    expect(stats.sessions).toBe(0);
    expect(stats.messages).toBe(0);
  });

  it("is idempotent across runs", async () => {
    await writeBasicSession();
    const first = await importCodex(db, sessionsDir, "alice");
    const second = await importCodex(db, sessionsDir, "alice");

    expect(first.messages).toBe(3);
    expect(second.messages).toBe(0);
    expect(second.skipped).toBe(3);
    expect(getEvents().length).toBe(3);
  });

  it("does not duplicate image attachments across re-imports", async () => {
    const imageBytes = Buffer.from("same rollout image");
    await writeRollout("rollout-2026-06-10T19-00-00-idempotent-image.jsonl", [
      sessionMeta("idempotent-image-session"),
      turnContext("gpt-5.5"),
      userMessage("attached", "2026-06-10T19:00:01.000Z", [
        `data:image/png;base64,${imageBytes.toString("base64")}`,
      ]),
    ]);

    const first = await importCodex(db, sessionsDir, "alice");
    const second = await importCodex(db, sessionsDir, "alice");

    expect(first.messages).toBe(1);
    expect(second.messages).toBe(0);
    expect(second.skipped).toBe(1);
    expect(getAttachments("idempotent-image-session:2")).toHaveLength(1);
  });

  it("refreshes image rows without duplicating attachments", async () => {
    const imageBytes = Buffer.from("refresh rollout image");
    await writeRollout("rollout-2026-06-10T19-15-00-refresh-image.jsonl", [
      sessionMeta("refresh-image-session"),
      turnContext("gpt-5.5"),
      userMessage("attached", "2026-06-10T19:15:01.000Z", [
        `data:image/png;base64,${imageBytes.toString("base64")}`,
      ]),
    ]);

    await importCodex(db, sessionsDir, "alice");
    const firstAttachments = getAttachments("refresh-image-session:2");
    expect(firstAttachments).toHaveLength(1);

    const refresh = await importCodex(db, sessionsDir, "alice", {
      refreshRawData: true,
    });
    expect(refresh.messages).toBe(0);
    expect(refresh.refreshed).toBe(1);
    expect(getAttachments("refresh-image-session:2")).toEqual(firstAttachments);

    const secondRefresh = await importCodex(db, sessionsDir, "alice", {
      refreshRawData: true,
    });
    expect(secondRefresh.messages).toBe(0);
    expect(secondRefresh.refreshed).toBe(1);
    expect(getAttachments("refresh-image-session:2")).toEqual(firstAttachments);
  });

  it("refreshes existing rows when refreshRawData is set", async () => {
    await writeBasicSession();
    await importCodex(db, sessionsDir, "alice");

    // Rewrite the session with edited assistant text at the same line index
    await writeRollout("rollout-2026-06-10T10-00-00-session-1.jsonl", [
      sessionMeta("session-1"),
      responseItemMessage("developer", "<permissions instructions>ignore me"),
      responseItemMessage("user", "# AGENTS.md instructions for /tmp/my-project"),
      turnContext("gpt-5.5"),
      userMessage("fix the bug", "2026-06-10T10:00:02.000Z"),
      agentMessage("Looking at it now", "2026-06-10T10:00:10.000Z", "commentary"),
      agentMessage("Edited answer", "2026-06-10T10:00:30.000Z"),
    ]);

    const stats = await importCodex(db, sessionsDir, "alice", {
      refreshRawData: true,
    });
    expect(stats.refreshed).toBe(3);
    expect(stats.messages).toBe(0);

    const edited = getEvents().find((e) => e.content === "Edited answer");
    expect(edited).toBeDefined();
  });

  it("upserts user and assistant identities", async () => {
    await writeBasicSession();
    const stats = await importCodex(db, sessionsDir, "alice");
    expect(stats.identitiesUpserted).toBe(2);

    const identity = db
      .prepare(
        "SELECT display_name FROM identities WHERE platform = 'codex' AND platform_id = 'gpt-5.5'"
      )
      .get() as { display_name: string } | null;
    expect(identity?.display_name).toBe("GPT 5.5");
  });
});
