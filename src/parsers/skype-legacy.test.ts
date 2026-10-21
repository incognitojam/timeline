import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initDb } from "../db/schema";
import { importLegacySkypeData } from "./skype-legacy";

interface LegacyMessage {
  id: number;
  timestamp: number;
  author: string;
  from_dispname: string | null;
  dialog_partner: string | null;
  chatname: string | null;
  body_xml: string | null;
  type: number;
  convo_id: number;
}

describe("importLegacySkypeData", () => {
  let db: Database;
  let fixtureDir: string;
  let skypeDbPath: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    initDb(db);

    fixtureDir = join(tmpdir(), `skype-legacy-fixture-${randomUUID()}`);
    await mkdir(fixtureDir, { recursive: true });
    skypeDbPath = join(fixtureDir, "main.db");
  });

  afterEach(async () => {
    db.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  function writeLegacyDb(
    conversations: Array<{ id: number; displayname: string | null; identity: string }>,
    messages: LegacyMessage[],
  ) {
    const skypeDb = new Database(skypeDbPath, { create: true });
    skypeDb.run("CREATE TABLE Conversations (id INTEGER, displayname TEXT, identity TEXT)");
    skypeDb.run(
      `CREATE TABLE Messages (
        id INTEGER, timestamp INTEGER, author TEXT, from_dispname TEXT,
        dialog_partner TEXT, chatname TEXT, body_xml TEXT, type INTEGER, convo_id INTEGER
      )`,
    );
    const insertConv = skypeDb.prepare("INSERT INTO Conversations (id, displayname, identity) VALUES (?, ?, ?)");
    for (const conv of conversations) insertConv.run(conv.id, conv.displayname, conv.identity);
    const insertMsg = skypeDb.prepare(
      `INSERT INTO Messages (id, timestamp, author, from_dispname, dialog_partner, chatname, body_xml, type, convo_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const msg of messages) {
      insertMsg.run(
        msg.id,
        msg.timestamp,
        msg.author,
        msg.from_dispname,
        msg.dialog_partner,
        msg.chatname,
        msg.body_xml,
        msg.type,
        msg.convo_id,
      );
    }
    skypeDb.close();
  }

  function getRow(sourceId: string) {
    return db
      .prepare(
        "SELECT source_id, type, title, content, conversation_id FROM events WHERE source = 'skype' AND source_id = ?",
      )
      .get(sourceId) as
      | { source_id: string; type: string; title: string | null; content: string | null; conversation_id: string | null }
      | null;
  }

  it("stores 8:<dialog_partner> as conversation_id for DMs across session chatnames", async () => {
    writeLegacyDb(
      [{ id: 29, displayname: "Bob Example", identity: "bob" }],
      [
        {
          id: 1,
          timestamp: 1300000000,
          author: "alice",
          from_dispname: "Alice",
          dialog_partner: "bob",
          chatname: "#alice/$bob;1a2b3c4d5e6f7890",
          body_xml: "hello",
          type: 61,
          convo_id: 29,
        },
        {
          id: 2,
          timestamp: 1300000100,
          author: "bob",
          from_dispname: "Bob Example",
          dialog_partner: "bob",
          chatname: "#bob/$alice;fedcba9876543210",
          body_xml: "hi back",
          type: 61,
          convo_id: 29,
        },
      ],
    );

    await importLegacySkypeData(db, skypeDbPath, "alice");

    const first = getRow("legacy:1");
    const second = getRow("legacy:2");
    expect(first?.conversation_id).toBe("8:bob");
    expect(second?.conversation_id).toBe("8:bob");
    expect(first?.type).toBe("message:dm");
  });

  it("stores the chatname as conversation_id for group chats", async () => {
    writeLegacyDb(
      [{ id: 40, displayname: "Bob Example, Carol Example", identity: "#alice/$deadbeef12345678;aa11bb22cc33dd44" }],
      [
        {
          id: 3,
          timestamp: 1300000200,
          author: "carol",
          from_dispname: "Carol Example",
          dialog_partner: null,
          chatname: "#alice/$deadbeef12345678;aa11bb22cc33dd44",
          body_xml: "hey all",
          type: 61,
          convo_id: 40,
        },
      ],
    );

    await importLegacySkypeData(db, skypeDbPath, "alice");

    const row = getRow("legacy:3");
    expect(row?.type).toBe("message:group");
    expect(row?.conversation_id).toBe("#alice/$deadbeef12345678;aa11bb22cc33dd44");
  });

  it("skips rows with no conversation identity without crashing", async () => {
    writeLegacyDb(
      [{ id: 240, displayname: "Dana Example", identity: "dana" }],
      [
        {
          id: 4,
          timestamp: 1300000300,
          author: "dana",
          from_dispname: "Dana Example",
          dialog_partner: null,
          chatname: null,
          body_xml: "orphan row",
          type: 61,
          convo_id: 240,
        },
      ],
    );

    await importLegacySkypeData(db, skypeDbPath, "alice");

    const row = getRow("legacy:4");
    expect(row).toBeNull();
    const count = db.prepare("SELECT COUNT(*) as count FROM events WHERE source = 'skype'").get() as { count: number };
    expect(count.count).toBe(0);
  });
});
