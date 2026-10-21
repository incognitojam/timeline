/**
 * Manual Events API Tests
 *
 * Tests for creating, updating, and deleting manual events.
 * Run with: bun test src/api/manual-events.test.ts
 */

// Set test mode before importing to prevent server auto-start
process.env.NODE_ENV = "test";

import { describe, test, expect, beforeAll } from "bun:test";
import { app } from "./index";
import { saveJournalSession, getAppStateDb } from "../db/app-state";
import { getDb } from "../db/schema";
import { getDefaultModel } from "../llm";

describe("Manual Events API Tests", () => {
  describe("Manual Events", () => {
    let createdEventId: number;
    let testContactId: number;

    beforeAll(async () => {
      // Create a test contact for notes with people
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        body: JSON.stringify({ displayName: "Manual Event Test Contact" }),
        headers: { "Content-Type": "application/json" },
      });
      const { contact } = await createRes.json();
      testContactId = contact.id;
    });

    test("POST /api/events/manual creates a note event", async () => {
      const res = await app.request("/api/events/manual", {
        method: "POST",
        body: JSON.stringify({
          timestamp: "2024-06-15T10:00:00Z",
          title: "Daily reflection",
          content: "Today was a good day. Made progress on the project.",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.event.source).toBe("manual");
      expect(json.event.type).toBe("note");
      expect(json.event.title).toBe("Daily reflection");
      expect(json.event.content).toContain("good day");
      expect(json.event.source_account).toBe("user");
      createdEventId = json.event.id;
    });

    test("POST /api/events/manual creates a note with people", async () => {
      const res = await app.request("/api/events/manual", {
        method: "POST",
        body: JSON.stringify({
          timestamp: "2024-06-15T14:00:00Z",
          title: "Chat with a friend",
          content: "Discussed project ideas over coffee.",
          people: [testContactId],
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.event.source).toBe("manual");
      expect(json.event.type).toBe("note");
      expect(json.event.title).toBe("Chat with a friend");
      expect(json.event.people).not.toBeNull();
    });

    test("POST /api/events/manual validates required fields", async () => {
      // Missing timestamp
      const res1 = await app.request("/api/events/manual", {
        method: "POST",
        body: JSON.stringify({
          title: "Test",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res1.status).toBe(400);

      // Missing title
      const res2 = await app.request("/api/events/manual", {
        method: "POST",
        body: JSON.stringify({
          timestamp: "2024-06-15T10:00:00Z",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res2.status).toBe(400);
    });

    test("POST /api/events/manual validates contact IDs in people array", async () => {
      const res = await app.request("/api/events/manual", {
        method: "POST",
        body: JSON.stringify({
          timestamp: "2024-06-15T10:00:00Z",
          title: "Test",
          people: [999999999], // Non-existent contact
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("Contact not found");
    });

    test("PATCH /api/events/:id updates a manual event", async () => {
      const res = await app.request(`/api/events/${createdEventId}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: "Updated: Daily reflection",
          content: "Actually a great day.",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.event.title).toBe("Updated: Daily reflection");
      expect(json.event.content).toBe("Actually a great day.");
    });

    test("PATCH /api/events/:id rejects updates to non-manual events", async () => {
      // Get a non-manual event
      const searchRes = await app.request("/api/search?limit=1");
      const searchJson = await searchRes.json();
      const nonManualEvent = searchJson.events.find((e: { source: string }) => e.source !== "manual");

      if (nonManualEvent) {
        const res = await app.request(`/api/events/${nonManualEvent.id}`, {
          method: "PATCH",
          body: JSON.stringify({ title: "Hacked" }),
          headers: { "Content-Type": "application/json" },
        });
        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.error).toContain("non-manual");
      }
    });

    test("DELETE /api/events/:id deletes a manual event", async () => {
      // Create a new event to delete
      const createRes = await app.request("/api/events/manual", {
        method: "POST",
        body: JSON.stringify({
          timestamp: "2024-06-15T10:00:00Z",
          title: "To be deleted",
        }),
        headers: { "Content-Type": "application/json" },
      });
      const { event } = await createRes.json();

      const res = await app.request(`/api/events/${event.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      // Verify it's gone
      const getRes = await app.request(`/api/events/${event.id}`);
      expect(getRes.status).toBe(404);
    });

    test("DELETE /api/events/:id rejects deletion of non-manual events", async () => {
      // Get a non-manual event
      const searchRes = await app.request("/api/search?limit=1");
      const searchJson = await searchRes.json();
      const nonManualEvent = searchJson.events.find((e: { source: string }) => e.source !== "manual");

      if (nonManualEvent) {
        const res = await app.request(`/api/events/${nonManualEvent.id}`, {
          method: "DELETE",
        });
        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.error).toContain("non-manual");
      }
    });

    test("PATCH /api/events/:id can clear content and people", async () => {
      // Create an event with content and people
      const createRes = await app.request("/api/events/manual", {
        method: "POST",
        body: JSON.stringify({
          timestamp: "2024-06-15T10:00:00Z",
          title: "Has content and people",
          content: "Some notes here",
          people: [testContactId],
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(createRes.status).toBe(201);
      const { event } = await createRes.json();
      expect(event.content).toBe("Some notes here");
      expect(event.people).not.toBeNull();

      // Clear both fields by sending null
      const updateRes = await app.request(`/api/events/${event.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          content: null,
          people: null,
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json();
      expect(updated.event.content).toBeNull();
      expect(updated.event.people).toBeNull();
    });

    test("POST /api/journal/:date/answer updates an existing journal answer in place", async () => {
      const date = "2024-06-16";

      const createRes = await app.request(`/api/journal/${date}/answer`, {
        method: "POST",
        body: JSON.stringify({
          question: "What did you learn today?",
          answer: "First answer",
          question_index: 0,
          question_category: "open",
          model: getDefaultModel(),
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();

      const updateRes = await app.request(`/api/journal/${date}/answer`, {
        method: "POST",
        body: JSON.stringify({
          event_id: created.event.id,
          question: "What did you learn today?",
          answer: "Updated answer",
          question_index: 0,
          question_category: "open",
          model: getDefaultModel(),
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json();
      expect(updated.event.id).toBe(created.event.id);
      expect(updated.event.content).toBe("Updated answer");

      const getRes = await app.request(`/api/events/${created.event.id}`);
      expect(getRes.status).toBe(200);
      const { event } = await getRes.json();
      expect(event.content).toBe("Updated answer");

      const listRes = await app.request(`/api/events?date=${date}&source=journal&limit=10`);
      expect(listRes.status).toBe(200);
      const listJson = await listRes.json();
      expect(listJson.count).toBe(1);
    });

    test("GET /api/journal/:date still finds answers on days with more than 1000 non-journal events", async () => {
      const date = "2024-06-17";
      saveJournalSession(getAppStateDb(), date, getDefaultModel(), [
        {
          question: "What stood out today?",
          category: "open",
        },
      ]);

      const db = getDb();
      const insertMany = db.transaction(() => {
        for (let i = 0; i < 1001; i++) {
          db.prepare(`
            INSERT INTO events (
              source, source_id, source_account, type, timestamp,
              title, content, raw_data
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            "manual",
            `busy-day-${i}`,
            "user",
            "note",
            `2024-06-17T12:${String(i % 60).padStart(2, "0")}:00.000Z`,
            `Busy event ${i}`,
            null,
            JSON.stringify({ seed: true, index: i }),
          );
        }
      });
      insertMany();

      const answerRes = await app.request(`/api/journal/${date}/answer`, {
        method: "POST",
        body: JSON.stringify({
          question: "What stood out today?",
          answer: "The journal answer should still be found.",
          question_index: 0,
          question_category: "open",
          model: getDefaultModel(),
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(answerRes.status).toBe(201);

      const stateRes = await app.request(
        `/api/journal/${date}?model=${encodeURIComponent(getDefaultModel())}`,
      );
      expect(stateRes.status).toBe(200);
      const state = await stateRes.json();
      expect(state.questions).toHaveLength(1);
      expect(state.questions[0].answered).toBe(true);
      expect(state.questions[0].answer).toBe("The journal answer should still be found.");
      expect(state.questions[0].event_id).toBeDefined();
    });

    test("POST /api/events/transport creates a transport event", async () => {
      const res = await app.request("/api/events/transport", {
        method: "POST",
        body: JSON.stringify({
          mode: "train",
          origin: { name: "Example Central", code: "EXC" },
          destination: { name: "Sample North", code: "SPN" },
          departure: "2024-06-15T15:13:00Z",
          arrival: "2024-06-15T17:23:00Z",
          service: "1513",
          operator: "Example Rail",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.event.source).toBe("manual");
      expect(json.event.type).toBe("transport:train");
      expect(json.event.title).toBe("1513: Example Central \u2192 Sample North");
      expect(json.event.timestamp).toContain("2024-06-15T15:13:00");
      expect(json.event.end_timestamp).toContain("2024-06-15T17:23:00");
      expect(json.event.duration_ms).toBeGreaterThan(0);

      const raw = JSON.parse(json.event.raw_data);
      expect(raw.transport.mode).toBe("train");
      expect(raw.transport.origin.code).toBe("EXC");
      expect(raw.transport.destination.code).toBe("SPN");
    });

    test("POST /api/events/transport creates a flight with code-based title", async () => {
      const res = await app.request("/api/events/transport", {
        method: "POST",
        body: JSON.stringify({
          mode: "flight",
          origin: { name: "Example Airport", code: "EXP" },
          destination: { name: "Sample Airport", code: "SMP" },
          departure: "2024-06-15T09:00:00Z",
          service: "EX123",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.event.type).toBe("transport:flight");
      // Flights prefer codes in title
      expect(json.event.title).toBe("EX123: EXP \u2192 SMP");
    });

    test("POST /api/events/transport works with codes only", async () => {
      const res = await app.request("/api/events/transport", {
        method: "POST",
        body: JSON.stringify({
          mode: "train",
          origin: { code: "EXC" },
          destination: { code: "SPN" },
          departure: "2024-06-15T15:13:00Z",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(201);
      const json = await res.json();
      // Code-only: uses codes as names in title
      expect(json.event.title).toBe("EXC \u2192 SPN");
    });

    test("POST /api/events/transport validates required fields", async () => {
      // Missing origin
      const res1 = await app.request("/api/events/transport", {
        method: "POST",
        body: JSON.stringify({
          mode: "train",
          destination: { name: "Sample North" },
          departure: "2024-06-15T15:13:00Z",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res1.status).toBe(400);

      // Empty origin (no name or code)
      const res2 = await app.request("/api/events/transport", {
        method: "POST",
        body: JSON.stringify({
          mode: "train",
          origin: {},
          destination: { name: "Sample North" },
          departure: "2024-06-15T15:13:00Z",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res2.status).toBe(400);

      // Invalid mode
      const res3 = await app.request("/api/events/transport", {
        method: "POST",
        body: JSON.stringify({
          mode: "spaceship",
          origin: { name: "Earth" },
          destination: { name: "Mars" },
          departure: "2024-06-15T15:13:00Z",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res3.status).toBe(400);
    });

    test("PATCH /api/events/transport/:id updates a transport event", async () => {
      // Create first
      const createRes = await app.request("/api/events/transport", {
        method: "POST",
        body: JSON.stringify({
          mode: "train",
          origin: { name: "Example Central", code: "EXC" },
          destination: { name: "Demo South", code: "DMS" },
          departure: "2024-06-15T10:00:00Z",
        }),
        headers: { "Content-Type": "application/json" },
      });
      const { event } = await createRes.json();

      // Update destination
      const updateRes = await app.request(`/api/events/transport/${event.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          destination: { name: "Sample North", code: "SPN" },
          arrival: "2024-06-15T12:10:00Z",
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json();
      expect(updated.event.title).toContain("Sample North");
      expect(updated.event.end_timestamp).toContain("2024-06-15T12:10:00");
    });

    test("PATCH /api/events/transport/:id can clear optional fields with null", async () => {
      // Create with all optional fields
      const createRes = await app.request("/api/events/transport", {
        method: "POST",
        body: JSON.stringify({
          mode: "train",
          origin: { name: "Example Central", code: "EXC" },
          destination: { name: "Sample North", code: "SPN" },
          departure: "2024-06-15T10:00:00Z",
          arrival: "2024-06-15T12:10:00Z",
          service: "1513",
          operator: "Example Rail",
          notes: "Coach D",
        }),
        headers: { "Content-Type": "application/json" },
      });
      const { event } = await createRes.json();
      expect(event.end_timestamp).toBeTruthy();
      expect(event.content).toBe("Coach D");

      // Clear optional fields by sending null
      const updateRes = await app.request(`/api/events/transport/${event.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          arrival: null,
          service: null,
          operator: null,
          notes: null,
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json();
      expect(updated.event.end_timestamp).toBeNull();
      expect(updated.event.duration_ms).toBeNull();
      expect(updated.event.content).toBeNull();
      // Title should update: no service, uses names
      expect(updated.event.title).toBe("Example Central \u2192 Sample North");
    });

    test("manual note with multiple people is discoverable for all contacts", async () => {
      // Create a second contact
      const createRes = await app.request("/api/contacts", {
        method: "POST",
        body: JSON.stringify({ displayName: "Manual Event Second Contact" }),
        headers: { "Content-Type": "application/json" },
      });
      const { contact: secondContact } = await createRes.json();

      // Create a note with both contacts
      const eventRes = await app.request("/api/events/manual", {
        method: "POST",
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          title: "Team meeting notes",
          people: [testContactId, secondContact.id],
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(eventRes.status).toBe(201);
      const { event } = await eventRes.json();

      // Both contacts should be able to find this event
      const res1 = await app.request(`/api/contacts/${testContactId}/events?limit=50`);
      const json1 = await res1.json();
      expect(json1.events.some((e: { id: number }) => e.id === event.id)).toBe(true);

      const res2 = await app.request(`/api/contacts/${secondContact.id}/events?limit=50`);
      const json2 = await res2.json();
      expect(json2.events.some((e: { id: number }) => e.id === event.id)).toBe(true);
    });
  });
});
