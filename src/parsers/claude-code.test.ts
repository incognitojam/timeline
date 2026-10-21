import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { initDb } from "../db/schema";
import { computeHash } from "../media/storage";
import { importClaudeCode } from "./claude-code";

interface EventRow {
  source_id: string;
  content: string;
  raw_data: string;
  timestamp: string;
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

describe("importClaudeCode", () => {
  let db: Database;
  let claudeDir: string;
  let mediaDir: string;
  let priorMediaPath: string | undefined;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);

    claudeDir = join(tmpdir(), `claude-code-fixture-${randomUUID()}`);
    mediaDir = join(tmpdir(), `claude-code-media-${randomUUID()}`);
    await mkdir(claudeDir, { recursive: true });
    await mkdir(mediaDir, { recursive: true });

    priorMediaPath = process.env.TIMELINE_MEDIA_PATH;
    process.env.TIMELINE_MEDIA_PATH = mediaDir;
  });

  afterEach(async () => {
    db.close();
    if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
    else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
    await rm(claudeDir, { recursive: true, force: true });
    await rm(mediaDir, { recursive: true, force: true });
  });

  async function writeSession(uuid: string, content: unknown) {
    await writeSessionMessages([
      {
        uuid,
        timestamp: "2026-04-01T00:00:00.000Z",
        content,
      },
    ]);
  }

  async function writeSessionMessages(
    messages: Array<{ uuid: string; timestamp: string; content: unknown }>
  ) {
    const projectDir = join(claudeDir, "-tmp-project");
    await mkdir(projectDir, { recursive: true });
    const lines = messages.map((message) =>
      JSON.stringify({
        type: "assistant",
        uuid: message.uuid,
        timestamp: message.timestamp,
        sessionId: "session-1",
        cwd: "/tmp/project",
        message: {
          role: "assistant",
          content: message.content,
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 10, output_tokens: 20 },
        },
      })
    );
    await writeFile(join(projectDir, "session-1.jsonl"), `${lines.join("\n")}\n`);
  }

  function getRow(sourceId: string): EventRow | undefined {
    return db
      .prepare(
        "SELECT source_id, content, raw_data, timestamp FROM events WHERE source = 'claude-code' AND source_id = ?"
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
         WHERE e.source = 'claude-code' AND e.source_id = ?
         ORDER BY a.id`,
      )
      .all(eventSourceId) as AttachmentRow[];
  }

  it("stores extracted text in content and structured blocks in raw_data", async () => {
    const blocks = [
      { type: "text", text: "Running a command." },
      {
        type: "tool_use",
        name: "Bash",
        id: "tool_1",
        input: { command: "ls" },
      },
      { type: "tool_result", tool_use_id: "tool_1", content: "file.txt" },
      { type: "text", text: "All done." },
    ];
    await writeSession("msg-1", blocks);

    await importClaudeCode(db, claudeDir, "tester");

    const row = getRow("session-1:msg-1");
    expect(row).toBeDefined();
    expect(row?.content).toBe("Running a command.\n\nAll done.");

    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual(blocks);
    expect(raw.content[1].input).toEqual({ command: "ls" });
    expect(raw.content[2].tool_use_id).toBe("tool_1");
  });

  it("stores an empty content string for pure tool-use messages but keeps blocks", async () => {
    const blocks = [
      {
        type: "tool_use",
        name: "Read",
        id: "tool_x",
        input: { path: "/etc/hosts" },
      },
    ];
    await writeSession("msg-tool-only", blocks);

    await importClaudeCode(db, claudeDir, "tester");

    const row = getRow("session-1:msg-tool-only");
    expect(row?.content).toBe("");
    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual(blocks);
  });

  it("wraps a plain string content into a single text block", async () => {
    await writeSession("msg-str", "just a string message");

    await importClaudeCode(db, claudeDir, "tester");

    const row = getRow("session-1:msg-str");
    expect(row?.content).toBe("just a string message");
    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual([
      { type: "text", text: "just a string message" },
    ]);
  });

  it("stores base64 image blocks as attachments and strips raw_data bytes", async () => {
    const imageBytes = Buffer.from("not actually an image");
    const imageData = imageBytes.toString("base64");
    const blocks = [
      { type: "text", text: "Here is the screenshot." },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: imageData,
        },
      },
    ];
    await writeSession("msg-image", blocks);

    await importClaudeCode(db, claudeDir, "tester");

    const row = getRow("session-1:msg-image");
    expect(row).toBeDefined();
    expect(row?.content).toBe("Here is the screenshot.");
    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual([
      { type: "text", text: "Here is the screenshot." },
      { type: "image", media_type: "image/png" },
    ]);
    expect(JSON.stringify(raw)).not.toContain(imageData);

    const attachments = getAttachments("session-1:msg-image");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      source_id: "1",
      content_hash: computeHash(imageBytes),
      filename: "image-1.png",
      mime_type: "image/png",
      file_size: imageBytes.length,
      storage_path: join("claude-code", "tester/session-1/msg-image/image-1.png"),
      status: "stored",
    });
  });

  it("stores nested tool_result image blocks as attachments", async () => {
    const imageBytes = Buffer.from("nested image bytes");
    const imageData = imageBytes.toString("base64");
    const blocks = [
      {
        type: "tool_result",
        tool_use_id: "tool_1",
        content: [
          { type: "text", text: "tool output" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: imageData,
            },
          },
        ],
      },
    ];
    await writeSession("msg-nested-image", blocks);

    await importClaudeCode(db, claudeDir, "tester");

    const row = getRow("session-1:msg-nested-image");
    expect(row).toBeDefined();
    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tool_1",
        content: [
          { type: "text", text: "tool output" },
          { type: "image", media_type: "image/png" },
        ],
      },
    ]);
    expect(JSON.stringify(raw)).not.toContain(imageData);

    const attachments = getAttachments("session-1:msg-nested-image");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      source_id: "0.content.1",
      content_hash: computeHash(imageBytes),
      filename: "image-0-content-1.png",
      mime_type: "image/png",
      file_size: imageBytes.length,
      storage_path: join(
        "claude-code",
        "tester/session-1/msg-nested-image/image-0-content-1.png"
      ),
      status: "stored",
    });
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
    await writeSession("msg-url-image", blocks);

    await importClaudeCode(db, claudeDir, "tester");

    const row = getRow("session-1:msg-url-image");
    expect(row).toBeDefined();
    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual(blocks);
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
    await writeSessionMessages([
      {
        uuid: "msg-bad-image",
        timestamp: "2026-04-01T00:00:00.000Z",
        content: [invalidImage],
      },
      {
        uuid: "msg-after-bad-image",
        timestamp: "2026-04-01T00:01:00.000Z",
        content: [{ type: "text", text: "still imports" }],
      },
    ]);

    await importClaudeCode(db, claudeDir, "tester");

    const badRow = getRow("session-1:msg-bad-image");
    expect(badRow).toBeDefined();
    expect(JSON.parse(badRow!.raw_data).content).toEqual([invalidImage]);
    expect(getAttachments("session-1:msg-bad-image")).toHaveLength(0);

    const laterRow = getRow("session-1:msg-after-bad-image");
    expect(laterRow?.content).toBe("still imports");
  });

  it("does not overwrite existing rows on default re-import", async () => {
    await writeSession("msg-1", [{ type: "text", text: "first" }]);
    await importClaudeCode(db, claudeDir, "tester");

    await writeSession("msg-1", [{ type: "text", text: "second (updated)" }]);
    await importClaudeCode(db, claudeDir, "tester");

    const row = getRow("session-1:msg-1");
    expect(row?.content).toBe("first");
    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual([{ type: "text", text: "first" }]);
  });

  it("--refresh-raw-data rewrites content + raw_data for existing rows", async () => {
    await writeSession("msg-1", [{ type: "text", text: "first" }]);
    await importClaudeCode(db, claudeDir, "tester");

    const updatedBlocks = [
      { type: "text", text: "now with tools" },
      {
        type: "tool_use",
        name: "Bash",
        id: "tool_99",
        input: { command: "echo hi" },
      },
      { type: "tool_result", tool_use_id: "tool_99", content: "hi" },
    ];
    await writeSession("msg-1", updatedBlocks);
    await importClaudeCode(db, claudeDir, "tester", { refreshRawData: true });

    const row = getRow("session-1:msg-1");
    expect(row?.content).toBe("now with tools");
    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual(updatedBlocks);
    // Timestamp is preserved by the refresh path.
    expect(row?.timestamp).toBe("2026-04-01T00:00:00.000Z");
  });

  describe("project name derivation", () => {
    async function writeSessionInDir(
      projectDir: string,
      sessionFile: string,
      lines: Record<string, unknown>[]
    ) {
      const dir = join(claudeDir, projectDir);
      await mkdir(dir, { recursive: true });
      const body = lines.map((l) => JSON.stringify(l)).join("\n");
      await writeFile(join(dir, sessionFile), `${body}\n`);
    }

    function titleOf(sourceId: string): string | undefined {
      return (
        db
          .prepare(
            "SELECT title FROM events WHERE source = 'claude-code' AND source_id = ?"
          )
          .get(sourceId) as { title: string } | undefined
      )?.title;
    }

    const asst = (uuid: string, extra: Record<string, unknown>) => ({
      type: "assistant",
      uuid,
      timestamp: "2026-04-01T00:00:00.000Z",
      sessionId: "s",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        model: "claude-sonnet-4-5",
      },
      ...extra,
    });

    it("uses the launch cwd basename, not the lossy dash-encoded dir", async () => {
      // -Users-alice-Developer-example-service-api decodes to "api" if split on
      // dashes; the cwd basename is the real "example-service-api".
      await writeSessionInDir(
        "-Users-alice-Developer-example-service-api",
        "s.jsonl",
        [asst("u1", { cwd: "/Users/alice/Developer/example-service-api" })]
      );

      await importClaudeCode(db, claudeDir, "tester");

      expect(titleOf("s:u1")).toBe("example-service-api");
    });

    it("uses the first message's cwd as the launch dir across a mid-session cd", async () => {
      await writeSessionInDir(
        "-Users-alice-Developer-example-service-api",
        "s.jsonl",
        [
          {
            type: "user",
            uuid: "a",
            timestamp: "2026-04-01T00:00:00.000Z",
            sessionId: "s",
            cwd: "/Users/alice/Developer/example-service-api",
            message: { role: "user", content: "start" },
          },
          asst("b", {
            timestamp: "2026-04-01T00:01:00.000Z",
            // user cd'd into a subdirectory partway through the session
            cwd: "/Users/alice/Developer/example-service-api/example-submodule",
          }),
        ]
      );

      await importClaudeCode(db, claudeDir, "tester");

      expect(titleOf("s:a")).toBe("example-service-api");
      expect(titleOf("s:b")).toBe("example-service-api"); // not "example-submodule"
    });

    it("prefers the cwd that round-trips to the project dir over an earlier container cwd", async () => {
      // The session lives in the example-linux-port project dir but its first
      // recorded cwd is the parent (container) dir. The launch dir is the one
      // that encodes to the project dir, so the name is example-linux-port.
      await writeSessionInDir(
        "-Users-alice-Developer-example-linux-port",
        "s.jsonl",
        [
          {
            type: "user",
            uuid: "a",
            timestamp: "2026-04-01T00:00:00.000Z",
            sessionId: "s",
            cwd: "/Users/alice/Developer", // container dir, recorded first
            message: { role: "user", content: "start" },
          },
          asst("b", {
            timestamp: "2026-04-01T00:01:00.000Z",
            cwd: "/Users/alice/Developer/example-linux-port", // the launch dir
          }),
        ]
      );

      await importClaudeCode(db, claudeDir, "tester");

      expect(titleOf("s:a")).toBe("example-linux-port"); // not "Developer"
      expect(titleOf("s:b")).toBe("example-linux-port");
    });

    it("appends the session slug suffix when present", async () => {
      await writeSessionInDir(
        "-Users-alice-Developer-example-discord-client",
        "s.jsonl",
        [
          asst("u1", {
            cwd: "/Users/alice/Developer/example-discord-client",
            slug: "sample-worktree",
          }),
        ]
      );

      await importClaudeCode(db, claudeDir, "tester");

      expect(titleOf("s:u1")).toBe(
        "example-discord-client (sample-worktree)"
      );
    });

    it("falls back to the dash-decoded dir name when no message has a cwd", async () => {
      await writeSessionInDir("-Users-alice-Developer-timeline", "s.jsonl", [
        asst("u1", {}),
      ]);

      await importClaudeCode(db, claudeDir, "tester");

      expect(titleOf("s:u1")).toBe("timeline");
    });
  });

  describe("sub-agent (sidechain) linking", () => {
    async function writeMainSessionWithMessages(
      lines: Record<string, unknown>[]
    ) {
      const projectDir = join(claudeDir, "-tmp-project");
      await mkdir(projectDir, { recursive: true });
      const body = lines.map((l) => JSON.stringify(l)).join("\n");
      await writeFile(join(projectDir, "session-1.jsonl"), `${body}\n`);
    }

    async function writeSidechain(agentFileName: string, lines: Record<string, unknown>[]) {
      const dir = join(claudeDir, "-tmp-project", "session-1", "subagents");
      await mkdir(dir, { recursive: true });
      const body = lines.map((l) => JSON.stringify(l)).join("\n");
      await writeFile(join(dir, agentFileName), `${body}\n`);
    }

    const baseAssistant = (
      uuid: string,
      content: unknown,
      extra: Record<string, unknown> = {}
    ) => ({
      type: "assistant",
      uuid,
      timestamp: "2026-04-01T00:00:00.000Z",
      sessionId: "session-1",
      cwd: "/tmp/project",
      message: {
        role: "assistant",
        content,
        model: "claude-sonnet-4-5",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      ...extra,
    });

    const baseUser = (uuid: string, text: string, extra: Record<string, unknown> = {}) => ({
      type: "user",
      uuid,
      timestamp: "2026-04-01T00:00:01.000Z",
      sessionId: "session-1",
      cwd: "/tmp/project",
      message: { role: "user", content: text },
      ...extra,
    });

    // Real Claude Code sidechain JSONLs tag every message with
    // `isSidechain: true` and the `agentId`, not just the first user row.
    const sidechainExtras = (agentId: string) => ({
      isSidechain: true,
      agentId,
      parentUuid: null,
    });

    it("links a sidechain to its parent Task tool_use via the prompt", async () => {
      const prompt = "Explore the codebase for OAuth handlers.";
      await writeMainSessionWithMessages([
        baseAssistant("main-1", [
          {
            type: "tool_use",
            name: "Agent",
            id: "toolu_outer",
            input: { subagent_type: "Explore", prompt },
          },
        ]),
      ]);
      await writeSidechain("agent-aaaa.jsonl", [
        baseUser("sub-user-1", prompt, sidechainExtras("aaaa")),
        baseAssistant("sub-asst-1", [{ type: "text", text: "Looking..." }], sidechainExtras("aaaa")),
      ]);

      await importClaudeCode(db, claudeDir, "tester");

      const subAsst = getRow("session-1:sub-asst-1");
      expect(subAsst).toBeDefined();
      const raw = JSON.parse(subAsst!.raw_data);
      expect(raw.parent_tool_use_id).toBe("toolu_outer");
      expect(raw.is_sidechain).toBe(true);
      expect(raw.agent_id).toBe("aaaa");
      expect(raw.orphan_sidechain).toBeUndefined();
    });

    it("links a nested sidechain to a Task tool_use that lives in another sidechain", async () => {
      const outerPrompt = "Explore the codebase for OAuth handlers.";
      const innerPrompt = "Inside the explorer: look up Monzo's refresh flow.";
      await writeMainSessionWithMessages([
        baseAssistant("main-1", [
          {
            type: "tool_use",
            name: "Agent",
            id: "toolu_outer",
            input: { subagent_type: "Explore", prompt: outerPrompt },
          },
        ]),
      ]);
      // Outer sidechain itself invokes another Agent. The Task tool_use for
      // the inner agent lives inside this sidechain JSONL, not in the main
      // session — this is the regression case for nested linking.
      await writeSidechain("agent-outer.jsonl", [
        baseUser("outer-user-1", outerPrompt, sidechainExtras("outer")),
        baseAssistant(
          "outer-asst-1",
          [
            {
              type: "tool_use",
              name: "Agent",
              id: "toolu_inner",
              input: { subagent_type: "general-purpose", prompt: innerPrompt },
            },
          ],
          sidechainExtras("outer")
        ),
      ]);
      await writeSidechain("agent-inner.jsonl", [
        baseUser("inner-user-1", innerPrompt, sidechainExtras("inner")),
        baseAssistant("inner-asst-1", [{ type: "text", text: "Found it." }], sidechainExtras("inner")),
      ]);

      await importClaudeCode(db, claudeDir, "tester");

      const inner = getRow("session-1:inner-asst-1");
      expect(inner).toBeDefined();
      const raw = JSON.parse(inner!.raw_data);
      expect(raw.parent_tool_use_id).toBe("toolu_inner");
      expect(raw.is_sidechain).toBe(true);
      expect(raw.orphan_sidechain).toBeUndefined();

      // Outer sidechain remains linked to the main session's Task tool_use.
      const outer = getRow("session-1:outer-asst-1");
      const outerRaw = JSON.parse(outer!.raw_data);
      expect(outerRaw.parent_tool_use_id).toBe("toolu_outer");
    });

    it("disambiguates parallel Task calls with identical prompts via toolUseResult.agentId", async () => {
      const dupePrompt = "Audit the OAuth surface.";
      await writeMainSessionWithMessages([
        // Single assistant turn spawning two parallel Agent calls with
        // identical prompts — without agentId disambiguation, both
        // sidechains would attach to whichever toolu landed last in
        // the prompt map.
        baseAssistant("main-1", [
          {
            type: "tool_use",
            name: "Agent",
            id: "toolu_left",
            input: { subagent_type: "Explore", prompt: dupePrompt },
          },
          {
            type: "tool_use",
            name: "Agent",
            id: "toolu_right",
            input: { subagent_type: "Explore", prompt: dupePrompt },
          },
        ]),
        // tool_result rows carry toolUseResult.agentId pointing back to
        // the spawning toolu_XXX. Each is a separate user-role row.
        {
          type: "user",
          uuid: "main-result-left",
          timestamp: "2026-04-01T00:00:02.000Z",
          sessionId: "session-1",
          cwd: "/tmp/project",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_left",
                content: "left agent summary",
              },
            ],
          },
          toolUseResult: { agentId: "left", agentType: "Explore" },
        },
        {
          type: "user",
          uuid: "main-result-right",
          timestamp: "2026-04-01T00:00:03.000Z",
          sessionId: "session-1",
          cwd: "/tmp/project",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_right",
                content: "right agent summary",
              },
            ],
          },
          toolUseResult: { agentId: "right", agentType: "Explore" },
        },
      ]);
      await writeSidechain("agent-left.jsonl", [
        baseUser("left-user-1", dupePrompt, sidechainExtras("left")),
        baseAssistant("left-asst-1", [{ type: "text", text: "left finding" }], sidechainExtras("left")),
      ]);
      await writeSidechain("agent-right.jsonl", [
        baseUser("right-user-1", dupePrompt, sidechainExtras("right")),
        baseAssistant("right-asst-1", [{ type: "text", text: "right finding" }], sidechainExtras("right")),
      ]);

      await importClaudeCode(db, claudeDir, "tester");

      const left = JSON.parse(getRow("session-1:left-asst-1")!.raw_data);
      const right = JSON.parse(getRow("session-1:right-asst-1")!.raw_data);
      expect(left.parent_tool_use_id).toBe("toolu_left");
      expect(right.parent_tool_use_id).toBe("toolu_right");
    });

    it("marks a sidechain as orphan when no Task prompt matches", async () => {
      await writeMainSessionWithMessages([
        baseAssistant("main-1", [{ type: "text", text: "just a normal message" }]),
      ]);
      await writeSidechain("agent-orphan.jsonl", [
        baseUser("orphan-user-1", "An unrelated prompt that no Task spawned.", sidechainExtras("orphan")),
        baseAssistant("orphan-asst-1", [{ type: "text", text: "..." }], sidechainExtras("orphan")),
      ]);

      await importClaudeCode(db, claudeDir, "tester");

      const orphan = getRow("session-1:orphan-asst-1");
      const raw = JSON.parse(orphan!.raw_data);
      expect(raw.parent_tool_use_id).toBeUndefined();
      expect(raw.orphan_sidechain).toBe(true);
      expect(raw.is_sidechain).toBe(true);
    });
  });
});
