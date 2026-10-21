import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { initDb } from "../db/schema";
import { decodeChatGPTConversations, importChatGPTExport } from "./chatgpt";

const validConversation = {
  id: "conversation-1",
  title: "Example conversation",
  create_time: 1_700_000_000,
  update_time: 1_700_000_001,
  mapping: {
    root: {
      id: "root",
      parent: null,
      children: ["message-1"],
    },
    "message-1": {
      id: "message-1",
      parent: "root",
      children: [],
      message: {
        id: "message-1",
        author: { role: "user", metadata: { ignored: true } },
        create_time: 1_700_000_000,
        content: {
          content_type: "text",
          parts: ["Hello", { ignored: true }],
        },
        metadata: { ignored: true },
      },
    },
  },
  ignored: true,
};

async function buildExportZip(
  fixtureDir: string,
  files: ReadonlyArray<{ name: string; conversations: ReadonlyArray<unknown> }>
): Promise<string> {
  const stageDir = join(fixtureDir, `stage-${randomUUID()}`);
  await mkdir(stageDir, { recursive: true });

  const paths: string[] = [];
  for (const file of files) {
    const path = join(stageDir, file.name);
    await writeFile(path, JSON.stringify(file.conversations));
    paths.push(path);
  }

  const zipPath = join(fixtureDir, `export-${randomUUID()}.zip`);
  const proc = Bun.spawn(["zip", "-q", "-j", zipPath, ...paths]);
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`zip failed: exit ${proc.exitCode}`);
  }
  return zipPath;
}

describe("decodeChatGPTConversations", () => {
  test("validates the export and strips unknown object properties", () => {
    const decoded = decodeChatGPTConversations([validConversation]);
    const conversation = decoded.conversations[0];

    expect(decoded.rejected).toEqual([]);
    expect(conversation).not.toHaveProperty("ignored");
    expect(conversation.mapping["message-1"].message?.author).toEqual({ role: "user" });
    expect(conversation.mapping["message-1"].message?.metadata).toEqual({});
    expect(conversation.mapping["message-1"].message?.content?.parts).toEqual([
      "Hello",
      { ignored: true },
    ]);
  });

  test("accepts nullable metadata and forward-compatible roles", () => {
    const decoded = decodeChatGPTConversations([
      {
        ...validConversation,
        default_model_slug: null,
        is_archived: null,
        is_starred: null,
        mapping: {
          message: {
            message: {
              id: "message-1",
              author: { role: "developer" },
              metadata: { model_slug: null, is_visually_hidden_from_conversation: null },
            },
          },
        },
      },
    ]);

    expect(decoded.rejected).toEqual([]);
    expect(decoded.conversations[0].default_model_slug).toBeNull();
    expect(decoded.conversations[0].mapping.message.message?.author.role).toBe("developer");
  });

  test("reports malformed conversations without rejecting valid siblings", () => {
    const decoded = decodeChatGPTConversations([
      { ...validConversation, create_time: "not-a-timestamp" },
      validConversation,
    ]);

    expect(decoded.conversations).toHaveLength(1);
    expect(decoded.rejected).toHaveLength(1);
    expect(decoded.rejected[0].index).toBe(0);
    expect(decoded.rejected[0].error).toContain("create_time");
  });

  test("rejects a malformed top-level value", () => {
    expect(() => decodeChatGPTConversations({ conversation: validConversation })).toThrow();
  });
});

describe("importChatGPTExport", () => {
  let db: Database;
  let fixtureDir: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);
    fixtureDir = join(tmpdir(), `chatgpt-fixture-${randomUUID()}`);
    await mkdir(fixtureDir, { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  test("imports numbered files and messages regardless of broken tree links", async () => {
    const disconnectedConversation = {
      ...validConversation,
      mapping: {
        falseRoot: { id: "false-root" },
        userMessage: {
          id: "user-message",
          parent: "missing-parent",
          message: {
            id: "user-message",
            author: { role: "user" },
            create_time: 1_700_000_000,
            content: { content_type: "text", parts: ["Imported user message"] },
          },
        },
        developerMessage: {
          id: "developer-message",
          message: {
            id: "developer-message",
            author: { role: "developer" },
            create_time: 1_700_000_001,
            content: { content_type: "text", parts: ["Internal instruction"] },
          },
        },
      },
      default_model_slug: null,
      is_starred: null,
    };
    const secondConversation = {
      ...validConversation,
      id: "conversation-2",
      mapping: {
        assistantMessage: {
          message: {
            id: "assistant-message",
            author: { role: "assistant" },
            create_time: 1_700_000_002,
            content: { text: "Imported assistant message" },
          },
        },
      },
    };
    const zipPath = await buildExportZip(fixtureDir, [
      { name: "conversations_2.json", conversations: [disconnectedConversation] },
      { name: "conversations (10).json", conversations: [secondConversation] },
    ]);

    const imported = await importChatGPTExport(db, zipPath, "alice@example.com");
    const rows = db
      .query("SELECT source_id, type, content FROM events WHERE source = 'chatgpt' ORDER BY timestamp")
      .all() as Array<{ source_id: string; type: string; content: string }>;

    expect(imported).toBe(2);
    expect(rows).toEqual([
      {
        source_id: "conversation-1:user-message",
        type: "chatgpt:message:user",
        content: "Imported user message",
      },
      {
        source_id: "conversation-2:assistant-message",
        type: "chatgpt:message:assistant",
        content: "Imported assistant message",
      },
    ]);
  });
});
