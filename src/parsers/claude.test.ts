import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { initDb } from "../db/schema";
import { importClaudeExport } from "./claude";

interface EventRow {
  source_id: string;
  type: string;
  content: string;
  raw_data: string;
  timestamp: string;
}

interface FixtureMessage {
  uuid: string;
  text?: string;
  sender: "human" | "assistant";
  created_at: string;
  content?: unknown;
  attachments?: unknown[];
  files?: unknown[];
}

interface FixtureConversation {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
  chat_messages: FixtureMessage[];
}

interface FixtureMemory {
  conversations_memory?: string;
  key_facts?: string[];
  updated_at?: string;
}

async function buildExportZip(
  fixtureDir: string,
  conversations: FixtureConversation[],
  memories?: FixtureMemory[]
): Promise<string> {
  const stageDir = join(fixtureDir, `stage-${randomUUID()}`);
  await mkdir(stageDir, { recursive: true });
  await writeFile(
    join(stageDir, "conversations.json"),
    JSON.stringify(conversations)
  );
  if (memories) {
    await writeFile(
      join(stageDir, "memories.json"),
      JSON.stringify(memories)
    );
  }

  const zipPath = join(fixtureDir, `export-${randomUUID()}.zip`);
  const proc = Bun.spawn(
    ["zip", "-q", "-j", zipPath, join(stageDir, "conversations.json")].concat(
      memories ? [join(stageDir, "memories.json")] : []
    )
  );
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`zip failed: exit ${proc.exitCode}`);
  }
  return zipPath;
}

