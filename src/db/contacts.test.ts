/**
 * Tests for getContactAliasEventCounts: the scoped index-range lookup that
 * supplies manual "contact:N" event counts to listContacts.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { initDb } from "./schema";
import { wrapDatabase } from "./pool";
import { createContact, getContactAliasEventCounts, getContactConversations, listContacts, updateContact } from "./contacts";
import { upsertIdentity } from "./identities";

let db: Database;

function setup(): void {
  db = new Database(":memory:");
  initDb(db);
}

function teardown(): void {
  db.close();
}

function insertEvent(people: string[], source = "discord"): void {
  db.prepare(`
    INSERT INTO events (source, source_id, type, timestamp, people, raw_data)
    VALUES (?, ?, 'message:dm', '2024-01-01T00:00:00Z', ?, '{}')
  `).run(source, `test-${randomUUID()}`, JSON.stringify(people));
}

function linkDiscordIdentity(contactId: number, platformId: string): void {
  upsertIdentity(db, { platform: "discord", platformId, displayName: "Alice" });
  db.prepare("UPDATE identities SET contact_id = ? WHERE platform = 'discord' AND platform_id = ?")
    .run(contactId, platformId);
}

function insertConversationMessage(args: {
  sourceId: string;
  title: string;
  conversationId: string;
  timestamp: string;
  people: string[];
}): void {
  db.prepare(`
    INSERT INTO events (
      source, source_id, source_account, type, timestamp, title, content, people, raw_data, conversation_id
    ) VALUES (
      'discord', ?, 'tester', 'message:dm', ?, ?, 'hello', ?, '{}', ?
    )
  `).run(args.sourceId, args.timestamp, args.title, JSON.stringify(args.people), args.conversationId);
}

describe("getContactAliasEventCounts", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("returns only manual contact:N aliases, not platform aliases", async () => {
    insertEvent(["discord:alice"]);
    insertEvent(["contact:1"], "manual");
    insertEvent(["contact:1"], "manual");
    insertEvent(["contact:2"], "manual");

    const { counts } = await getContactAliasEventCounts(wrapDatabase(db));

    expect(counts["contact:1:manual"]).toBe(2);
    expect(counts["contact:2:manual"]).toBe(1);
    // Platform aliases are excluded — those count via identities.event_count instead
    expect(counts["discord:alice:discord"]).toBeUndefined();
  });

  test("excludes aliases that start with 'contact' but aren't contact:N", async () => {
    // Range bound is [contact:, contact;) — a different "contacts:" scheme must not leak in
    insertEvent(["contact:5"], "manual");
    insertEvent(["contacts:foo"], "other");

    const { counts } = await getContactAliasEventCounts(wrapDatabase(db));

    expect(counts["contact:5:manual"]).toBe(1);
    expect(counts["contacts:foo:other"]).toBeUndefined();
  });
});

describe("updateContact", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("rolls back self reassignment when the target update fails", () => {
    const aliceId = createContact(db, "Alice");
    const bobId = createContact(db, "Bob");
    updateContact(db, aliceId, { isSelf: true });
    db.exec(`
      CREATE TRIGGER fail_bob_self_update
      BEFORE UPDATE OF is_self ON contacts
      WHEN NEW.id = ${bobId} AND NEW.is_self = 1
      BEGIN
        SELECT RAISE(ABORT, 'forced target update failure');
      END
    `);

    expect(() => updateContact(db, bobId, { isSelf: true })).toThrow("forced target update failure");

    const contacts = db.prepare("SELECT id, is_self FROM contacts ORDER BY id").all();
    expect(contacts).toEqual([
      { id: aliceId, is_self: 1 },
      { id: bobId, is_self: 0 },
    ]);
  });
});

describe("listContacts", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("pins the self contact above the alphabetical ordering", async () => {
    createContact(db, "Alice");
    createContact(db, "Bob");
    const zaraId = createContact(db, "Zara");
    updateContact(db, zaraId, { isSelf: true });

    const contacts = await listContacts(wrapDatabase(db));

    expect(contacts.map(c => c.display_name)).toEqual(["Zara", "Alice", "Bob"]);
  });
});

describe("getContactConversations", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("returns conversationId and splits same-title threads", async () => {
    const contactId = createContact(db, "Alice");
    linkDiscordIdentity(contactId, "alice");

    insertConversationMessage({
      sourceId: "same-title-1",
      title: "General",
      conversationId: "channel-1",
      timestamp: "2026-01-01T00:00:00Z",
      people: ["discord:alice"],
    });
    insertConversationMessage({
      sourceId: "same-title-2",
      title: "General",
      conversationId: "channel-2",
      timestamp: "2026-01-02T00:00:00Z",
      people: ["discord:alice"],
    });

    const conversations = await getContactConversations(wrapDatabase(db), contactId);

    expect(conversations).toHaveLength(2);
    expect(conversations.map((conv) => conv.conversationId).sort()).toEqual(["channel-1", "channel-2"]);
    expect(conversations.map((conv) => conv.title)).toEqual(["General", "General"]);
  });
});
