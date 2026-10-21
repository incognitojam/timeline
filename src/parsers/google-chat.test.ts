import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { initDb } from "../db/schema";
import { importChatData } from "./google-chat";

describe("google-chat parser", () => {
  let db: Database;
  let fixtureDir: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);

    fixtureDir = join(tmpdir(), `google-chat-fixture-${randomUUID()}`);
    await mkdir(fixtureDir, { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  function getRows(): { source_id: string; title: string; conversation_id: string | null }[] {
    return db
      .prepare(
        "SELECT source_id, title, conversation_id FROM events WHERE source = 'google-chat' ORDER BY source_id",
      )
      .all() as { source_id: string; title: string; conversation_id: string | null }[];
  }

  it("keys group messages on the space id segment of message_id", async () => {
    const spaceDir = join(fixtureDir, "Groups", "Space AAAAexample1");
    await mkdir(spaceDir, { recursive: true });
    await writeFile(
      join(spaceDir, "group_info.json"),
      JSON.stringify({
        name: "Study Group",
        members: [
          { name: "Alice Example", email: "alice@example.com", user_type: "Human" },
          { name: "Bob Example", email: "bob@example.com", user_type: "Human" },
        ],
      }),
    );
    await writeFile(
      join(spaceDir, "messages.json"),
      JSON.stringify({
        messages: [
          {
            creator: { name: "Alice Example", email: "alice@example.com", user_type: "Human" },
            created_date: "Friday, 21 May 2021 at 14:41:21 UTC",
            text: "hello group",
            topic_id: "TopicExample1",
            message_id: "AAAAexample1/TopicExample1/MsgExample1",
          },
        ],
      }),
    );

    await importChatData(db, fixtureDir, "tester");

    expect(getRows()).toEqual([
      {
        source_id: "AAAAexample1/TopicExample1/MsgExample1",
        title: "Study Group",
        conversation_id: "AAAAexample1",
      },
    ]);
  });

  it("keys DM messages on the space id segment of message_id", async () => {
    const userDir = join(fixtureDir, "Users", "Bob Example");
    await mkdir(userDir, { recursive: true });
    await writeFile(
      join(userDir, "user_info.json"),
      JSON.stringify({ name: "Bob Example", email: "bob@example.com" }),
    );
    await writeFile(
      join(userDir, "messages.json"),
      JSON.stringify({
        messages: [
          {
            creator: { name: "Bob Example", email: "bob@example.com", user_type: "Human" },
            created_date: "Friday, 21 May 2021 at 15:00:00 UTC",
            text: "hello dm",
            topic_id: "TopicExample2",
            message_id: "BBBBexample2/TopicExample2/MsgExample2",
          },
        ],
      }),
    );

    await importChatData(db, fixtureDir, "tester");

    expect(getRows()).toEqual([
      {
        source_id: "BBBBexample2/TopicExample2/MsgExample2",
        title: "DM: Bob Example",
        conversation_id: "BBBBexample2",
      },
    ]);
  });
});
