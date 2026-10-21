/**
 * Tests for identities.event_count denormalized column
 *
 * Tests cover:
 * 1. Triggers increment/decrement event_count when event_people changes
 * 2. getUnlinkedIdentities() uses event_count correctly
 * 3. listSkippedIdentities() uses event_count correctly
 * 4. populateEventPeople() refreshes event_count for all identities
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initDb } from "./schema";
import {
  upsertIdentity,
  getUnlinkedIdentities,
  listSkippedIdentities,
  populateEventPeople,
  skipIdentity,
} from "./queries";
import { wrapDatabase } from "./pool";

let db: Database;

function setupTestDatabase(): void {
  db = new Database(":memory:");
  initDb(db);
}

function teardownTestDatabase(): void {
  db.close();
}

/**
 * Helper to insert test events with required fields
 */
function insertEvent(options: {
  source: string;
  type: string;
  timestamp?: string | null;
  title?: string;
  people?: string[] | null;
}): number {
  const stmt = db.prepare(`
    INSERT INTO events (source, source_id, type, timestamp, title, people, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    options.source,
    `test-${Date.now()}-${Math.random()}`,
    options.type,
    options.timestamp ?? null,
    options.title ?? null,
    options.people ? JSON.stringify(options.people) : null,
    "{}"
  );
  return Number(result.lastInsertRowid);
}

/**
 * Helper to get event_count for an identity
 */
function getEventCount(platform: string, platformId: string): number {
  const row = db
    .prepare("SELECT event_count FROM identities WHERE platform = ? AND platform_id = ?")
    .get(platform, platformId) as { event_count: number } | undefined;
  return row?.event_count ?? 0;
}

describe("identity event_count triggers", () => {
  beforeEach(setupTestDatabase);
  afterEach(teardownTestDatabase);

  test("event_count starts at 0 for new identity", () => {
    upsertIdentity(db, { platform: "discord", platformId: "123", displayName: "Alice" });

    expect(getEventCount("discord", "123")).toBe(0);
  });

  test("event_count increments when event is inserted with matching person", () => {
    upsertIdentity(db, { platform: "discord", platformId: "123", displayName: "Alice" });

    insertEvent({
      source: "discord",
      type: "message:dm",
      timestamp: "2024-01-01T12:00:00Z",
      people: ["discord:123"],
    });

    expect(getEventCount("discord", "123")).toBe(1);
  });

  test("event_count increments for each event with the person", () => {
    upsertIdentity(db, { platform: "discord", platformId: "123", displayName: "Alice" });

    insertEvent({ source: "discord", type: "message:dm", people: ["discord:123"] });
    insertEvent({ source: "discord", type: "message:dm", people: ["discord:123"] });
    insertEvent({ source: "discord", type: "message:dm", people: ["discord:123"] });

    expect(getEventCount("discord", "123")).toBe(3);
  });

  test("event_count decrements when event is deleted", () => {
    upsertIdentity(db, { platform: "discord", platformId: "123", displayName: "Alice" });

    const eventId = insertEvent({
      source: "discord",
      type: "message:dm",
      people: ["discord:123"],
    });

    expect(getEventCount("discord", "123")).toBe(1);

    db.prepare("DELETE FROM events WHERE id = ?").run(eventId);

    expect(getEventCount("discord", "123")).toBe(0);
  });

  test("event_count handles multiple people in same event", () => {
    upsertIdentity(db, { platform: "discord", platformId: "111", displayName: "Alice" });
    upsertIdentity(db, { platform: "discord", platformId: "222", displayName: "Bob" });

    insertEvent({
      source: "discord",
      type: "message:group",
      people: ["discord:111", "discord:222"],
    });

    expect(getEventCount("discord", "111")).toBe(1);
    expect(getEventCount("discord", "222")).toBe(1);
  });

  test("event_count unaffected by events without matching identity", () => {
    upsertIdentity(db, { platform: "discord", platformId: "123", displayName: "Alice" });

    // Insert event with different person
    insertEvent({
      source: "discord",
      type: "message:dm",
      people: ["discord:999"],
    });

    expect(getEventCount("discord", "123")).toBe(0);
  });

  test("event_count handles event updates correctly", () => {
    upsertIdentity(db, { platform: "discord", platformId: "111", displayName: "Alice" });
    upsertIdentity(db, { platform: "discord", platformId: "222", displayName: "Bob" });

    const eventId = insertEvent({
      source: "discord",
      type: "message:dm",
      people: ["discord:111"],
    });

    expect(getEventCount("discord", "111")).toBe(1);
    expect(getEventCount("discord", "222")).toBe(0);

    // Update event to change people
    db.prepare("UPDATE events SET people = ? WHERE id = ?").run(
      JSON.stringify(["discord:222"]),
      eventId
    );

    // After update, Alice should be 0 and Bob should be 1
    expect(getEventCount("discord", "111")).toBe(0);
    expect(getEventCount("discord", "222")).toBe(1);
  });

  test("event_count never goes negative (clamps to 0)", () => {
    upsertIdentity(db, { platform: "discord", platformId: "123", displayName: "Alice" });

    // Manually set event_count to 0 and try to decrement
    db.prepare("UPDATE identities SET event_count = 0 WHERE platform_id = ?").run("123");

    // Insert and delete an event for a DIFFERENT person to trigger delete on event_people
    // but the identity trigger should clamp to 0
    const eventId = insertEvent({
      source: "discord",
      type: "message:dm",
      people: ["discord:123"],
    });

    expect(getEventCount("discord", "123")).toBe(1);

    // Now manually corrupt the count to 0 and delete the event
    db.prepare("UPDATE identities SET event_count = 0 WHERE platform_id = ?").run("123");
    db.prepare("DELETE FROM events WHERE id = ?").run(eventId);

    // Should clamp to 0, not go to -1
    expect(getEventCount("discord", "123")).toBe(0);
  });

  test("identity created after event_people gets correct count", () => {
    // Insert events BEFORE creating the identity
    insertEvent({ source: "discord", type: "message:dm", people: ["discord:latecomer"] });
    insertEvent({ source: "discord", type: "message:dm", people: ["discord:latecomer"] });
    insertEvent({ source: "discord", type: "message:dm", people: ["discord:latecomer"] });

    // Now create the identity - trigger should initialize count from existing event_people
    upsertIdentity(db, { platform: "discord", platformId: "latecomer", displayName: "Late" });

    // Should have count of 3 from the pre-existing events
    expect(getEventCount("discord", "latecomer")).toBe(3);
  });
});

describe("getUnlinkedIdentities with event_count", () => {
  beforeEach(setupTestDatabase);
  afterEach(teardownTestDatabase);

  test("returns identities sorted by event_count descending", async () => {
    upsertIdentity(db, { platform: "discord", platformId: "low", displayName: "Low" });
    upsertIdentity(db, { platform: "discord", platformId: "high", displayName: "High" });
    upsertIdentity(db, { platform: "discord", platformId: "mid", displayName: "Mid" });

    // Insert events: High gets 5, Mid gets 3, Low gets 1
    for (let i = 0; i < 5; i++) {
      insertEvent({ source: "discord", type: "message:dm", people: ["discord:high"] });
    }
    for (let i = 0; i < 3; i++) {
      insertEvent({ source: "discord", type: "message:dm", people: ["discord:mid"] });
    }
    insertEvent({ source: "discord", type: "message:dm", people: ["discord:low"] });

    const unlinked = await getUnlinkedIdentities(wrapDatabase(db), { limit: 10 });

    expect(unlinked).toHaveLength(3);
    expect(unlinked[0].platformId).toBe("high");
    expect(unlinked[0].eventCount).toBe(5);
    expect(unlinked[1].platformId).toBe("mid");
    expect(unlinked[1].eventCount).toBe(3);
    expect(unlinked[2].platformId).toBe("low");
    expect(unlinked[2].eventCount).toBe(1);
  });

  test("excludes identities with event_count = 0", async () => {
    upsertIdentity(db, { platform: "discord", platformId: "active", displayName: "Active" });
    upsertIdentity(db, { platform: "discord", platformId: "inactive", displayName: "Inactive" });

    insertEvent({ source: "discord", type: "message:dm", people: ["discord:active"] });

    const unlinked = await getUnlinkedIdentities(wrapDatabase(db), { limit: 10 });

    expect(unlinked).toHaveLength(1);
    expect(unlinked[0].platformId).toBe("active");
  });

  test("excludes linked identities", async () => {
    upsertIdentity(db, { platform: "discord", platformId: "unlinked", displayName: "Unlinked" });
    upsertIdentity(db, { platform: "discord", platformId: "linked", displayName: "Linked" });

    // Create contact and link one identity
    const contactResult = db.prepare("INSERT INTO contacts (display_name) VALUES (?)").run("Contact");
    const contactId = Number(contactResult.lastInsertRowid);
    db.prepare("UPDATE identities SET contact_id = ? WHERE platform_id = ?").run(contactId, "linked");

    // Both have events
    insertEvent({ source: "discord", type: "message:dm", people: ["discord:unlinked"] });
    insertEvent({ source: "discord", type: "message:dm", people: ["discord:linked"] });

    const unlinked = await getUnlinkedIdentities(wrapDatabase(db), { limit: 10 });

    expect(unlinked).toHaveLength(1);
    expect(unlinked[0].platformId).toBe("unlinked");
  });

  test("excludes skipped identities", async () => {
    upsertIdentity(db, { platform: "discord", platformId: "normal", displayName: "Normal" });
    upsertIdentity(db, { platform: "discord", platformId: "skipped", displayName: "Skipped" });

    skipIdentity(db, "discord", "skipped");

    insertEvent({ source: "discord", type: "message:dm", people: ["discord:normal"] });
    insertEvent({ source: "discord", type: "message:dm", people: ["discord:skipped"] });

    const unlinked = await getUnlinkedIdentities(wrapDatabase(db), { limit: 10 });

    expect(unlinked).toHaveLength(1);
    expect(unlinked[0].platformId).toBe("normal");
  });

  test("respects platform filter", async () => {
    upsertIdentity(db, { platform: "discord", platformId: "d1", displayName: "Discord User" });
    upsertIdentity(db, { platform: "facebook", platformId: "f1", displayName: "FB User" });

    insertEvent({ source: "discord", type: "message:dm", people: ["discord:d1"] });
    insertEvent({ source: "facebook", type: "message:dm", people: ["facebook:f1"] });

    const discordOnly = await getUnlinkedIdentities(wrapDatabase(db), { platform: "discord", limit: 10 });

    expect(discordOnly).toHaveLength(1);
    expect(discordOnly[0].platform).toBe("discord");
  });
});

describe("listSkippedIdentities with event_count", () => {
  beforeEach(setupTestDatabase);
  afterEach(teardownTestDatabase);

  test("returns skipped identities with correct event counts", async () => {
    upsertIdentity(db, { platform: "discord", platformId: "skip1", displayName: "Skip 1" });
    upsertIdentity(db, { platform: "discord", platformId: "skip2", displayName: "Skip 2" });

    insertEvent({ source: "discord", type: "message:dm", people: ["discord:skip1"] });
    insertEvent({ source: "discord", type: "message:dm", people: ["discord:skip1"] });
    insertEvent({ source: "discord", type: "message:dm", people: ["discord:skip2"] });

    skipIdentity(db, "discord", "skip1");
    skipIdentity(db, "discord", "skip2");

    const skipped = await listSkippedIdentities(wrapDatabase(db));

    expect(skipped).toHaveLength(2);
    // Find each by identifier and check count
    const skip1 = skipped.find((s) => s.platformId === "skip1");
    const skip2 = skipped.find((s) => s.platformId === "skip2");

    expect(skip1?.eventCount).toBe(2);
    expect(skip2?.eventCount).toBe(1);
  });

  test("includes skipped identities with event_count = 0", async () => {
    upsertIdentity(db, { platform: "discord", platformId: "noevents", displayName: "No Events" });
    skipIdentity(db, "discord", "noevents");

    const skipped = await listSkippedIdentities(wrapDatabase(db));

    expect(skipped).toHaveLength(1);
    expect(skipped[0].eventCount).toBe(0);
  });
});

describe("populateEventPeople refreshes event_count", () => {
  beforeEach(setupTestDatabase);
  afterEach(teardownTestDatabase);

  test("refreshes event_count after rebuild", () => {
    upsertIdentity(db, { platform: "discord", platformId: "123", displayName: "Alice" });

    // Insert events (triggers will set event_count)
    insertEvent({ source: "discord", type: "message:dm", people: ["discord:123"] });
    insertEvent({ source: "discord", type: "message:dm", people: ["discord:123"] });

    expect(getEventCount("discord", "123")).toBe(2);

    // Manually corrupt event_count
    db.prepare("UPDATE identities SET event_count = 999").run();
    expect(getEventCount("discord", "123")).toBe(999);

    // Rebuild should fix it
    populateEventPeople(db);

    expect(getEventCount("discord", "123")).toBe(2);
  });

  test("sets event_count to 0 for identities without events after rebuild", () => {
    upsertIdentity(db, { platform: "discord", platformId: "orphan", displayName: "Orphan" });

    // Manually set a wrong count
    db.prepare("UPDATE identities SET event_count = 100").run();

    populateEventPeople(db);

    expect(getEventCount("discord", "orphan")).toBe(0);
  });

  test("correctly counts when person appears in multiple events", () => {
    upsertIdentity(db, { platform: "discord", platformId: "multi", displayName: "Multi" });

    // Disable triggers to simulate needing a rebuild
    db.exec("DROP TRIGGER IF EXISTS event_people_identity_ai");
    db.exec("DROP TRIGGER IF EXISTS events_people_ai");

    // Insert events directly
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO events (source, source_id, type, people, raw_data)
        VALUES (?, ?, ?, ?, ?)
      `).run("discord", `event-${i}`, "message:dm", JSON.stringify(["discord:multi"]), "{}");
    }

    expect(getEventCount("discord", "multi")).toBe(0); // Triggers disabled

    // Rebuild populates event_people and refreshes counts
    populateEventPeople(db);

    expect(getEventCount("discord", "multi")).toBe(5);
  });
});