describe("importClaudeExport", () => {
  let db: Database;
  let fixtureDir: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);

    fixtureDir = join(tmpdir(), `claude-fixture-${randomUUID()}`);
    await mkdir(fixtureDir, { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  function getRow(sourceId: string): EventRow | undefined {
    return db
      .prepare(
        "SELECT source_id, type, content, raw_data, timestamp FROM events WHERE source = 'claude' AND source_id = ?"
      )
      .get(sourceId) as EventRow | undefined;
  }

  it("stores extracted text in content and structured blocks in raw_data", async () => {
    const blocks = [
      { type: "thinking", thinking: "Reasoning about the question." },
      { type: "text", text: "Here is my answer." },
      { type: "text", text: "With a follow-up." },
    ];
    const zipPath = await buildExportZip(fixtureDir, [
      {
        uuid: "conv-1",
        name: "Test conversation",
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
        chat_messages: [
          {
            uuid: "msg-1",
            sender: "assistant",
            created_at: "2026-04-01T00:00:00.000Z",
            content: blocks,
          },
        ],
      },
    ]);

    await importClaudeExport(db, zipPath, "tester");

    const row = getRow("conv-1:msg-1");
    expect(row).toBeDefined();
    expect(row?.type).toBe("claude:message:assistant");
    expect(row?.content).toBe("Here is my answer.\n\nWith a follow-up.");

    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual(blocks);
    expect(raw.conversation_uuid).toBe("conv-1");
    expect(raw.sender).toBe("assistant");
  });

  it("imports content blocks with explicit null optional fields", async () => {
    const zipPath = await buildExportZip(fixtureDir, [
      {
        uuid: "conv-null-fields",
        name: "Nullable fields",
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
        chat_messages: [
          {
            uuid: "msg-null-fields",
            sender: "assistant",
            created_at: "2026-04-01T00:00:00.000Z",
            content: [
              {
                type: "tool_use",
                name: "Web Fetch",
                id: null,
                message: null,
                integration_name: null,
                integration_icon_url: null,
                input: { url: "https://example.com" },
              },
              {
                type: "tool_result",
                tool_use_id: null,
                content: "ok",
              },
              {
                type: "flag",
                flag: null,
                helpline: {
                  name: "Support",
                  url: null,
                  web_chat_url: null,
                },
              },
              { type: "text", text: "Visible answer." },
            ],
          },
        ],
      },
    ]);

    await importClaudeExport(db, zipPath, "tester");

    const row = getRow("conv-null-fields:msg-null-fields");
    expect(row).toBeDefined();
    expect(row?.content).toBe("Visible answer.");

    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toHaveLength(4);
    expect(raw.content[0].id).toBeUndefined();
    expect(raw.content[0].message).toBeUndefined();
    expect(raw.content[0].integration_name).toBeUndefined();
    expect(raw.content[0].integration_icon_url).toBeUndefined();
    expect(raw.content[1].tool_use_id).toBeUndefined();
    expect(raw.content[2].flag).toBeUndefined();
    expect(raw.content[2].helpline.url).toBeUndefined();
    expect(raw.content[2].helpline.web_chat_url).toBeUndefined();
  });

  it("imports malformed content blocks instead of dropping the message", async () => {
    const zipPath = await buildExportZip(fixtureDir, [
      {
        uuid: "conv-malformed-block",
        name: "Malformed block",
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z",
        chat_messages: [
          {
            uuid: "msg-malformed-block",
            sender: "assistant",
            created_at: "2026-04-01T00:00:00.000Z",
            content: [
              { text: "missing type" },
              { type: "text", text: "Visible answer." },
            ],
          },
        ],
      },
    ]);

    await importClaudeExport(db, zipPath, "tester");

    const row = getRow("conv-malformed-block:msg-malformed-block");
    expect(row).toBeDefined();
    expect(row?.content).toBe("Visible answer.");

    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual([
      { type: "unknown", raw: { text: "missing type" } },
      { type: "text", text: "Visible answer." },
    ]);
  });

  it("wraps a plain-string msg.text into a single text block when content is absent", async () => {
    const zipPath = await buildExportZip(fixtureDir, [
      {
        uuid: "conv-2",
        name: "String-only",
        created_at: "2026-04-02T00:00:00.000Z",
        updated_at: "2026-04-02T00:00:00.000Z",
        chat_messages: [
          {
            uuid: "msg-str",
            sender: "human",
            created_at: "2026-04-02T00:00:00.000Z",
            text: "just a string message",
          },
        ],
      },
    ]);

    await importClaudeExport(db, zipPath, "tester");

    const row = getRow("conv-2:msg-str");
    expect(row?.type).toBe("claude:message:user");
    expect(row?.content).toBe("just a string message");
    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual([
      { type: "text", text: "just a string message" },
    ]);
  });

  it("does not overwrite existing rows on default re-import", async () => {
    const first = await buildExportZip(fixtureDir, [
      {
        uuid: "conv-3",
        name: "Stable",
        created_at: "2026-04-03T00:00:00.000Z",
        updated_at: "2026-04-03T00:00:00.000Z",
        chat_messages: [
          {
            uuid: "msg-1",
            sender: "assistant",
            created_at: "2026-04-03T00:00:00.000Z",
            content: [{ type: "text", text: "first" }],
          },
        ],
      },
    ]);
    await importClaudeExport(db, first, "tester");

    const second = await buildExportZip(fixtureDir, [
      {
        uuid: "conv-3",
        name: "Stable",
        created_at: "2026-04-03T00:00:00.000Z",
        updated_at: "2026-04-03T00:00:00.000Z",
        chat_messages: [
          {
            uuid: "msg-1",
            sender: "assistant",
            created_at: "2026-04-03T00:00:00.000Z",
            content: [{ type: "text", text: "second (updated)" }],
          },
        ],
      },
    ]);
    await importClaudeExport(db, second, "tester");

    const row = getRow("conv-3:msg-1");
    expect(row?.content).toBe("first");
    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual([{ type: "text", text: "first" }]);
  });

  it("--refresh-raw-data rewrites content + raw_data for existing rows", async () => {
    const first = await buildExportZip(fixtureDir, [
      {
        uuid: "conv-4",
        name: "Refresh target",
        created_at: "2026-04-04T00:00:00.000Z",
        updated_at: "2026-04-04T00:00:00.000Z",
        chat_messages: [
          {
            uuid: "msg-1",
            sender: "assistant",
            created_at: "2026-04-04T00:00:00.000Z",
            content: [{ type: "text", text: "first" }],
          },
        ],
      },
    ]);
    await importClaudeExport(db, first, "tester");

    const updatedBlocks = [
      { type: "thinking", thinking: "A new reasoning trace." },
      { type: "text", text: "refreshed answer" },
    ];
    const second = await buildExportZip(fixtureDir, [
      {
        uuid: "conv-4",
        name: "Refresh target",
        created_at: "2026-04-04T00:00:00.000Z",
        updated_at: "2026-04-04T00:00:00.000Z",
        chat_messages: [
          {
            uuid: "msg-1",
            sender: "assistant",
            created_at: "2026-04-04T00:00:00.000Z",
            content: updatedBlocks,
          },
        ],
      },
    ]);
    await importClaudeExport(db, second, "tester", { refreshRawData: true });

    const row = getRow("conv-4:msg-1");
    expect(row?.content).toBe("refreshed answer");
    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual(updatedBlocks);
    expect(row?.timestamp).toBe("2026-04-04T00:00:00.000Z");
  });

  it("preserves flag blocks and emits has-safety-flag tag", async () => {
    const blocks = [
      {
        type: "flag",
        flag: "self_harm_risk",
        helpline: {
          name: "Example Helpline",
          phone_number: "000 000",
        },
      },
      { type: "text", text: "Please consider reaching out." },
    ];
    const zipPath = await buildExportZip(fixtureDir, [
      {
        uuid: "conv-flag",
        name: "Flag test",
        created_at: "2026-04-10T00:00:00.000Z",
        updated_at: "2026-04-10T00:00:00.000Z",
        chat_messages: [
          {
            uuid: "msg-flag",
            sender: "assistant",
            created_at: "2026-04-10T00:00:00.000Z",
            content: blocks,
          },
        ],
      },
    ]);

    await importClaudeExport(db, zipPath, "tester");

    const row = db
      .prepare(
        "SELECT content, raw_data, tags FROM events WHERE source = 'claude' AND source_id = ?"
      )
      .get("conv-flag:msg-flag") as
      | { content: string; raw_data: string; tags: string | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.content).toBe("Please consider reaching out.");
    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual(blocks);
    const tags = JSON.parse(row!.tags ?? "[]");
    expect(tags).toContain("safety:flag");
    expect(tags).toContain("editor:claude");
  });

  it("preserves thinking summaries round-trip in raw_data", async () => {
    const blocks = [
      {
        type: "thinking",
        thinking: "Long trace of reasoning steps.",
        summaries: [
          { summary: "Considering the user's question" },
          { summary: "Finalizing the answer" },
        ],
      },
      { type: "text", text: "Here." },
    ];
    const zipPath = await buildExportZip(fixtureDir, [
      {
        uuid: "conv-sum",
        name: "Summaries test",
        created_at: "2026-04-11T00:00:00.000Z",
        updated_at: "2026-04-11T00:00:00.000Z",
        chat_messages: [
          {
            uuid: "msg-sum",
            sender: "assistant",
            created_at: "2026-04-11T00:00:00.000Z",
            content: blocks,
          },
        ],
      },
    ]);

    await importClaudeExport(db, zipPath, "tester");

    const row = getRow("conv-sum:msg-sum");
    expect(row).toBeDefined();
    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual(blocks);
  });

  it("preserves text-block citations round-trip in raw_data", async () => {
    const blocks = [
      {
        type: "text",
        text: "According to the docs, X is true.",
        citations: [
          {
            url: "https://example.com/doc",
            title: "Example Docs",
            cited_text: "X is true",
            start_index: 20,
            end_index: 29,
          },
        ],
      },
    ];
    const zipPath = await buildExportZip(fixtureDir, [
      {
        uuid: "conv-cite",
        name: "Citations test",
        created_at: "2026-04-12T00:00:00.000Z",
        updated_at: "2026-04-12T00:00:00.000Z",
        chat_messages: [
          {
            uuid: "msg-cite",
            sender: "assistant",
            created_at: "2026-04-12T00:00:00.000Z",
            content: blocks,
          },
        ],
      },
    ]);

    await importClaudeExport(db, zipPath, "tester");

    const row = getRow("conv-cite:msg-cite");
    expect(row).toBeDefined();
    const raw = JSON.parse(row!.raw_data);
    expect(raw.content).toEqual(blocks);
  });

  it("imports memory entries as claude:memory events", async () => {
    const zipPath = await buildExportZip(
      fixtureDir,
      [],
      [
        {
          conversations_memory: "User prefers concise answers.",
          key_facts: ["Fact one", "Fact two"],
          updated_at: "2026-04-05T00:00:00.000Z",
        },
      ]
    );

    await importClaudeExport(db, zipPath, "tester");

    const row = getRow("memory:0");
    expect(row?.type).toBe("claude:memory");
    expect(row?.content).toContain("User prefers concise answers.");
    expect(row?.content).toContain("- Fact one");
    const raw = JSON.parse(row!.raw_data);
    expect(raw.conversations_memory).toBe("User prefers concise answers.");
    expect(raw.key_facts).toEqual(["Fact one", "Fact two"]);
  });
});
