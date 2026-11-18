import { Database } from "../../db/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initDb } from "../../db/schema";
import { type AmpContentBlock, importAmp, normalizeAmpBlocks } from "./parser";

describe("normalizeAmpBlocks", () => {
  it.each([
    {
      name: "passes thinking blocks through with only type + thinking",
      input: [{ type: "thinking", thinking: "pondering" }],
      expected: [{ type: "thinking", thinking: "pondering" }],
    },
    {
      name: "maps tool_use blocks keeping name, id, input",
      input: [
        {
          type: "tool_use",
          name: "Bash",
          id: "use_1",
          input: { command: "ls" },
        },
      ],
      expected: [
        {
          type: "tool_use",
          name: "Bash",
          id: "use_1",
          input: { command: "ls" },
        },
      ],
    },
    {
      name: "maps error-status results into the error field",
      input: [
        {
          type: "tool_result",
          toolUseID: "use_3",
          run: { status: "error", error: { message: "boom" } },
        },
      ],
      expected: [{ type: "tool_result", tool_use_id: "use_3", error: "boom" }],
    },
    {
      name: "handles tool_result with no run object",
      input: [{ type: "tool_result", toolUseID: "use_4" }],
      expected: [{ type: "tool_result", tool_use_id: "use_4", content: undefined }],
    },
    {
      name: "maps thread-type summary blocks to summary_type and thread_id",
      input: [{ type: "summary", summary: { type: "thread", thread: "T-thread-id" } }],
      expected: [{ type: "summary", summary_type: "thread", thread_id: "T-thread-id" }],
    },
  ])("$name", ({ input, expected }) => {
    expect(normalizeAmpBlocks(input as AmpContentBlock[])).toEqual(expected);
  });
});

interface EventRow {
  source_id: string;
  timestamp: string;
  title: string | null;
  content: string;
  people: string | null;
  tags: string | null;
  raw_data: string;
  conversation_id: string | null;
}

interface AmpFixtureMessage {
  role: "user" | "assistant";
  messageId?: number;
  content: AmpContentBlock[];
  meta?: {
    sentAt?: unknown;
  };
  userState?: {
    currentlyVisibleFiles?: string[];
    runningTerminalCommands?: string[];
  };
  agentMode?: string;
  state?: {
    type: string;
    stopReason?: string;
  };
  usage?: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    totalInputTokens?: number;
    credits?: number;
    timestamp?: unknown;
  };
  originalToolUseInput?: Record<string, unknown>;
  fileMentions?: Record<string, unknown>;
  threadMentions?: unknown[];
  turnElapsedMs?: number;
  interrupted?: boolean;
}

interface AmpFixtureEnv {
  initial?: {
    trees?: Array<{
      displayName?: string;
      fsPath?: string;
      uri?: string;
    }>;
  };
  systemPromptData?: {
    workingDirectory?: string;
  };
}

interface AmpFixtureThreadOptions {
  title?: string | null;
  workspaceRoots?: string[] | null;
  env?: AmpFixtureEnv;
  metadata?: Record<string, unknown>;
}

