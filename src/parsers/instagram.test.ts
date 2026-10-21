import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initDb } from "../db/schema";
import { importInstagramData } from "./instagram";

describe("importInstagramData conversation_id", () => {
  let db: Database;
  let importDir: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);
    importDir = join(tmpdir(), `instagram-fixture-${randomUUID()}`);
    await mkdir(importDir, { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(importDir, { recursive: true, force: true });
  });

  it("stores the thread_path on every message row in a conversation", async () => {
    const convDir = join(importDir, "inbox", "alice_123456789");
    await mkdir(convDir, { recursive: true });
    await writeFile(
      join(convDir, "message_1.json"),
      JSON.stringify({
        title: "Alice",
        participants: [{ name: "Alice" }, { name: "Bob" }],
        thread_path: "inbox/alice_123456789",
        messages: [
          { sender_name: "Alice", timestamp_ms: 1700000000000, content: "Hello" },
          { sender_name: "Bob", timestamp_ms: 1700000060000, content: "Hi back" },
        ],
      }),
    );

    await importInstagramData(db, importDir, "test-account");

    const rows = db
      .prepare(
        "SELECT source_id, conversation_id FROM events WHERE source = 'instagram' ORDER BY timestamp",
      )
      .all() as Array<{ source_id: string; conversation_id: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].conversation_id).toBe("inbox/alice_123456789");
    expect(rows[1].conversation_id).toBe("inbox/alice_123456789");
  });

  it("synthesizes category/folder when the export omits thread_path", async () => {
    const convDir = join(importDir, "message_requests", "carol_987654321");
    await mkdir(convDir, { recursive: true });
    await writeFile(
      join(convDir, "message_1.json"),
      JSON.stringify({
        title: "Carol",
        participants: [{ name: "Carol" }, { name: "Bob" }],
        messages: [{ sender_name: "Carol", timestamp_ms: 1700000000000, content: "Hey" }],
      }),
    );

    await importInstagramData(db, importDir, "test-account");

    const row = db
      .prepare("SELECT conversation_id FROM events WHERE source = 'instagram'")
      .get() as { conversation_id: string | null };
    expect(row.conversation_id).toBe("message_requests/carol_987654321");
  });
});
