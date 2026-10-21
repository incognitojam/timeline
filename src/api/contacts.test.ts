/**
 * Contact API Tests
 *
 * Tests for contacts, identities, suggestions, and spotify summary endpoints.
 * Run with: bun test src/api/contacts.test.ts
 */

// Set test mode before importing to prevent server auto-start
process.env.NODE_ENV = "test";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { app } from "./index";
import { getDb } from "../db/schema";
import {
  createContact,
  upsertIdentity,
  linkIdentityToContact,
  deleteContact,
} from "../db/queries";

describe("Filtered contact events", () => {
  let contactId: number;
  const eventIds: number[] = [];
  const discordIds: number[] = [];
  let phoneId: number;
  let manualId: number;
  const platformId = `contact-filters-${crypto.randomUUID()}`;

  beforeAll(() => {
    const db = getDb();
    contactId = createContact(db, "Alice");
    for (const platform of ["discord", "steam", "phone"] as const) {
      upsertIdentity(db, { platform, platformId, displayName: "Alice" });
      linkIdentityToContact(db, platform, platformId, contactId);
    }
    const insert = db.prepare(`
      INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, people, raw_data, conversation_id)
      VALUES (?, ?, 'test-account', ?, ?, ?, 'filtersearchneedle', ?, '{}', ?)
    `);
    const seed = (source: string, type: string, people: string[], timestamp = "2097-01-01T00:00:00Z") => {
      const result = insert.run(
        source, `${platformId}-${eventIds.length}`, type, timestamp,
        "Project 100%_Done", JSON.stringify(people), platformId,
      );
      const id = Number(result.lastInsertRowid);
      eventIds.push(id);
      return id;
    };
    discordIds.push(seed("discord", "message:dm", [`discord:${platformId}`]));
    discordIds.push(seed("discord", "message:dm:attachment", ["discord:bob", `discord:${platformId}`]));
    discordIds.push(seed("discord", "message:group", [`discord:${platformId}`, "discord:bob"]));
    phoneId = seed("phone", "call:incoming", ["phone:bob", `phone:${platformId}`]);
    manualId = seed("manual", "note", ["contact:999999", `contact:${contactId}`]);
    // Group membership alone must not make another sender's message a match.
    seed("discord", "message:group", ["discord:bob", `discord:${platformId}`]);
    // These fill the unfiltered first page and must not hide older matches.
    for (let i = 0; i < 60; i++) {
      seed("steam", "steam:session", [`steam:${platformId}`], "2098-01-01T00:00:00Z");
    }
  });

  afterAll(() => {
    const db = getDb();
    const removeEvent = db.prepare("DELETE FROM events WHERE id = ?");
    for (const id of eventIds) removeEvent.run(id);
    db.prepare("DELETE FROM identities WHERE contact_id = ? AND platform_id = ?").run(contactId, platformId);
    deleteContact(db, contactId);
  });

  async function search(params: Record<string, string>) {
    const response = await app.request(`/api/contacts/${contactId}/events?${new URLSearchParams(params)}`);
    expect(response.status).toBe(200);
    return await response.json() as {
      events: { id: number; source: string }[];
      count: number;
      nextCursor: string | null;
    };
  }

  test("source filtering finds older Discord events beyond the newest 50 events", async () => {
    const unfiltered = await search({ sort: "desc" });
    expect(unfiltered.count).toBe(50);
    expect(unfiltered.events.every(event => event.source === "steam")).toBe(true);

    const filtered = await search({ source: "discord", sort: "desc" });
    expect(filtered.events.map(event => event.id)).toEqual([...discordIds].reverse());
    expect(filtered.count).toBe(3);
    expect(filtered.nextCursor).toBeNull();
  });

  test("type prefixes and comma-separated sources/types filter before limiting", async () => {
    const messages = await search({ type: "message", limit: "2", sort: "desc" });
    expect(messages.events.map(event => event.id)).toEqual([...discordIds].reverse().slice(0, 2));
    expect(messages.nextCursor).not.toBeNull();

    const multiple = await search({ source: " discord, manual ", type: " message, note ", sort: "asc" });
    expect(multiple.events.map(event => event.id)).toEqual([...discordIds, manualId]);

    const emptyFilters: Record<string, string>[] = [{ source: "," }, { type: "," }, { type: "MESSAGE" }];
    for (const params of emptyFilters) {
      const empty = await search(params);
      expect(empty.events).toEqual([]);
    }
  });

  test("chat matches literal title fragments without including non-conversational events", async () => {
    const chats = await search({ chat: "100%_done", sort: "asc" });
    expect(chats.events.map(event => event.id)).toEqual([...discordIds, phoneId]);
    const nonMatching = await search({ chat: "100%done" });
    expect(nonMatching.events).toEqual([]);
  });

  test("combined filters work with text and date constraints", async () => {
    const result = await search({
      source: "discord", type: "message:dm", chat: "project", q: "filtersearchneedle",
      startDate: "2097-01-01", endDate: "2097-01-01", sort: "desc", limit: "1",
    });
    expect(result.events.map(event => event.id)).toEqual([discordIds[1]]);
    expect(result.nextCursor).not.toBeNull();
    const outsideRange = await search({ source: "discord", startDate: "2098-01-01" });
    expect(outsideRange.events).toEqual([]);
  });

  for (const sort of ["asc", "desc"] as const) {
    test(`filtered ${sort} pagination includes every event with equal timestamps exactly once`, async () => {
      const params = { source: "discord,phone,manual", sort, limit: "2" };
      const expectedIds = [...discordIds, phoneId, manualId];
      if (sort === "desc") expectedIds.reverse();
      const first = await search(params);
      expect(first.events.map(event => event.id)).toEqual(expectedIds.slice(0, 2));
      expect(first.nextCursor).not.toBeNull();
      if (!first.nextCursor) throw new Error("Expected first page cursor");
      const second = await search({ ...params, cursor: first.nextCursor });
      expect(second.events.map(event => event.id)).toEqual(expectedIds.slice(2, 4));
      expect(second.nextCursor).not.toBeNull();
      if (!second.nextCursor) throw new Error("Expected second page cursor");
      const last = await search({ ...params, cursor: second.nextCursor });
      expect(last.events.map(event => event.id)).toEqual(expectedIds.slice(4));
      expect(last.nextCursor).toBeNull();
    });
  }
});