describe("importAmp", () => {
  let db: Database;
  let ampDir: string;
  const threadCreated = Date.UTC(2026, 3, 1);

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);

    ampDir = join(tmpdir(), `amp-fixture-${randomUUID()}`);
    await mkdir(ampDir, { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(ampDir, { recursive: true, force: true });
  });

  async function writeThread(
    threadId: string,
    content: AmpContentBlock[],
  ) {
    await writeThreadMessages(threadId, [
      {
        role: "assistant",
        messageId: 1,
        content,
        meta: { sentAt: threadCreated },
        usage: { model: "claude-sonnet-4-5" },
      },
    ]);
  }

  async function writeThreadMessages(
    threadId: string,
    messages: AmpFixtureMessage[],
    options: AmpFixtureThreadOptions = {},
  ) {
    const thread = {
      v: 1,
      id: threadId,
      created: threadCreated,
      messages,
      ...(options.title === null ? {} : { title: options.title ?? "fixture thread" }),
      ...(options.workspaceRoots === null
        ? {}
        : { workspaceRoots: options.workspaceRoots ?? ["/tmp/project"] }),
      ...(options.env ? { env: options.env } : {}),
      ...options.metadata,
    };
    await writeFile(join(ampDir, `${threadId}.json`), JSON.stringify(thread));
  }

  function getRow(sourceId: string): EventRow | undefined {
    const row = db
      .prepare(
        "SELECT source_id, timestamp, title, content, people, tags, raw_data, conversation_id FROM events WHERE source = 'amp' AND source_id = ?",
      )
      .get(sourceId) as EventRow | null;
    return row ?? undefined;
  }

  function getRows(): EventRow[] {
    return db
      .prepare(
        "SELECT source_id, timestamp, title, content, people, tags, raw_data, conversation_id FROM events WHERE source = 'amp' ORDER BY source_id",
      )
      .all() as EventRow[];
  }

  function getTags(row: EventRow): string[] {
    return JSON.parse(row.tags ?? "[]") as string[];
  }

  function getPeople(row: EventRow): string[] {
    return JSON.parse(row.people ?? "[]") as string[];
  }

  it("imports multiple messages missing messageId without collisions", async () => {
    await writeThreadMessages("thread-missing-ids", [
      { role: "user", content: [{ type: "text", text: "first" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
        usage: { model: "claude-sonnet-4" },
      },
      { role: "user", content: [{ type: "text", text: "third" }] },
    ]);

    const stats = await importAmp(db, ampDir, "tester");

    expect(stats.messages).toBe(3);
    const rows = getRows();
    expect(rows.map((row) => row.source_id)).toEqual([
      "thread-missing-ids:idx:0",
      "thread-missing-ids:idx:1",
      "thread-missing-ids:idx:2",
    ]);
    expect(rows.map((row) => row.timestamp)).toEqual([
      new Date(threadCreated).toISOString(),
      new Date(threadCreated + 1000).toISOString(),
      new Date(threadCreated + 2000).toISOString(),
    ]);
    expect(rows.map((row) => JSON.parse(row.raw_data).message_index)).toEqual([
      0, 1, 2,
    ]);
  });

  it("preserves source IDs for messages with messageId", async () => {
    await writeThreadMessages("thread-with-id", [
      {
        role: "assistant",
        messageId: 7,
        content: [{ type: "text", text: "hello" }],
        usage: { model: "claude-sonnet-4" },
      },
    ]);

    await importAmp(db, ampDir, "tester");

    const row = getRow("thread-with-id:7");
    expect(row).toBeDefined();
    expect(getRow("thread-with-id:idx:0")).toBeUndefined();
    const raw = JSON.parse(row!.raw_data);
    expect(raw.message_id).toBe(7);
    expect(raw.message_index).toBe(0);
  });

  it("keeps mixed messageId and index source IDs distinct", async () => {
    await writeThreadMessages("thread-mixed", [
      {
        role: "user",
        messageId: 1,
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
        usage: { model: "claude-sonnet-4" },
      },
      {
        role: "assistant",
        messageId: 2,
        content: [{ type: "text", text: "third" }],
        usage: { model: "claude-sonnet-4" },
      },
      { role: "user", content: [{ type: "text", text: "fourth" }] },
    ]);

    await importAmp(db, ampDir, "tester");

    const sourceIds = getRows()
      .map((row) => row.source_id)
      .sort();
    expect(sourceIds).toEqual(
      [
        "thread-mixed:1",
        "thread-mixed:idx:1",
        "thread-mixed:2",
        "thread-mixed:idx:3",
      ].sort(),
    );
  });

  it("keeps existing rows unchanged by default when source IDs collide", async () => {
    await writeThreadMessages(
      "thread-duplicate",
      [
        {
          role: "assistant",
          messageId: 1,
          content: [{ type: "text", text: "original" }],
          meta: { sentAt: threadCreated },
          usage: { model: "claude-sonnet-4" },
        },
      ],
      { title: "Original title" },
    );
    await importAmp(db, ampDir, "tester");

    await writeThreadMessages(
      "thread-duplicate",
      [
        {
          role: "assistant",
          messageId: 1,
          content: [{ type: "text", text: "changed" }],
          meta: { sentAt: threadCreated + 60_000 },
          usage: { model: "claude-opus-4" },
        },
      ],
      { title: "Changed title" },
    );

    const stats = await importAmp(db, ampDir, "tester");

    expect(stats.messages).toBe(0);
    expect(stats.refreshed).toBe(0);
    expect(stats.skipped).toBe(1);
    const row = getRow("thread-duplicate:1");
    expect(row).toBeDefined();
    expect(row!.title).toBe("Original title");
    expect(row!.content).toBe("original");
    expect(row!.timestamp).toBe(new Date(threadCreated).toISOString());
    expect(getPeople(row!)).toEqual(["amp:claude-sonnet-4", "amp:tester"]);
  });


  it("updates normalized columns and raw_data when updateExisting is enabled", async () => {
    await writeThreadMessages(
      "thread-update",
      [
        {
          role: "assistant",
          messageId: 1,
          content: [{ type: "text", text: "draft answer" }],
          meta: { sentAt: threadCreated },
          agentMode: "plan",
          usage: { model: "claude-sonnet-4" },
        },
      ],
      { title: "Draft title", workspaceRoots: ["/tmp/old-project"] },
    );
    await importAmp(db, ampDir, "tester");

    // Simulate a row imported before conversation_id existed.
    db.run("UPDATE events SET conversation_id = NULL WHERE source = 'amp'");

    await writeThreadMessages(
      "thread-update",
      [
        {
          role: "assistant",
          messageId: 1,
          content: [
            { type: "text", text: "complete answer" },
            {
              type: "tool_result",
              toolUseID: "use_1",
              run: { status: "success", result: "done" },
            },
          ],
          meta: { sentAt: threadCreated + 60_000 },
          agentMode: "build",
          usage: { model: "claude-opus-4" },
        },
      ],
      { title: "Complete title", workspaceRoots: ["/tmp/new-project"] },
    );

    const stats = await importAmp(db, ampDir, "tester", {
      updateExisting: true,
    });

    expect(stats.messages).toBe(0);
    expect(stats.refreshed).toBe(1);
    expect(stats.skipped).toBe(0);
    const row = getRow("thread-update:1");
    expect(row).toBeDefined();
    expect(row!.title).toBe("Complete title");
    expect(row!.content).toBe("complete answer");
    expect(row!.timestamp).toBe(
      new Date(threadCreated + 60_000).toISOString(),
    );
    expect(row!.conversation_id).toBe("thread-update");
    expect(getPeople(row!)).toEqual(["amp:claude-opus-4", "amp:tester"]);
    expect(getTags(row!)).toEqual([
      "editor:amp",
      "project:new-project",
      "model:claude-opus-4",
      "mode:build",
    ]);

    const raw = JSON.parse(row!.raw_data);
    expect(raw.workspace.project_name).toBe("new-project");
    expect(raw.message_metadata.agentMode).toBe("build");
    expect(raw.source_content).toEqual([
      { type: "text", text: "complete answer" },
      {
        type: "tool_result",
        toolUseID: "use_1",
        run: { status: "success", result: "done" },
      },
    ]);
    expect(raw.content).toEqual([
      { type: "text", text: "complete answer" },
      { type: "tool_result", tool_use_id: "use_1", content: "done" },
    ]);
  });

  it("preserves the original Amp block shape in raw_data.source_content", async () => {
    const original: AmpContentBlock[] = [
      { type: "text", text: "running a command" },
      {
        type: "tool_use",
        name: "Bash",
        id: "use_1",
        input: { command: "ls" },
      },
      {
        type: "tool_result",
        toolUseID: "use_1",
        run: { status: "success", result: { stdout: "file.txt", exitCode: 0 } },
      },
    ];
    await writeThread("thread-a", original);

    await importAmp(db, ampDir, "tester");

    const row = getRow("thread-a:1");
    expect(row).toBeDefined();
    const raw = JSON.parse(row!.raw_data);
    // source_content round-trips Amp's native shape verbatim, including
    // run.status, non-string run.result, and the camelCase toolUseID.
    expect(raw.source_content).toEqual(original);
    // Normalized content stays standardized for consumers.
    expect(raw.content[2]).toEqual({
      type: "tool_result",
      tool_use_id: "use_1",
      content: '{"stdout":"file.txt","exitCode":0}',
    });
  });

  it("normalizes image and summary blocks through the import path", async () => {
    await writeThreadMessages("thread-blocks", [
      {
        role: "user",
        messageId: 1,
        content: [
          { type: "text", text: "look at this" },
          {
            type: "image",
            source: { type: "base64", mediaType: "image/png", data: "QUJD" },
          },
        ],
      },
      {
        role: "assistant",
        messageId: 2,
        content: [
          {
            type: "summary",
            summary: { type: "message", summary: "Alice asked about the build." },
          },
        ],
        usage: { model: "claude-sonnet-4" },
      },
    ]);

    await importAmp(db, ampDir, "tester");

    const userRow = getRow("thread-blocks:1");
    expect(userRow).toBeDefined();
    // The text still surfaces; the image adds no FTS text but is normalized.
    expect(userRow!.content).toBe("look at this");
    const userRaw = JSON.parse(userRow!.raw_data);
    expect(userRaw.content).toEqual([
      { type: "text", text: "look at this" },
      { type: "image", media_type: "image/png" },
    ]);
    // Base64 bytes are not duplicated into the normalized block but remain in
    // source_content for reprocessing.
    expect(userRaw.content[1].data).toBeUndefined();
    expect(userRaw.source_content[1].source.data).toBe("QUJD");

    const summaryRow = getRow("thread-blocks:2");
    expect(summaryRow).toBeDefined();
    // Summary text is visible content, so it lands in the content column.
    expect(summaryRow!.content).toBe("Alice asked about the build.");
    const summaryRaw = JSON.parse(summaryRow!.raw_data);
    expect(summaryRaw.content).toEqual([
      {
        type: "summary",
        summary_type: "message",
        text: "Alice asked about the build.",
      },
    ]);
  });

  it("preserves thread and message metadata in raw_data", async () => {
    const threadUsageLedger = {
      total: { credits: 1.25 },
      events: [{ timestamp: threadCreated + 1000, messageId: 1 }],
    };
    const relationships = [
      { type: "fork", threadId: "thread-related", messageIndex: 0 },
    ];
    const userState = {
      currentlyVisibleFiles: ["src/platforms/amp/parser.ts"],
      runningTerminalCommands: ["bun test src/platforms/amp/parser.test.ts"],
    };
    const fileMentions = {
      "src/platforms/amp/parser.ts": { startLine: 1, endLine: 20 },
    };
    const threadMentions = [{ threadId: "thread-related" }];
    const messageState = { type: "complete", stopReason: "end_turn" };
    const messageUsage = {
      model: "claude-sonnet-4",
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 10,
      totalInputTokens: 115,
      credits: 0.3,
    };

    await writeThreadMessages(
      "thread-metadata",
      [
        {
          role: "assistant",
          messageId: 1,
          content: [{ type: "text", text: "hello" }],
          meta: { sentAt: threadCreated },
          userState,
          agentMode: "plan",
          state: messageState,
          usage: messageUsage,
          originalToolUseInput: { command: "bun test" },
          fileMentions,
          threadMentions,
          turnElapsedMs: 1234,
          interrupted: true,
        },
      ],
      {
        metadata: {
          nextMessageId: 2,
          agentMode: "plan",
          usageLedger: threadUsageLedger,
          relationships,
          originThreadID: "thread-origin",
          forkPointIndex: 0,
          forkThreads: { "thread-related": { messageIndex: 0 } },
          mainThreadID: "thread-main",
          archived: true,
          meta: { pinned: true },
          summaryThreads: [{ threadId: "thread-summary" }],
          "~debug": { verboseState: "omitted" },
        },
      }
    );

    await importAmp(db, ampDir, "tester");

    const row = getRow("thread-metadata:1");
    expect(row).toBeDefined();
    const raw = JSON.parse(row!.raw_data);
    expect(raw.thread_metadata).toEqual({
      v: 1,
      id: "thread-metadata",
      created: threadCreated,
      title: "fixture thread",
      workspaceRoots: ["/tmp/project"],
      nextMessageId: 2,
      agentMode: "plan",
      usageLedger: threadUsageLedger,
      relationships,
      originThreadID: "thread-origin",
      forkPointIndex: 0,
      forkThreads: { "thread-related": { messageIndex: 0 } },
      mainThreadID: "thread-main",
      archived: true,
      meta: { pinned: true },
      summaryThreads: [{ threadId: "thread-summary" }],
    });
    expect(raw.thread_metadata.messages).toBeUndefined();
    expect(raw.thread_metadata["~debug"]).toBeUndefined();
    expect(raw.message_metadata).toEqual({
      role: "assistant",
      messageId: 1,
      meta: { sentAt: threadCreated },
      userState,
      agentMode: "plan",
      state: messageState,
      usage: messageUsage,
      originalToolUseInput: { command: "bun test" },
      fileMentions,
      threadMentions,
      turnElapsedMs: 1234,
      interrupted: true,
    });
    expect(raw.message_metadata.content).toBeUndefined();
    expect(raw.source_content).toEqual([{ type: "text", text: "hello" }]);
  });

  it.each([
    {
      name: "prefers workspaceRoots over env when deriving project tags",
      thread: "thread-workspace-roots",
      options: {
        workspaceRoots: ["/tmp/from-workspace-roots"],
        env: {
          initial: {
            trees: [
              {
                displayName: "from-env",
                fsPath: "/tmp/from-env-path",
              },
            ],
          },
        },
      },
      check: (row: EventRow) => {
        const raw = JSON.parse(row.raw_data);
        expect(getTags(row!)).toContain("project:from-workspace-roots");

        expect(raw.workspace.project_name).toBe("from-workspace-roots");
        expect(raw.workspace.project_source).toBe("workspace_roots");
        expect(raw.workspace.project_path).toBe("/tmp/from-workspace-roots");
        expect(raw.workspace.display_name).toBe("from-env");
        expect(raw.workspace.fs_path).toBe("/tmp/from-env-path");
      },
    },
    {
      name: "derives project tags from env tree displayName without workspaceRoots",
      thread: "thread-env-display",
      options: {
        workspaceRoots: null,
        env: {
          initial: {
            trees: [
              {
                displayName: "timeline",
                fsPath: "/Users/alice/Developer/timeline",
              },
            ],
          },
        },
      },
      check: (row: EventRow) => {
        const raw = JSON.parse(row.raw_data);
        expect(getTags(row!)).toContain("project:timeline");

        expect(raw.workspace_roots).toBeUndefined();
        expect(raw.workspace.project_name).toBe("timeline");
        expect(raw.workspace.project_source).toBe("env.initial.trees[0].displayName");
        expect(raw.workspace.display_name).toBe("timeline");
        expect(raw.workspace.fs_path).toBe("/Users/alice/Developer/timeline");
      },
    },
    {
      name: "falls back to env tree fsPath basename for project tags",
      thread: "thread-env-fspath",
      options: {
        workspaceRoots: null,
        env: {
          initial: {
            trees: [{ fsPath: "/Users/alice/Developer/timeline" }],
          },
        },
      },
      check: (row: EventRow) => {
        const raw = JSON.parse(row.raw_data);
        expect(getTags(row!)).toContain("project:timeline");

        expect(raw.workspace.project_name).toBe("timeline");
        expect(raw.workspace.project_source).toBe("env.initial.trees[0].fsPath");
        expect(raw.workspace.project_path).toBe("/Users/alice/Developer/timeline");
      },
    },
    {
      name: "falls back to env tree uri basename for project tags",
      thread: "thread-env-uri",
      options: {
        workspaceRoots: null,
        env: {
          initial: {
            trees: [{ uri: "file:///Users/alice/Developer/timeline" }],
          },
        },
      },
      check: (row: EventRow) => {
        const raw = JSON.parse(row.raw_data);
        expect(getTags(row!)).toContain("project:timeline");

        expect(raw.workspace.project_name).toBe("timeline");
        expect(raw.workspace.project_source).toBe("env.initial.trees[0].uri");
        expect(raw.workspace.project_path).toBe("/Users/alice/Developer/timeline");
        expect(raw.workspace.uri).toBe("file:///Users/alice/Developer/timeline");
      },
    },
    {
      name: "falls back to env systemPromptData workingDirectory for project tags",
      thread: "thread-env-working-directory",
      options: {
        workspaceRoots: null,
        env: {
          systemPromptData: {
            workingDirectory: "/Users/alice/Developer/timeline",
          },
        },
      },
      check: (row: EventRow) => {
        const raw = JSON.parse(row.raw_data);
        expect(getTags(row!)).toContain("project:timeline");

        expect(raw.workspace.project_name).toBe("timeline");
        expect(raw.workspace.project_source).toBe("env.systemPromptData.workingDirectory");
        expect(raw.workspace.project_path).toBe("/Users/alice/Developer/timeline");
        expect(raw.workspace.working_directory).toBe("/Users/alice/Developer/timeline");
      },
    },
  ])("$name", async ({ thread, options, check }) => {
    await writeThreadMessages(
      thread,
      [{ role: "user", messageId: 1, content: [{ type: "text", text: "hello" }] }],
      options,
    );
    await importAmp(db, ampDir, "tester");
    const row = getRow(`${thread}:1`);
    expect(row).toBeDefined();
    check(row!);
  });

  it("does not emit project:unknown when no project can be derived", async () => {
    await writeThreadMessages(
      "thread-no-project",
      [
        {
          role: "user",
          messageId: 1,
          content: [{ type: "text", text: "hello" }],
        },
      ],
      { title: null, workspaceRoots: null }
    );

    await importAmp(db, ampDir, "tester");

    const row = getRow("thread-no-project:1");
    expect(row).toBeDefined();
    expect(row!.title).toBe("thread-no-project");
    expect(getTags(row!)).toEqual(["editor:amp"]);

    const raw = JSON.parse(row!.raw_data);
    expect(raw.workspace_roots).toBeUndefined();
    expect(raw.workspace).toBeUndefined();
  });

  describe("timestamp precedence", () => {
    const sentAt = Date.UTC(2026, 5, 1, 12, 0, 0);
    const usageTs = "2026-06-02T08:30:00.000Z";

    it.each([
      {
        name: "prefers meta.sentAt over assistant usage.timestamp",
        thread: "thread-ts-sentat",
        message: {
          role: "assistant",
          messageId: 5,
          content: [{ type: "text", text: "hi" }],
          meta: { sentAt },
          usage: { model: "claude-sonnet-4", timestamp: usageTs },
        },
        expected: new Date(sentAt).toISOString(),
      },
      {
        name: "uses assistant usage.timestamp when meta.sentAt is absent",
        thread: "thread-ts-usage",
        message: {
          role: "assistant",
          messageId: 5,
          content: [{ type: "text", text: "hi" }],
          usage: { model: "claude-sonnet-4", timestamp: usageTs },
        },
        expected: new Date(usageTs).toISOString(),
      },
      {
        name: "ignores usage.timestamp for user messages and falls back",
        thread: "thread-ts-user",
        message: {
          role: "user",
          messageId: 3,
          content: [{ type: "text", text: "hi" }],
          usage: { timestamp: usageTs },
        },
        expected: new Date(threadCreated + 3000).toISOString(),
      },
      {
        name: "falls back when assistant usage.timestamp is unparseable",
        thread: "thread-ts-invalid-usage",
        message: {
          role: "assistant",
          messageId: 4,
          content: [{ type: "text", text: "hi" }],
          usage: { model: "claude-sonnet-4", timestamp: "not-a-date" },
        },
        expected: new Date(threadCreated + 4000).toISOString(),
      },
      {
        name: "falls back when assistant usage.timestamp is not a string",
        thread: "thread-ts-non-string-usage",
        message: {
          role: "assistant",
          messageId: 7,
          content: [{ type: "text", text: "hi" }],
          usage: { model: "claude-sonnet-4", timestamp: 123 },
        },
        expected: new Date(threadCreated + 7000).toISOString(),
      },
      {
        name: "falls back when meta.sentAt is not a valid date",
        thread: "thread-ts-invalid-sentat",
        message: {
          role: "assistant",
          messageId: 2,
          content: [{ type: "text", text: "hi" }],
          meta: { sentAt: Number.NaN },
          usage: { model: "claude-sonnet-4" },
        },
        expected: new Date(threadCreated + 2000).toISOString(),
      },
      {
        name: "falls back to thread order when no reliable timestamp exists",
        thread: "thread-ts-fallback",
        message: {
          role: "assistant",
          messageId: 6,
          content: [{ type: "text", text: "hi" }],
          usage: { model: "claude-sonnet-4" },
        },
        expected: new Date(threadCreated + 6000).toISOString(),
      },
    ])("$name", async ({ thread, message, expected }) => {
      await writeThreadMessages(thread, [message as AmpFixtureMessage]);
      await importAmp(db, ampDir, "tester");
      expect(getRow(`${thread}:${message.messageId}`)?.timestamp).toBe(expected);
    });
  });
});