describe("Contact API Tests", () => {
  describe("Contacts", () => {
    test("GET /api/contacts returns contacts list", async () => {
      const res = await app.request("/api/contacts");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("contacts");
      expect(Array.isArray(json.contacts)).toBe(true);
    });

    test("GET /api/contacts/count returns count", async () => {
      const res = await app.request("/api/contacts/count");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("count");
      expect(typeof json.count).toBe("number");
    });

    test("GET /api/contacts reflects newly created contact (cache invalidation)", async () => {
      // Prime the cache
      const res1 = await app.request("/api/contacts");
      const before = await res1.json();
      const countBefore = before.contacts.length;

      // Create a contact via API
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Cache Test User" }),
      });
      expect(createRes.status).toBe(200);

      // GET should return fresh data, not stale cache
      const res2 = await app.request("/api/contacts");
      const after = await res2.json();
      expect(after.contacts.length).toBe(countBefore + 1);
      expect(after.contacts.some((c: any) => c.display_name === "Cache Test User")).toBe(true);

      // Count endpoint should also reflect the change
      const countRes = await app.request("/api/contacts/count");
      const countJson = await countRes.json();
      expect(countJson.count).toBe(countBefore + 1);
    });

    test("GET /api/contacts returns contacts with identityCount and eventCount", async () => {
      const db = getDb();
      // Create a test contact with linked identities
      const contactId = createContact(db, "Test User");
      upsertIdentity(db, {
        platform: "discord",
        platformId: "test-user-123",
        displayName: "Test User",
      });
      linkIdentityToContact(db, "discord", "test-user-123", contactId);

      // Invalidate API cache since we modified the DB directly
      await app.request("/api/cache/refresh", { method: "POST" });

      try {
        const res = await app.request("/api/contacts");
        expect(res.status).toBe(200);
        const json = await res.json();

        const testContact = json.contacts.find(
          (c: { display_name: string }) => c.display_name === "Test User"
        );
        expect(testContact).toBeDefined();
        expect(typeof testContact.identityCount).toBe("number");
        expect(testContact.identityCount).toBe(1);
        expect(typeof testContact.eventCount).toBe("number");
      } finally {
        // Clean up
        deleteContact(db, contactId);
      }
    });

    test("GET /api/contacts/:id returns avatarUrl from linked identities", async () => {
      const db = getDb();
      const contactId = createContact(db, "Avatar Test User");
      upsertIdentity(db, {
        platform: "discord",
        platformId: "avatar-test-user",
        displayName: "Avatar Test User",
        avatarUrl: "https://cdn.discordapp.com/avatars/123/abc.png?size=128",
      });
      linkIdentityToContact(db, "discord", "avatar-test-user", contactId);

      try {
        const res = await app.request(`/api/contacts/${contactId}`);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.avatarUrl).toBe("https://cdn.discordapp.com/avatars/123/abc.png?size=128");
        expect(json.identities[0].avatar_url).toBe("https://cdn.discordapp.com/avatars/123/abc.png?size=128");
      } finally {
        deleteContact(db, contactId);
      }
    });

    test("GET /api/identities/:identifier/suggested-contacts returns empty for no matches", async () => {
      const res = await app.request(
        "/api/identities/" + encodeURIComponent("discord:no-match-xyz") + "/suggested-contacts"
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("suggestions");
      expect(Array.isArray(json.suggestions)).toBe(true);
      expect(json.suggestions.length).toBe(0);
    });

    test("GET /api/identities/:identifier/suggested-contacts returns matching contacts", async () => {
      const db = getDb();
      // Create a contact with a linked identity
      const contactId = createContact(db, "Alice Match Example");
      upsertIdentity(db, {
        platform: "discord",
        platformId: "alice_match_example",
        displayName: "Alice Match Example",
      });
      linkIdentityToContact(db, "discord", "alice_match_example", contactId);

      try {
        // Query for suggested contacts for an unlinked identity with same normalized name
        const res = await app.request(
          "/api/identities/" +
            encodeURIComponent("linkedin:alice-match-example") +
            "/suggested-contacts"
        );
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toHaveProperty("suggestions");
        expect(Array.isArray(json.suggestions)).toBe(true);
        expect(json.suggestions.length).toBe(1);
        expect(json.suggestions[0].contactId).toBe(contactId);
        expect(json.suggestions[0].contactName).toBe("Alice Match Example");
      } finally {
        deleteContact(db, contactId);
      }
    });

    test("GET /api/identities/link-suggestions returns empty when no matches", async () => {
      const res = await app.request("/api/identities/link-suggestions");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("suggestions");
      expect(Array.isArray(json.suggestions)).toBe(true);
    });

    test("GET /api/identities/link-suggestions returns suggestions with correct shape", async () => {
      const db = getDb();
      // Create a contact with a linked identity
      const contactId = createContact(db, "Bob Match Example");
      upsertIdentity(db, {
        platform: "discord",
        platformId: "bob_match_example",
        displayName: "Bob Match Example",
      });
      linkIdentityToContact(db, "discord", "bob_match_example", contactId);

      // Create an unlinked identity with matching normalized name
      upsertIdentity(db, {
        platform: "facebook",
        platformId: "bob-match-example",
        displayName: "Bob Match Example",
      });
      // Set event_count > 0 so it appears in link suggestions
      db.prepare(`
        UPDATE identities SET event_count = 5
        WHERE platform = 'facebook' AND platform_id = 'bob-match-example'
      `).run();

      try {
        const res = await app.request("/api/identities/link-suggestions?limit=10");
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toHaveProperty("suggestions");
        expect(Array.isArray(json.suggestions)).toBe(true);

        // Find and verify the suggestion
        const match = json.suggestions.find(
          (s: { identity: { identifier: string } }) =>
            s.identity.identifier === "facebook:bob-match-example"
        );
        expect(match).toBeDefined();
        expect(match).toHaveProperty("identity");
        expect(match).toHaveProperty("contact");
        expect(match).toHaveProperty("matchedVia");
        expect(match.identity.platform).toBe("facebook");
        expect(match.identity.platformId).toBe("bob-match-example");
        expect(match.contact.id).toBe(contactId);
        expect(match.contact.displayName).toBe("Bob Match Example");
      } finally {
        deleteContact(db, contactId);
      }
    });
  });

  describe("Contact Profile & Memories", () => {
    test("PATCH /api/contacts/:id accepts profile fields", async () => {
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Profile Test User" }),
      });
      const { contact } = await createRes.json();

      const patchRes = await app.request(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateOfBirth: "1990-03-15" }),
      });
      expect(patchRes.status).toBe(200);
      const updated = await patchRes.json();
      expect(updated.contact.date_of_birth).toBe("1990-03-15");

      // GET should return the same
      const getRes = await app.request(`/api/contacts/${contact.id}`);
      const fetched = await getRes.json();
      expect(fetched.contact.date_of_birth).toBe("1990-03-15");

      deleteContact(getDb(), contact.id);
    });

    test("PATCH /api/contacts/:id can clear profile fields with null", async () => {
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Clear Fields User" }),
      });
      const { contact } = await createRes.json();

      // Set a field
      await app.request(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateOfBirth: "1995-06-01" }),
      });

      // Clear it
      const patchRes = await app.request(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateOfBirth: null }),
      });
      const updated = await patchRes.json();
      expect(updated.contact.date_of_birth).toBeNull();

      deleteContact(getDb(), contact.id);
    });

    test("PATCH /api/contacts/:id accepts --MM-DD birthday format", async () => {
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Day Month Birthday User" }),
      });
      const { contact } = await createRes.json();

      const patchRes = await app.request(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateOfBirth: "--03-15" }),
      });
      expect(patchRes.status).toBe(200);
      const updated = await patchRes.json();
      expect(updated.contact.date_of_birth).toBe("--03-15");

      const getRes = await app.request(`/api/contacts/${contact.id}`);
      const fetched = await getRes.json();
      expect(fetched.contact.date_of_birth).toBe("--03-15");

      deleteContact(getDb(), contact.id);
    });

    test("PATCH /api/contacts/:id rejects invalid dateOfBirth format", async () => {
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Invalid Birthday User" }),
      });
      const { contact } = await createRes.json();

      const patchRes = await app.request(`/api/contacts/${contact.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateOfBirth: "March 15" }),
      });
      expect(patchRes.status).toBe(400);

      deleteContact(getDb(), contact.id);
    });

    test("GET /api/contacts/:id returns memories array", async () => {
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Memory Test User" }),
      });
      const { contact } = await createRes.json();

      const getRes = await app.request(`/api/contacts/${contact.id}`);
      const fetched = await getRes.json();
      expect(fetched).toHaveProperty("memories");
      expect(Array.isArray(fetched.memories)).toBe(true);
      expect(fetched.memories.length).toBe(0);

      deleteContact(getDb(), contact.id);
    });

    test("POST /api/contacts/:id/memories creates a memory", async () => {
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Memory CRUD User" }),
      });
      const { contact } = await createRes.json();

      const memRes = await app.request(`/api/contacts/${contact.id}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Prefers tea over coffee" }),
      });
      expect(memRes.status).toBe(201);
      const { memory } = await memRes.json();
      expect(memory.content).toBe("Prefers tea over coffee");
      expect(memory.contact_id).toBe(contact.id);

      // Should appear in GET
      const getRes = await app.request(`/api/contacts/${contact.id}`);
      const fetched = await getRes.json();
      expect(fetched.memories.length).toBe(1);
      expect(fetched.memories[0].content).toBe("Prefers tea over coffee");

      deleteContact(getDb(), contact.id);
    });

    test("DELETE /api/contacts/:id/memories/:memoryId removes a memory", async () => {
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Memory Delete User" }),
      });
      const { contact } = await createRes.json();

      const memRes = await app.request(`/api/contacts/${contact.id}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Has a dog named Max" }),
      });
      const { memory } = await memRes.json();

      const delRes = await app.request(`/api/contacts/${contact.id}/memories/${memory.id}`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);

      const getRes = await app.request(`/api/contacts/${contact.id}`);
      const fetched = await getRes.json();
      expect(fetched.memories.length).toBe(0);

      deleteContact(getDb(), contact.id);
    });

    test("memories are cascade-deleted when contact is deleted", async () => {
      const db = getDb();
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Cascade Delete User" }),
      });
      const { contact } = await createRes.json();

      await app.request(`/api/contacts/${contact.id}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Some fact" }),
      });

      // Verify memory exists
      const count = db.prepare("SELECT COUNT(*) as c FROM contact_memories WHERE contact_id = ?").get(contact.id) as any;
      expect(count.c).toBe(1);

      // Delete contact
      deleteContact(db, contact.id);

      // Memory should be gone
      const afterCount = db.prepare("SELECT COUNT(*) as c FROM contact_memories WHERE contact_id = ?").get(contact.id) as any;
      expect(afterCount.c).toBe(0);
    });

    test("POST /api/contacts/:id/memories returns 404 for non-existent contact", async () => {
      const res = await app.request("/api/contacts/999999999/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Should fail" }),
      });
      expect(res.status).toBe(404);
    });

    test("POST /api/contacts/:id/memories returns 400 without content", async () => {
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Validation Test User" }),
      });
      const { contact } = await createRes.json();

      const res = await app.request(`/api/contacts/${contact.id}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);

      deleteContact(getDb(), contact.id);
    });
  });

  describe("Contact Suggestions", () => {
    let linkedContactId = 0;
    let selfContactId = 0;
    let previousSelfContactId: number | null = null;

    beforeAll(() => {
      // Seed test data: events with people that should match across sources
      const db = getDb();
      const insertContact = db.prepare(`
        INSERT INTO contacts (display_name)
        VALUES (?)
      `);

      // Insert events with people - triggers populate event_people table
      const insertEvent = db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data, conversation_id)
        VALUES (?, ?, 'test-account', 'message', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'Test', ?, '{}', ?)
      `);
      const insertIdentity = db.prepare(`
        INSERT OR IGNORE INTO identities (platform, platform_id, display_name, skipped)
        VALUES (?, ?, ?, ?)
      `);

      // Same person different case/format across sources
      insertEvent.run("facebook", "fb1", JSON.stringify(["Alice Suggestion Example"]), "contacts-suggestion-alice-facebook");
      insertEvent.run("discord", "dc1", JSON.stringify(["alice_suggestion_example"]), "contacts-suggestion-alice-discord");
      insertEvent.run("linkedin", "li1", JSON.stringify(["Alice Suggestion Example"]), "contacts-suggestion-alice-linkedin");

      // Another matching pair
      insertEvent.run("facebook", "fb2", JSON.stringify(["Bob Suggestion Example"]), "contacts-suggestion-bob-facebook");
      insertEvent.run("skype", "sk1", JSON.stringify(["bob.suggestion.example"]), "contacts-suggestion-bob-skype");

      // Identity-formatted events for identity-based suggestions
      insertEvent.run("discord", "dc2", JSON.stringify(["discord:alice_suggestion_example"]), "contacts-suggestion-alice-identity");
      insertIdentity.run("discord", "alice_suggestion_example", "alice_suggestion_example", 0);
      insertIdentity.run("facebook", "name:Alice Suggestion Example", "Alice Suggestion Example", 0);
      insertIdentity.run("facebook", "name:Bob Suggestion Example", "Bob Suggestion Example", 0);

      // Skipped identity that would otherwise match "Bob Suggestion Example"
      insertEvent.run("discord", "dc3", JSON.stringify(["discord:skip_me"]), "contacts-suggestion-skipped");
      insertIdentity.run("discord", "skip_me", "Bob Suggestion Example", 1);

      // Linked identity that should be excluded from global suggestions
      const contactResult = insertContact.run("Linked Person");
      linkedContactId = Number(contactResult.lastInsertRowid);
      insertEvent.run("discord", "dc4", JSON.stringify(["discord:linked_user"]), "contacts-suggestion-linked");
      insertIdentity.run("discord", "linked_user", "Linked User", 0);
      db.prepare(`
        UPDATE identities SET contact_id = ?
        WHERE platform = ? AND platform_id = ?
      `).run(linkedContactId, "discord", "linked_user");

      // The user's own contact, so the resolver's isSelf=true path is pinned
      // (the web client renders "You" from it). Only one is_self row may
      // exist; step aside from any existing one and restore it in afterAll.
      const previousSelf = db.prepare("SELECT id FROM contacts WHERE is_self = 1").get() as { id: number } | null;
      previousSelfContactId = previousSelf?.id ?? null;
      db.prepare("UPDATE contacts SET is_self = 0 WHERE is_self = 1").run();
      selfContactId = Number(
        db.prepare("INSERT INTO contacts (display_name, is_self) VALUES (?, 1)").run("Owner Person").lastInsertRowid,
      );
      insertIdentity.run("discord", "owner_user", "Owner User", 0);
      db.prepare(`
        UPDATE identities SET contact_id = ?
        WHERE platform = ? AND platform_id = ?
      `).run(selfContactId, "discord", "owner_user");

      db.close();
    });

    afterAll(() => {
      const db = getDb();
      db.prepare("DELETE FROM identities WHERE platform = 'discord' AND platform_id = 'owner_user'").run();
      db.prepare("DELETE FROM contacts WHERE id = ?").run(selfContactId);
      if (previousSelfContactId !== null) {
        db.prepare("UPDATE contacts SET is_self = 1 WHERE id = ?").run(previousSelfContactId);
      }
      db.close();
    });

    test("GET /api/contacts/suggestions returns matching aliases", async () => {
      const res = await app.request("/api/contacts/suggestions");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("suggestions");
      expect(json).toHaveProperty("count");
      expect(Array.isArray(json.suggestions)).toBe(true);

      // Should find matches for the two synthetic fixture identities.
      expect(json.count).toBeGreaterThanOrEqual(2);

      // Check structure of suggestion
      if (json.suggestions.length > 0) {
        const s = json.suggestions[0];
        expect(s).toHaveProperty("alias_a");
        expect(s).toHaveProperty("source_a");
        expect(s).toHaveProperty("alias_b");
        expect(s).toHaveProperty("source_b");
        expect(s).toHaveProperty("normalized");
      }
    });

    test("GET /api/contacts/suggestions respects limit", async () => {
      const res = await app.request("/api/contacts/suggestions?limit=1");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.suggestions.length).toBeLessThanOrEqual(1);
    });

    test("GET /api/contacts/suggestions excludes skipped identities", async () => {
      const res = await app.request("/api/contacts/suggestions");
      expect(res.status).toBe(200);
      const json = await res.json();
      const hasSkipped = json.suggestions.some(
        (s: { alias_a: string; alias_b: string }) =>
          s.alias_a === "discord:skip_me" || s.alias_b === "discord:skip_me"
      );
      expect(hasSkipped).toBe(false);
    });

    test("GET /api/contacts/suggestions excludes linked identities", async () => {
      const res = await app.request("/api/contacts/suggestions");
      expect(res.status).toBe(200);
      const json = await res.json();
      const hasLinked = json.suggestions.some(
        (s: { alias_a: string; alias_b: string }) =>
          s.alias_a === "discord:linked_user" || s.alias_b === "discord:linked_user"
      );
      expect(hasLinked).toBe(false);
    });

    test("POST /api/identities/resolve returns resolved identities", async () => {
      const res = await app.request("/api/identities/resolve", {
        method: "POST",
        body: JSON.stringify({
          identifiers: [
            "discord:alice_suggestion_example",
            "discord:linked_user",
            "discord:missing_user",
            "discord:owner_user",
          ],
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("resolved");
      expect(json.resolved["discord:alice_suggestion_example"]).toEqual({
        name: "alice_suggestion_example",
        username: null,
        contactId: null,
        avatarUrl: null,
        isSelf: false,
      });
      expect(json.resolved["discord:linked_user"]).toEqual({
        name: "Linked Person",
        username: null,
        contactId: linkedContactId,
        avatarUrl: null,
        isSelf: false,
      });
      expect(json.resolved["discord:missing_user"]).toEqual({
        name: null,
        username: null,
        contactId: null,
        avatarUrl: null,
        isSelf: false,
      });
      expect(json.resolved["discord:owner_user"]).toEqual({
        name: "Owner Person",
        username: null,
        contactId: selfContactId,
        avatarUrl: null,
        isSelf: true,
      });
      // Internal filtering state never leaves the resolver.
      for (const identity of Object.values(json.resolved as Record<string, object>)) {
        expect(identity).not.toHaveProperty("hidden");
      }
    });

    test("POST /api/identities/resolve rejects malformed bodies", async () => {
      for (const body of [{ identifiers: [123] }, null, "identifiers"]) {
        const res = await app.request("/api/identities/resolve", {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        });
        expect(res.status).toBe(400);
      }
    });

    test("GET /api/contacts/:id/suggestions returns suggestions for contact", async () => {
      // Create a contact with an alias
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        body: JSON.stringify({ displayName: "Test Person" }),
        headers: { "Content-Type": "application/json" },
      });
      const { contact } = await createRes.json();

      // Add an alias that matches existing unlinked aliases
      await app.request(`/api/identities/${encodeURIComponent("facebook:name:Alice Suggestion Example")}/link`, {
        method: "POST",
        body: JSON.stringify({ contactId: contact.id }),
        headers: { "Content-Type": "application/json" },
      });

      // Get suggestions for this contact
      const res = await app.request(`/api/contacts/${contact.id}/suggestions`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("contact");
      expect(json).toHaveProperty("suggestions");
      expect(json).toHaveProperty("count");

      // Should find the discord identity as a match
      expect(json.count).toBeGreaterThanOrEqual(1);
      const match = json.suggestions.find(
        (s: { alias: string }) => s.alias === "discord:alice_suggestion_example"
      );
      expect(match).toBeDefined();
      expect(match.source).toBe("discord");
    });

    test("GET /api/identities/unlinked and /api/identities/unlinked/count return consistent counts", async () => {
      const res = await app.request("/api/identities/unlinked");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("identities");
      expect(json).toHaveProperty("count");
      expect(Array.isArray(json.identities)).toBe(true);

      const countRes = await app.request("/api/identities/unlinked/count");
      expect(countRes.status).toBe(200);
      const countJson = await countRes.json();
      expect(countJson).toHaveProperty("count");
      expect(typeof countJson.count).toBe("number");
      expect(countJson.count).toBeGreaterThanOrEqual(json.identities.length);
    });

    test("GET /api/identities/skipped and /api/identities/skipped/count return expected shape", async () => {
      const res = await app.request("/api/identities/skipped");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("identities");
      expect(json).toHaveProperty("count");
      expect(Array.isArray(json.identities)).toBe(true);
      expect(json.count).toBe(json.identities.length);

      if (json.identities.length > 0) {
        const identity = json.identities[0];
        expect(identity).toHaveProperty("identifier");
        expect(identity).toHaveProperty("platform");
        expect(identity).toHaveProperty("skippedAt");
        expect(identity).toHaveProperty("eventCount");
      }

      const countRes = await app.request("/api/identities/skipped/count");
      expect(countRes.status).toBe(200);
      const countJson = await countRes.json();
      expect(countJson).toHaveProperty("count");
      expect(typeof countJson.count).toBe("number");
      expect(countJson.count).toBe(json.count);
    });

    test("GET /api/contacts/:id/suggestions excludes skipped identities", async () => {
      // Create a contact with an alias that matches the skipped identity's display name
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        body: JSON.stringify({ displayName: "Skip Test" }),
        headers: { "Content-Type": "application/json" },
      });
      const { contact } = await createRes.json();

      await app.request(`/api/identities/${encodeURIComponent("facebook:name:Bob Suggestion Example")}/link`, {
        method: "POST",
        body: JSON.stringify({ contactId: contact.id }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await app.request(`/api/contacts/${contact.id}/suggestions`);
      expect(res.status).toBe(200);
      const json = await res.json();
      const skippedMatch = json.suggestions.find((s: { alias: string }) => s.alias === "discord:skip_me");
      expect(skippedMatch).toBeUndefined();
    });

    test("POST /api/identities/:identifier/link links identity and resolves", async () => {
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        body: JSON.stringify({ displayName: "Link Target" }),
        headers: { "Content-Type": "application/json" },
      });
      const { contact } = await createRes.json();

      await app.request(`/api/identities/${encodeURIComponent("discord:alice_suggestion_example")}/link`, {
        method: "POST",
        body: JSON.stringify({ contactId: contact.id }),
        headers: { "Content-Type": "application/json" },
      });

      const identitiesRes = await app.request(`/api/contacts/${contact.id}/identities`);
      const identitiesJson = await identitiesRes.json();
      expect(
        identitiesJson.identities.some(
          (i: { platform: string; platform_id: string }) =>
            i.platform === "discord" && i.platform_id === "alice_suggestion_example"
        )
      ).toBe(true);

      const resolveRes = await app.request(
        "/api/contacts/resolve?alias=discord:alice_suggestion_example"
      );
      const resolveJson = await resolveRes.json();
      expect(resolveJson.contact.id).toBe(contact.id);
    });

    test("POST /api/identities/:identifier/link returns 404 for non-existent contact", async () => {
      const res = await app.request(`/api/identities/${encodeURIComponent("discord:alice_suggestion_example")}/link`, {
        method: "POST",
        body: JSON.stringify({ contactId: 999999 }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Contact not found");
    });

    test("POST /api/identities/:identifier/link returns 404 for non-existent identity", async () => {
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        body: JSON.stringify({ displayName: "Test Contact" }),
        headers: { "Content-Type": "application/json" },
      });
      const { contact } = await createRes.json();

      const res = await app.request(`/api/identities/${encodeURIComponent("nonexistent:unknown_user")}/link`, {
        method: "POST",
        body: JSON.stringify({ contactId: contact.id }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Identity not found");
    });

    test("GET /api/contacts/:id/events returns events for linked identity", async () => {
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        body: JSON.stringify({ displayName: "Event Target" }),
        headers: { "Content-Type": "application/json" },
      });
      const { contact } = await createRes.json();

      await app.request(`/api/identities/${encodeURIComponent("discord:alice_suggestion_example")}/link`, {
        method: "POST",
        body: JSON.stringify({ contactId: contact.id }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await app.request(`/api/contacts/${contact.id}/events?limit=5`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.count).toBeGreaterThanOrEqual(1);
      expect(json.events.some((e: { source_id: string }) => e.source_id === "dc2")).toBe(true);

      const db = getDb();
      const people = JSON.stringify(["discord:alice_suggestion_example"]);
      const insertEvent = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, title, content, people, raw_data,
          conversation_id
        ) VALUES (
          'discord', ?, 'test-account', 'message:dm', ?, 'Contact search', ?, ?, '{}',
          'contact-search-thread'
        )
      `);
      const matching = insertEvent.run(
        `contact-search-match-${crypto.randomUUID()}`,
        "2099-01-01T00:00:00.000Z",
        "contactsearchneedle",
        people,
      );
      const unrelated = insertEvent.run(
        `contact-search-unrelated-${crypto.randomUUID()}`,
        "2099-01-02T00:00:00.000Z",
        "unrelated newer event",
        people,
      );

      try {
        const filteredRes = await app.request(
          `/api/contacts/${contact.id}/events?q=contactsearchneedle&limit=1`,
        );
        expect(filteredRes.status).toBe(200);
        const filteredJson = await filteredRes.json();
        expect(filteredJson.events.map((event: { id: number }) => event.id)).toEqual([
          Number(matching.lastInsertRowid),
        ]);
      } finally {
        db.prepare("DELETE FROM events WHERE id IN (?, ?)").run(
          Number(matching.lastInsertRowid),
          Number(unrelated.lastInsertRowid),
        );
      }
    });

    test("GET /api/contacts/:id/suggestions returns 404 for non-existent contact", async () => {
      const res = await app.request("/api/contacts/999999/suggestions");
      expect(res.status).toBe(404);
    });
  });

  describe("Contact Spotify Summary", () => {
    test("GET /api/contacts/:id/spotify-summary returns 404 for non-existent contact", async () => {
      const res = await app.request("/api/contacts/999999/spotify-summary");
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json).toHaveProperty("error");
      expect(json.summary).toBeNull();
    });

    test("GET /api/contacts/:id/spotify-summary returns null for contact without spotify data", async () => {
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        body: JSON.stringify({ displayName: "No Spotify User" }),
        headers: { "Content-Type": "application/json" },
      });
      expect(createRes.status).toBe(200);
      const { contact } = await createRes.json();

      const res = await app.request(`/api/contacts/${contact.id}/spotify-summary`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.summary).toBeNull();
    });

    test("GET /api/contacts/:id/spotify-summary returns aggregated data", async () => {
      const db = getDb();

      // Insert spotify-friends events
      const insertEvent = db.prepare(`
        INSERT INTO events (source, source_id, type, timestamp, title, content, people, tags, raw_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
      `);

      insertEvent.run(
        "spotify-friends", "sf-test-1", "listen:track:friend",
        "2025-01-01T10:00:00Z", "Track Alpha", "Track Alpha by Artist One",
        JSON.stringify(["spotify:spotify_summary_test"]),
        JSON.stringify(["artist:Artist One", "album:Album X"])
      );
      insertEvent.run(
        "spotify-friends", "sf-test-2", "listen:track:friend",
        "2025-01-02T10:00:00Z", "Track Beta", "Track Beta by Artist One",
        JSON.stringify(["spotify:spotify_summary_test"]),
        JSON.stringify(["artist:Artist One", "album:Album Y"])
      );
      insertEvent.run(
        "spotify-friends", "sf-test-3", "listen:track:friend",
        "2025-01-03T10:00:00Z", "Track Alpha", "Track Alpha by Artist One",
        JSON.stringify(["spotify:spotify_summary_test"]),
        JSON.stringify(["artist:Artist One", "album:Album X"])
      );
      insertEvent.run(
        "spotify-friends", "sf-test-4", "listen:track:friend",
        "2025-01-04T10:00:00Z", "Track Gamma", "Track Gamma by Artist Two",
        JSON.stringify(["spotify:spotify_summary_test"]),
        JSON.stringify(["artist:Artist Two", "album:Album Z"])
      );

      // Create contact and link spotify identity
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        body: JSON.stringify({ displayName: "Spotify Test Friend" }),
        headers: { "Content-Type": "application/json" },
      });
      const { contact } = await createRes.json();

      db.prepare(`
        INSERT INTO identities (platform, platform_id, display_name)
        VALUES (?, ?, ?)
        ON CONFLICT(platform, platform_id) DO NOTHING
      `).run("spotify", "spotify_summary_test", "Spotify Test Friend");

      await app.request(`/api/identities/${encodeURIComponent("spotify:spotify_summary_test")}/link`, {
        method: "POST",
        body: JSON.stringify({ contactId: contact.id }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await app.request(`/api/contacts/${contact.id}/spotify-summary`);
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.summary).not.toBeNull();
      expect(json.summary.totalListens).toBe(4);
      expect(json.summary.firstListen).toBe("2025-01-01T10:00:00Z");
      expect(json.summary.lastListen).toBe("2025-01-04T10:00:00Z");

      // Top artist should be Artist One (3 listens)
      expect(json.summary.topArtists.length).toBeGreaterThanOrEqual(1);
      expect(json.summary.topArtists[0].name).toBe("Artist One");
      expect(json.summary.topArtists[0].listenCount).toBe(3);

      // Top track should be Track Alpha (2 listens)
      expect(json.summary.topTracks.length).toBeGreaterThanOrEqual(1);
      expect(json.summary.topTracks[0].name).toBe("Track Alpha");
      expect(json.summary.topTracks[0].listenCount).toBe(2);
      expect(json.summary.topTracks[0].artist).toBe("Artist One");
    });

    test("same title by different artists are separate tracks", async () => {
      const db = getDb();

      const insertEvent = db.prepare(`
        INSERT INTO events (source, source_id, type, timestamp, title, content, people, tags, raw_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
      `);

      // "Stay" by Artist A (2 listens) and "Stay" by Artist B (1 listen)
      insertEvent.run(
        "spotify-friends", "sf-dup-1", "listen:track:friend",
        "2025-02-01T10:00:00Z", "Stay", "Stay by Artist A",
        JSON.stringify(["spotify:spotify_dup_test"]),
        JSON.stringify(["artist:Artist A"])
      );
      insertEvent.run(
        "spotify-friends", "sf-dup-2", "listen:track:friend",
        "2025-02-02T10:00:00Z", "Stay", "Stay by Artist A",
        JSON.stringify(["spotify:spotify_dup_test"]),
        JSON.stringify(["artist:Artist A"])
      );
      insertEvent.run(
        "spotify-friends", "sf-dup-3", "listen:track:friend",
        "2025-02-03T10:00:00Z", "Stay", "Stay by Artist B",
        JSON.stringify(["spotify:spotify_dup_test"]),
        JSON.stringify(["artist:Artist B"])
      );

      const createRes = await app.request("/api/contacts", {
        method: "POST",
        body: JSON.stringify({ displayName: "Dup Track Test" }),
        headers: { "Content-Type": "application/json" },
      });
      const { contact } = await createRes.json();

      db.prepare(`
        INSERT INTO identities (platform, platform_id, display_name)
        VALUES (?, ?, ?)
        ON CONFLICT(platform, platform_id) DO NOTHING
      `).run("spotify", "spotify_dup_test", "Dup Track Test");

      await app.request(`/api/identities/${encodeURIComponent("spotify:spotify_dup_test")}/link`, {
        method: "POST",
        body: JSON.stringify({ contactId: contact.id }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await app.request(`/api/contacts/${contact.id}/spotify-summary`);
      const json = await res.json();

      // Should have two separate "Stay" entries with different artists
      const stayTracks = json.summary.topTracks.filter((t: { name: string }) => t.name === "Stay");
      expect(stayTracks.length).toBe(2);
      expect(stayTracks[0].artist).toBe("Artist A");
      expect(stayTracks[0].listenCount).toBe(2);
      expect(stayTracks[1].artist).toBe("Artist B");
      expect(stayTracks[1].listenCount).toBe(1);
    });

    test("excludes podcast and audiobook events", async () => {
      const db = getDb();

      const insertEvent = db.prepare(`
        INSERT INTO events (source, source_id, type, timestamp, title, content, people, tags, raw_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
      `);

      // Track listen (should be counted)
      insertEvent.run(
        "spotify", "sp-type-1", "listen:track",
        "2025-03-01T10:00:00Z", "Real Song", "Real Song by Real Artist",
        JSON.stringify(["spotify:spotify_type_test"]),
        JSON.stringify(["artist:Real Artist"])
      );
      // Podcast listen (should be excluded)
      insertEvent.run(
        "spotify", "sp-type-2", "listen:podcast",
        "2025-03-02T10:00:00Z", "Some Podcast Episode", "Some Podcast Episode",
        JSON.stringify(["spotify:spotify_type_test"]),
        JSON.stringify([])
      );
      // Audiobook listen (should be excluded)
      insertEvent.run(
        "spotify", "sp-type-3", "listen:audiobook",
        "2025-03-03T10:00:00Z", "Chapter 1", "Chapter 1 of Some Book",
        JSON.stringify(["spotify:spotify_type_test"]),
        JSON.stringify([])
      );

      const createRes = await app.request("/api/contacts", {
        method: "POST",
        body: JSON.stringify({ displayName: "Type Filter Test" }),
        headers: { "Content-Type": "application/json" },
      });
      const { contact } = await createRes.json();

      db.prepare(`
        INSERT INTO identities (platform, platform_id, display_name)
        VALUES (?, ?, ?)
        ON CONFLICT(platform, platform_id) DO NOTHING
      `).run("spotify", "spotify_type_test", "Type Filter Test");

      await app.request(`/api/identities/${encodeURIComponent("spotify:spotify_type_test")}/link`, {
        method: "POST",
        body: JSON.stringify({ contactId: contact.id }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await app.request(`/api/contacts/${contact.id}/spotify-summary`);
      const json = await res.json();

      // Only the track listen should be counted
      expect(json.summary.totalListens).toBe(1);
      expect(json.summary.topTracks.length).toBe(1);
      expect(json.summary.topTracks[0].name).toBe("Real Song");
    });
  });

  describe("Contact event filtering", () => {
    let contactId: number;

    beforeAll(() => {
      const db = getDb();

      // Create a contact and link discord + phone identities
      contactId = createContact(db, "Alice Test");
      upsertIdentity(db, { platform: "discord", platformId: "alice123", displayName: "Alice" });
      upsertIdentity(db, { platform: "phone", platformId: "+447700900123", displayName: "Alice" });
      linkIdentityToContact(db, "discord", "alice123", contactId);
      linkIdentityToContact(db, "phone", "+447700900123", contactId);

      const insertEvent = db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, people, raw_data, conversation_id)
        VALUES (?, ?, 'test-account', ?, ?, ?, ?, '{}', ?)
      `);

      // 1. DM sent by contact (alice is sender)
      insertEvent.run("discord", "cef-dm-sent", "message:dm",
        "2025-06-01T10:00:00Z", "DM from Alice",
        JSON.stringify(["discord:alice123", "discord:me"]), "contacts-filter-alice-dm");

      // 2. DM sent to contact (me is sender)
      insertEvent.run("discord", "cef-dm-recv", "message:dm",
        "2025-06-01T11:00:00Z", "DM to Alice",
        JSON.stringify(["discord:me", "discord:alice123"]), "contacts-filter-alice-dm");

      // 3. Group msg sent by contact
      insertEvent.run("discord", "cef-group-sent", "message:group",
        "2025-06-01T12:00:00Z", "Group msg from Alice",
        JSON.stringify(["discord:alice123", "discord:me", "discord:bob"]), "contacts-filter-group");

      // 4. Group msg by someone else (alice is participant, not sender)
      insertEvent.run("discord", "cef-group-other", "message:group",
        "2025-06-01T13:00:00Z", "Group msg from Bob",
        JSON.stringify(["discord:bob", "discord:alice123", "discord:me"]), "contacts-filter-group");

      // 5. SMS received from contact (contact is sender)
      insertEvent.run("phone", "cef-sms-recv", "sms:received",
        "2025-06-01T14:00:00Z", "Alice",
        JSON.stringify(["phone:+447700900123", "phone:Owner"]), "contacts-filter-alice-phone");

      // 6. SMS sent to contact (me is sender)
      insertEvent.run("phone", "cef-sms-sent", "sms:sent",
        "2025-06-01T15:00:00Z", "Alice",
        JSON.stringify(["phone:Owner", "phone:+447700900123"]), "contacts-filter-alice-phone");

      // 7. Call to contact (me is sender)
      insertEvent.run("phone", "cef-call-out", "call:outgoing",
        "2025-06-01T16:00:00Z", "Alice",
        JSON.stringify(["phone:Owner", "phone:+447700900123"]), "contacts-filter-alice-phone");

      // 8. Manual event with contact
      insertEvent.run("manual", "cef-manual", "note",
        "2025-06-01T17:00:00Z", "Met with Alice",
        JSON.stringify([`contact:${contactId}`]), null);

      db.close();
    });

    test("shows DM sent by contact", async () => {
      const res = await app.request(`/api/contacts/${contactId}/events?limit=50`);
      const json = await res.json();
      expect(json.events.some((e: { source_id: string }) => e.source_id === "cef-dm-sent")).toBe(true);
    });

    test("shows DM sent to contact", async () => {
      const res = await app.request(`/api/contacts/${contactId}/events?limit=50`);
      const json = await res.json();
      expect(json.events.some((e: { source_id: string }) => e.source_id === "cef-dm-recv")).toBe(true);
    });

    test("shows group msg sent by contact", async () => {
      const res = await app.request(`/api/contacts/${contactId}/events?limit=50`);
      const json = await res.json();
      expect(json.events.some((e: { source_id: string }) => e.source_id === "cef-group-sent")).toBe(true);
    });

    test("does not show group msg by someone else", async () => {
      const res = await app.request(`/api/contacts/${contactId}/events?limit=50`);
      const json = await res.json();
      expect(json.events.some((e: { source_id: string }) => e.source_id === "cef-group-other")).toBe(false);
    });

    test("shows SMS received from contact", async () => {
      const res = await app.request(`/api/contacts/${contactId}/events?limit=50`);
      const json = await res.json();
      expect(json.events.some((e: { source_id: string }) => e.source_id === "cef-sms-recv")).toBe(true);
    });

    test("shows SMS sent to contact", async () => {
      const res = await app.request(`/api/contacts/${contactId}/events?limit=50`);
      const json = await res.json();
      expect(json.events.some((e: { source_id: string }) => e.source_id === "cef-sms-sent")).toBe(true);
    });

    test("shows call to contact", async () => {
      const res = await app.request(`/api/contacts/${contactId}/events?limit=50`);
      const json = await res.json();
      expect(json.events.some((e: { source_id: string }) => e.source_id === "cef-call-out")).toBe(true);
    });

    test("shows manual event with contact", async () => {
      const res = await app.request(`/api/contacts/${contactId}/events?limit=50`);
      const json = await res.json();
      expect(json.events.some((e: { source_id: string }) => e.source_id === "cef-manual")).toBe(true);
    });
  });
});
