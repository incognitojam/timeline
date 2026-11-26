/**
 * API Smoke Tests
 *
 * General endpoint checks for health, search, attachments, and error handling.
 * Run with: bun test src/api/api.test.ts
 */

// Set test mode before importing to prevent server auto-start
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { MAX_TIMEOUT_DELAY_MS } from "../config/types";
import {
  deleteSyncState,
  getAppStateDb,
  getSyncState,
  setBlockedNetworks,
  setSpotifyResource,
  setSyncState,
} from "../db/app-state";
import { upsertIdentity } from "../db/identities";
import {
  recordPlaylistCreatedAt,
  recordPlaylistObservation,
} from "../platforms/spotify/playlist-follows";
import { getDb } from "../db/schema";
import type { Database } from "../db/sqlite";
import { findUnprocessedFiles, hashFile, markFileProcessed } from "../inbox/tracker";
import { seed } from "../testing/seed";
import type { AttachmentsStats } from "../shared/attachments";
import type {
  MusicExclusionRequest,
  MusicExclusionsResponse,
  MusicPlayedPlaylist,
  MusicRankingsOverview,
} from "../platforms/spotify/shared/music";
import {
  LocalMediaStore,
  type RemoteBlobStore,
  setMediaStoreOverride,
  WriteThroughMediaStore,
} from "../media/storage";
import { cancelJob, enqueueJob } from "../jobs/store";
import { getDefaultModel } from "../llm";
import { parseInterval } from "../config";
import { SYNC_SOURCES } from "../sync/sources";
import { app, fetchApiRequest } from "./index";
import { setSyncConfigChangedNotifier } from "./service-control";
import { setServiceComponents } from "./status";
import { createSyncSourceRoutes } from "./sync-sources";

function expectServerTimings(response: Response, names: string[]): void {
  const header = response.headers.get("server-timing");
  expect(header).not.toBeNull();
  for (const name of names) {
    expect(header).toContain(`${name};dur=`);
  }
}

describe("API Smoke Tests", () => {
  describe("Health & Status", () => {
    test("API request logs include an ISO completion timestamp", async () => {
      const logSpy = spyOn(console, "log").mockImplementation(() => {});

      try {
        const res = await app.request("/api/health");
        expect(res.status).toBe(200);

        const logEntry = logSpy.mock.calls
          .map(([message]) => {
            if (typeof message !== "string") return null;
            try {
              return JSON.parse(message) as Record<string, unknown>;
            } catch {
              return null;
            }
          })
          .find((entry) => entry?.event === "request.complete" && entry.path === "/api/health");

        expect(logEntry).toBeDefined();
        const timestamp = logEntry?.timestamp;
        expect(timestamp).toBeString();
        if (typeof timestamp !== "string") throw new Error("Expected timestamp to be a string");
        expect(new Date(timestamp).toISOString()).toBe(timestamp);
      } finally {
        logSpy.mockRestore();
      }
    });

    test("GET /api/health returns healthy status", async () => {
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("healthy");
      expect(json.database).toBe("connected");
      // No version.json in the test workspace, so this exercises the git
      // fallback (tests always run inside the repo checkout).
      expect(json.version).not.toBeNull();
      expect(json.version.commitFull).toMatch(/^[0-9a-f]{40}$/);
      expect(json.version.commit).toBe(json.version.commitFull.slice(0, 7));
    });

    test("GET /api/stats returns event statistics", async () => {
      const res = await app.request("/api/stats");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("total_events");
      expect(json).toHaveProperty("sources");
      expect(json).toHaveProperty("date_range");
    });

    test("GET /api/day returns events and attachments map", async () => {
      const res = await app.request("/api/day?date=2099-01-01");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("date", "2099-01-01");
      expect(json).toHaveProperty("events");
      expect(Array.isArray(json.events)).toBe(true);
      expect(json).toHaveProperty("attachments");
      expect(typeof json.attachments).toBe("object");
      expect(json).toHaveProperty("summary");
      expect(json.summary).toHaveProperty("totalEvents");
      expect(json.summary).toHaveProperty("bySource");
    });

    test("GET /api/day/:date/summary streams summary + metadata", async () => {
      const res = await app.request("/api/day/2099-01-01/summary");
      expect(res.status).toBe(200);
      // Response is streamed: summary text + \0 + JSON metadata
      const body = await res.text();
      const delimiterIdx = body.indexOf("\0");
      expect(delimiterIdx).toBeGreaterThanOrEqual(0);
      const summaryText = body.slice(0, delimiterIdx);
      const json = JSON.parse(body.slice(delimiterIdx + 1));
      expect(summaryText).toBe("No events found for this day.");
      expect(json).toHaveProperty("date", "2099-01-01");
      expect(json).toHaveProperty("tokenCount");
      expect(json).toHaveProperty("eventCount");
      expect(json).toHaveProperty("model");
      expect(json).toHaveProperty("cached");
      expect(json).toHaveProperty("metadata");
    });

    test("GET /api/summary/models returns model list", async () => {
      const res = await app.request("/api/summary/models");
      expect(res.status).toBe(200);
      const json = await res.json();
      // The test preload configures an offline provider, so its default model is listed.
      const model = json.models.find((entry: { id: string }) => entry.id === getDefaultModel());
      expect(model).toMatchObject({ name: expect.any(String), price: expect.any(String), contextLength: expect.any(Number) });
    });

    test("GET /api/timeline/dates returns pre-aggregated date activity", async () => {
      const db = getDb();
      const insert = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, location_name, raw_data
        ) VALUES (?, ?, 'test', 'test:event', ?, ?, '{}')
      `);
      insert.run("dates-alpha", "dates-one", "2098-05-04T12:00:00Z", null);
      insert.run(
        "dates-alpha",
        "dates-two",
        "2098-05-04T23:59:59.999Z",
        "Example Place",
      );
      insert.run("dates-beta", "dates-three", "2098-05-04T15:00:00Z", null);
      db.close();

      const res = await app.request(
        "/api/timeline/dates?startDate=2098-05-04&endDate=2098-05-04",
      );
      expect(res.status).toBe(200);
      expectServerTimings(res, ["timeline.dates"]);
      expect(await res.json()).toEqual({
        dates: [
          {
            date: "2098-05-04",
            eventCount: 3,
            sources: ["dates-alpha", "dates-beta"],
            hasLocation: true,
          },
        ],
      });
    });

    test("GET /api/timeline/date-index returns the complete lightweight index", async () => {
      const res = await app.request("/api/timeline/date-index");
      expect(res.status).toBe(200);
      expectServerTimings(res, ["timeline.date-index"]);
      const json = (await res.json()) as {
        dates: Array<Record<string, unknown>>;
      };
      const seededDate = json.dates.find(
        (date) => date.date === "2098-05-04",
      );

      expect(seededDate).toEqual({
        date: "2098-05-04",
        eventCount: 3,
      });
    });

    test("GET /api/conversations/sources returns conversation source list", async () => {
      const db = getDb();
      db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
        VALUES ('discord', 'conversation-sources-api-1', 'alice', 'message:dm', '2026-01-01T00:00:00Z', 'API source list', 'hello', '{}', 'api-source-list-thread')
      `).run();
      db.close();

      const res = await app.request("/api/conversations/sources");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("sources");
      expect(json.sources).toContain("discord");
    });
  });

  describe("Search source excludes", () => {
    beforeAll(() => {
      const db = getDb();
      const insert = db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
        VALUES (?, ?, 'alice', ?, ?, ?, 'zebraexclude probe', '{}', ?)
      `);
      insert.run("conductor", "exclude-test-agent", "conductor:message:assistant", "2099-12-31T00:00:00Z", "zebraexclude agent transcript", "exclude-test-agent-thread");
      insert.run("discord", "exclude-test-chat", "message:dm", "2099-12-30T00:00:00Z", "zebraexclude chat message", "exclude-test-chat-thread");
      db.close();
    });

    test("GET /api/search excludes noisy sources by default", async () => {
      const res = await app.request("/api/search?q=zebraexclude");
      expect(res.status).toBe(200);
      const json = await res.json();
      const sources = json.events.map((e: { source: string }) => e.source);
      expect(sources).toContain("discord");
      expect(sources).not.toContain("conductor");
    });

    test("GET /api/search with empty exclude_sources includes everything", async () => {
      const res = await app.request("/api/search?q=zebraexclude&exclude_sources=");
      expect(res.status).toBe(200);
      const json = await res.json();
      const sources = json.events.map((e: { source: string }) => e.source);
      expect(sources).toContain("discord");
      expect(sources).toContain("conductor");
    });

    test("GET /api/search explicit source filter wins over default excludes", async () => {
      const res = await app.request("/api/search?q=zebraexclude&source=conductor");
      expect(res.status).toBe(200);
      const json = await res.json();
      const sources = json.events.map((e: { source: string }) => e.source);
      expect(sources).toContain("conductor");
    });

    test("GET /api/search stops before dispatch for an aborted request", async () => {
      const controller = new AbortController();
      controller.abort();

      const res = await app.request(new Request("http://localhost/api/search?q=cancelled", {
        signal: controller.signal,
      }));

      expect(res.status).toBe(499);
      expect(await res.json()).toEqual({ error: "Request cancelled" });
    });

    test("GET /api/recent excludes noisy sources by default", async () => {
      const defaultRes = await app.request("/api/recent?limit=10");
      expect(defaultRes.status).toBe(200);
      const defaultSources = (await defaultRes.json()).events.map((e: { source: string }) => e.source);
      expect(defaultSources).toContain("discord");
      expect(defaultSources).not.toContain("conductor");

      const allRes = await app.request("/api/recent?limit=10&exclude_sources=");
      expect(allRes.status).toBe(200);
      const allSources = (await allRes.json()).events.map((e: { source: string }) => e.source);
      expect(allSources).toContain("conductor");
    });
  });

  describe("Eval cases", () => {
    const post = (path: string, body: unknown, method = "POST") =>
      app.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    test("eval case CRUD lifecycle", async () => {
      const createRes = await post("/api/eval/cases", {
        name: "smoke-paraphrase",
        category: "paraphrase-gap",
        notes: "smoke test case",
        queries: ["first phrasing"],
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()).case;
      expect(created.queries).toHaveLength(1);

      const dupRes = await post("/api/eval/cases", { name: "smoke-paraphrase", category: "era" });
      expect(dupRes.status).toBe(409);

      const listRes = await app.request("/api/eval/cases");
      expect(listRes.status).toBe(200);
      const listed = (await listRes.json()).cases.find(
        (c: { id: number }) => c.id === created.id
      );
      expect(listed.query_count).toBe(1);

      const queryRes = await post(`/api/eval/cases/${created.id}/queries`, { text: "second phrasing" });
      expect(queryRes.status).toBe(201);

      const badExpectation = await post(`/api/eval/cases/${created.id}/expectations`, { kind: "event" });
      expect(badExpectation.status).toBe(400);

      const eventExpectation = await post(`/api/eval/cases/${created.id}/expectations`, {
        kind: "event",
        event_id: 12345,
        source: "discord",
        event_timestamp: "2026-01-01T00:00:00Z",
        grade: 2,
      });
      expect(eventExpectation.status).toBe(201);
      const expectationId = (await eventExpectation.json()).expectation.id;

      const rangeExpectation = await post(`/api/eval/cases/${created.id}/expectations`, {
        kind: "range",
        start_timestamp: "2026-01-01T00:00:00Z",
        end_timestamp: "2026-01-02T00:00:00Z",
        conversation_id: "thread-1",
        grade: 1,
      });
      expect(rangeExpectation.status).toBe(201);

      const regrade = await post(`/api/eval/expectations/${expectationId}`, { grade: 1 }, "PATCH");
      expect(regrade.status).toBe(200);
      expect((await regrade.json()).expectation.grade).toBe(1);

      const detailRes = await app.request(`/api/eval/cases/${created.id}`);
      const detail = (await detailRes.json()).case;
      expect(detail.queries).toHaveLength(2);
      expect(detail.expectations).toHaveLength(2);

      const deleteRes = await app.request(`/api/eval/cases/${created.id}`, { method: "DELETE" });
      expect(deleteRes.status).toBe(200);
      const goneRes = await app.request(`/api/eval/cases/${created.id}`);
      expect(goneRes.status).toBe(404);
    });
  });

  describe("Semantic search", () => {
    test("GET /api/search/semantic without q returns 400", async () => {
      const res = await app.request("/api/search/semantic");
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("q is required");
    });

    test("GET /api/search/semantic with invalid limit returns 400", async () => {
      const res = await app.request("/api/search/semantic?q=test&limit=0");
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("limit");
    });

    test("GET /api/search/semantic without embeddings config returns 503", async () => {
      const res = await app.request("/api/search/semantic?q=test");
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error).toContain("not configured");
    });
  });

  describe("Conversation range export", () => {
    test("POST /api/conversation/export-range returns rendered range", async () => {
      const db = getDb();
      const first = db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, people, raw_data, conversation_id)
        VALUES ('discord', 'range-api-1', 'alice', 'message:guild', '2026-01-01T00:00:00Z', 'API range', 'hello', '["discord:1000000000000000000"]', '{}', '9100000000000000000')
      `).run();
      const second = db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, content, people, raw_data, conversation_id)
        VALUES ('discord', 'range-api-2', 'alice', 'message:guild', '2026-01-01T00:01:00Z', 'API range', 'there', '["discord:1000000000000000000"]', '{}', '9100000000000000000')
      `).run();
      db.close();

      const res = await app.request("/api/conversation/export-range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startEventId: Number(first.lastInsertRowid),
          endEventId: Number(second.lastInsertRowid),
          format: {
            timestampStyle: "full-timestamps",
          },
        }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.eventCount).toBe(2);
      expect(json.tokenCount).toBeGreaterThan(0);
      expect(json.text).toContain("hello");
      expect(json.text).toContain("there");
      expect(json.text).not.toContain("### 2026-01-01");
      expect(json.text).toContain("2026-01-01 00:00");
      expect(json.range.conversationId).toBe("9100000000000000000");
    });

    test("POST /api/conversation/export-range rejects invalid format options", async () => {
      const res = await app.request("/api/conversation/export-range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startEventId: 1,
          endEventId: 2,
          format: {
            timestampStyle: "full",
          },
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("format.timestampStyle must be one of: date-headers, full-timestamps");
    });

    test("POST /api/conversation/export-range rejects non-boolean includeReactions", async () => {
      const res = await app.request("/api/conversation/export-range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startEventId: 1,
          endEventId: 2,
          format: {
            includeReactions: "yes",
          },
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("format.includeReactions must be a boolean");
    });

    test("POST /api/conversation/export-range rejects invalid time zones", async () => {
      const res = await app.request("/api/conversation/export-range", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startEventId: 1,
          endEventId: 2,
          format: {
            timeZone: "Not/AZone",
          },
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("format.timeZone must be a valid IANA time zone");
    });
  });

  describe("Conversation metadata", () => {
    test("GET /api/conversation/around resolves a forwarded Discord message", async () => {
      const db = getDb();
      const original = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, title, content,
          people, raw_data, conversation_id
        ) VALUES (
          'discord',
          '9100000000000000200',
          'alice',
          'message:guild',
          '2026-01-01T00:00:00Z',
          'API Test Server #original',
          'Original message',
          '["discord:1000000000000000000"]',
          json(?),
          '9200000000000000200'
        )
      `).run(JSON.stringify({
        _channel: {
          id: "9200000000000000200",
          name: "original",
          type: "GuildTextChat",
          guild_id: "9400000000000000200",
          guild_name: "API Test Server",
        },
      }));
      db.prepare(
        "INSERT OR REPLACE INTO discord_guilds (guild_id, icon) VALUES (?, ?)",
      ).run("9400000000000000200", "test-icon-hash");
      db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, title, content,
          people, raw_data, conversation_id
        ) VALUES (
          'discord',
          '9100000000000000200',
          'bob',
          'message:guild',
          '2026-01-01T00:00:00Z',
          'Another API Test Server #original',
          'Another account copy',
          '["discord:2000000000000000000"]',
          '{}',
          '9200000000000000299'
        )
      `).run();
      const forwarded = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, title, content,
          people, raw_data, conversation_id
        ) VALUES (
          'discord',
          '9100000000000000201',
          'alice',
          'message:group:forward',
          '2026-01-02T00:00:00Z',
          'Alice and Bob',
          NULL,
          '["discord:1000000000000000000"]',
          json(?),
          '9300000000000000200'
        )
      `).run(JSON.stringify({
        message_reference: {
          type: 1,
          message_id: "9100000000000000200",
          channel_id: "9200000000000000200",
          guild_id: "9400000000000000200",
        },
        message_snapshots: [{ message: { content: "Original message" } }],
        _channel: {
          id: "9300000000000000200",
          name: "Alice and Bob",
          type: "GroupDirectMessage",
          guild_id: null,
          guild_name: null,
        },
      }));
      db.close();

      const forwardedEventId = Number(forwarded.lastInsertRowid);
      const params = new URLSearchParams({
        source: "discord",
        conversationId: "9300000000000000200",
        eventId: String(forwardedEventId),
      });
      const res = await app.request(`/api/conversation/around?${params}`);

      expect(res.status).toBe(200);
      const json = await res.json();
      const event = json.events.find((candidate: { id: number }) => candidate.id === forwardedEventId);
      expect(event).toMatchObject({
        forwarded_from: {
          event_id: Number(original.lastInsertRowid),
          conversation_id: "9200000000000000200",
          timestamp: "2026-01-01T00:00:00Z",
          source_name: "API Test Server",
          source_icon_url: "https://cdn.discordapp.com/icons/9400000000000000200/test-icon-hash.png?size=128",
        },
      });
    });

    test("GET /api/conversation/around resolves a Discord reply preview", async () => {
      const db = getDb();
      const original = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, title, content,
          people, raw_data, conversation_id
        ) VALUES (
          'discord',
          '9100000000000000300',
          'alice',
          'message:group',
          '2026-03-01T00:00:00Z',
          'Alice and Bob',
          'The original message',
          '["discord:1000000000000000000"]',
          json(?),
          '9300000000000000300'
        )
      `).run(JSON.stringify({
        author: { id: "1000000000000000000", username: "bob", global_name: "Bob B" },
      }));
      const reply = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, title, content,
          people, raw_data, conversation_id
        ) VALUES (
          'discord',
          '9100000000000000301',
          'alice',
          'message:group',
          '2026-03-01T00:01:00Z',
          'Alice and Bob',
          'Replying now',
          '["discord:2000000000000000000"]',
          json(?),
          '9300000000000000300'
        )
      `).run(JSON.stringify({
        author: { id: "2000000000000000000", username: "alice", global_name: "Alice A" },
        message_reference: { type: 0, message_id: "9100000000000000300", channel_id: "9300000000000000300" },
      }));
      db.close();

      const replyEventId = Number(reply.lastInsertRowid);
      const params = new URLSearchParams({
        source: "discord",
        conversationId: "9300000000000000300",
        eventId: String(replyEventId),
      });
      const res = await app.request(`/api/conversation/around?${params}`);

      expect(res.status).toBe(200);
      const json = await res.json();
      const event = json.events.find((candidate: { id: number }) => candidate.id === replyEventId);
      expect(event).toMatchObject({
        replied_to: {
          event_id: Number(original.lastInsertRowid),
          conversation_id: "9300000000000000300",
          author_name: "Bob B",
          content: "The original message",
          has_attachment: false,
        },
      });
    });

    test("GET /api/conversation includes Discord server breadcrumb metadata", async () => {
      const db = getDb();
      db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, title, content,
          people, raw_data, conversation_id
        ) VALUES (
          'discord',
          'conversation-server-meta-api-1',
          'alice',
          'message:guild',
          '2026-01-01T00:00:00Z',
          'API Test Server #general',
          'hello',
          '["discord:1000000000000000000"]',
          json(?),
          '9100000000000000100'
        )
      `).run(JSON.stringify({
        _channel: {
          id: "9100000000000000100",
          name: "general",
          type: "GuildTextChat",
          guild_id: "9000000000000000100",
          guild_name: "API Test Server",
        },
      }));
      db.close();

      const params = new URLSearchParams({
        source: "discord",
        conversationId: "9100000000000000100",
      });
      const res = await app.request(`/api/conversation?${params}`);

      expect(res.status).toBe(200);
      expectServerTimings(res, [
        "conversation.events",
        "conversation.metadata",
        "conversation.references",
        "conversation.attachments",
        "conversation.participants",
      ]);
      const json = await res.json();
      expect(json.server).toEqual({
        source: "discord",
        id: "9000000000000000100",
        name: "API Test Server",
      });
      expect(json.title).toBe("API Test Server #general");
    });

    test("GET /api/conversation/around includes Discord server breadcrumb metadata", async () => {
      const db = getDb();
      const inserted = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, title, content,
          people, raw_data, conversation_id
        ) VALUES (
          'discord',
          'conversation-server-meta-around-api-1',
          'alice',
          'message:guild',
          '2026-01-01T00:00:00Z',
          'API Around Server #general',
          'hello',
          '["discord:1000000000000000000"]',
          json(?),
          '9100000000000000101'
        )
      `).run(JSON.stringify({
        _channel: {
          id: "9100000000000000101",
          name: "general",
          type: "GuildTextChat",
          guild_id: "9000000000000000101",
          guild_name: "API Around Server",
        },
      }));
      db.close();

      const params = new URLSearchParams({
        source: "discord",
        conversationId: "9100000000000000101",
        eventId: String(inserted.lastInsertRowid),
      });
      const res = await app.request(`/api/conversation/around?${params}`);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.server).toEqual({
        source: "discord",
        id: "9000000000000000101",
        name: "API Around Server",
      });
      expect(json.title).toBe("API Around Server #general");
    });

    test("GET /api/conversation/stats and /media accept conversationId", async () => {
      const db = getDb();
      db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, title, content,
          people, raw_data, conversation_id
        ) VALUES (
          'discord',
          'conversation-stats-media-api-1',
          'alice',
          'message:guild',
          '2026-01-02T00:00:00Z',
          'API Stats Server #general',
          'hello',
          '["discord:1000000000000000000"]',
          '{}',
          '9100000000000000102'
        )
      `).run();
      db.close();

      const params = new URLSearchParams({
        source: "discord",
        conversationId: "9100000000000000102",
      });

      const statsRes = await app.request(`/api/conversation/stats?${params}`);
      expect(statsRes.status).toBe(200);
      expectServerTimings(statsRes, [
        "conversation.stats.summary",
        "conversation.stats.bounds",
        "conversation.stats.participants",
        "conversation.stats.identities",
        "conversation.stats.attachments",
        "conversation.stats.activity",
        "conversation.stats.titles",
      ]);
      const statsJson = await statsRes.json();
      expect(statsJson.totalMessages).toBe(1);

      const mediaRes = await app.request(`/api/conversation/media?${params}`);
      expect(mediaRes.status).toBe(200);
      const mediaJson = await mediaRes.json();
      expect(mediaJson.attachments).toEqual([]);
      expect(mediaJson.nextCursor).toBeNull();
    });

    test("GET /api/conversation/stats aggregates token usage for AI sources", async () => {
      const db = getDb();
      const insert = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, title, content,
          people, raw_data, conversation_id
        ) VALUES ('claude-code', ?, 'alice', ?, ?, 'Usage Test Session', ?, '["claude-code:alice"]', json(?), 'usage-test-session-1')
      `);
      insert.run("usage-stats-api-1", "claude-code:message:user", "2026-01-03T00:00:00Z", "hi", JSON.stringify({}));
      insert.run("usage-stats-api-2", "claude-code:message:assistant", "2026-01-03T00:00:01Z", "hello", JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 400 },
      }));
      insert.run("usage-stats-api-3", "claude-code:message:assistant", "2026-01-03T00:00:02Z", "more", JSON.stringify({
        model: "unpriced-model-x",
        usage: { input_tokens: 50, output_tokens: 60 },
      }));
      db.close();

      const params = new URLSearchParams({ source: "claude-code", conversationId: "usage-test-session-1" });
      const res = await app.request(`/api/conversation/stats?${params}`);
      expect(res.status).toBe(200);
      expectServerTimings(res, ["conversation.stats.usage"]);
      const json = await res.json();

      expect(json.tokenUsage.assistantMessages).toBe(2);
      expect(json.tokenUsage.inputTokens).toBe(150);
      expect(json.tokenUsage.outputTokens).toBe(260);
      expect(json.tokenUsage.cacheReadTokens).toBe(1000);
      expect(json.tokenUsage.cacheCreationTokens).toBe(400);
      // haiku-4-5: (100×$1 + 200×$5 + 1000×$0.10 + 400×$1.25) / 1M; unpriced model excluded
      expect(json.tokenUsage.estimatedCostUsd).toBeCloseTo(0.0017, 6);
      expect(json.tokenUsage.byModel).toHaveLength(2);
      const unpriced = json.tokenUsage.byModel.find((m: { model: string }) => m.model === "unpriced-model-x");
      expect(unpriced.costUsd).toBeNull();
    });

    test("GET /api/conversation/stats returns null tokenUsage for non-AI sources", async () => {
      const params = new URLSearchParams({ source: "discord", conversationId: "9100000000000000102" });
      const res = await app.request(`/api/conversation/stats?${params}`);
      expect(res.status).toBe(200);
      expect((await res.json()).tokenUsage).toBeNull();
    });

    test("conversation endpoints reject missing conversationId", async () => {
      const base = new URLSearchParams({ source: "discord" });

      expect((await app.request(`/api/conversation?${base}`)).status).toBe(400);
      expect((await app.request(`/api/conversation/stats?${base}`)).status).toBe(400);
      expect((await app.request(`/api/conversation/media?${base}`)).status).toBe(400);

      const around = new URLSearchParams({ source: "discord", eventId: "1" });
      expect((await app.request(`/api/conversation/around?${around}`)).status).toBe(400);
    });
  });

  describe("Playlists", () => {
    const PLAYLIST_ID = "testplaylist0000000001";
    const COVER_URL = "https://i.scdn.co/image/testcover300";

    beforeAll(() => {
      const db = getDb();
      recordPlaylistObservation(db, {
        playlistId: PLAYLIST_ID,
        observedDate: "2024-01-01",
        observedAt: "2024-01-01T12:00:00.000Z",
        followerCount: 10,
        name: "Test Mix",
        origin: "seed",
      });
      recordPlaylistObservation(db, {
        playlistId: PLAYLIST_ID,
        observedDate: "2024-02-01",
        observedAt: "2024-02-01T12:00:00.000Z",
        followerCount: 14,
        name: "Test Mix",
        origin: "api",
      });
      recordPlaylistCreatedAt(db, {
        playlistId: PLAYLIST_ID,
        createdAt: "2021-06-01T10:30:00.000Z",
        checkedAt: "2024-02-01T12:00:00.000Z",
      });
      db.close();
      setSpotifyResource(
        getAppStateDb(),
        `spotify:playlist:${PLAYLIST_ID}`,
        "playlist",
        "Test Mix",
        COVER_URL,
      );
    });

    test("GET /api/playlists lists tracked playlists with a series", async () => {
      const res = await app.request("/api/playlists");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(Array.isArray(json.playlists)).toBe(true);
      const p = json.playlists.find(
        (x: { playlistId: string }) => x.playlistId === PLAYLIST_ID,
      );
      expect(p).toBeDefined();
      expect(p.name).toBe("Test Mix");
      expect(p.imageUrl).toBe(COVER_URL);
      expect(p.latestCount).toBe(14);
      expect(p.firstDate).toBe("2024-01-01");
      expect(p.latestDate).toBe("2024-02-01");
      expect(p.createdDate).toBe("2021-06-01"); // creation proxy, date-only
      expect(p.series).toEqual([
        { date: "2024-01-01", count: 10 },
        { date: "2024-02-01", count: 14 },
      ]);
    });

    test("GET /api/playlists/:id returns the full series oldest-first", async () => {
      const res = await app.request(`/api/playlists/${PLAYLIST_ID}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.playlistId).toBe(PLAYLIST_ID);
      expect(json.name).toBe("Test Mix");
      expect(json.imageUrl).toBe(COVER_URL);
      expect(json.createdDate).toBe("2021-06-01"); // creation proxy, date-only
      expect(json.observations.length).toBe(2);
      expect(json.observations[0]).toEqual({
        date: "2024-01-01",
        count: 10,
        origin: "seed",
      });
    });

    test("GET /api/playlists/:id is empty for an untracked id", async () => {
      const res = await app.request("/api/playlists/nonexistent00000000001");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.observations).toEqual([]);
      expect(json.name).toBeNull();
      expect(json.imageUrl).toBeNull();
      expect(json.createdDate).toBeNull();
    });

    test("GET /api/music/friends/latest returns latest listen per resolved friend", async () => {
      const db = getDb();
      const contact = db.prepare("INSERT INTO contacts (display_name) VALUES (?) RETURNING id").get(
        "Alice Friend",
      ) as { id: number };
      upsertIdentity(db, {
        platform: "spotify",
        platformId: "alice_spotify",
        displayName: "Alice Spotify",
        avatarUrl: "https://example.com/alice.jpg",
      });
      db.prepare("UPDATE identities SET contact_id = ? WHERE platform = 'spotify' AND platform_id = ?").run(
        contact.id,
        "alice_spotify",
      );
      upsertIdentity(db, {
        platform: "spotify",
        platformId: "bob_spotify",
        displayName: "Bob Spotify",
      });

      const insert = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp,
          title, content, people, tags, raw_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        "spotify-friends",
        "sf-alice-old",
        "alice_spotify",
        "listen:track:friend",
        "2024-03-01T10:00:00.000Z",
        "Old Song",
        "Old Song by Test Artist",
        JSON.stringify(["spotify:alice_spotify"]),
        JSON.stringify(["artist:Test Artist"]),
        JSON.stringify({
          user: { name: "Alice Raw" },
          track: { album: { name: "Old Album" }, imageUrl: "https://example.com/old.jpg" },
        }),
      );
      insert.run(
        "spotify-friends",
        "sf-alice-new",
        "alice_spotify",
        "listen:track:friend",
        "2024-03-02T10:00:00.000Z",
        "New Song",
        "New Song by New Artist",
        JSON.stringify(["spotify:alice_spotify"]),
        JSON.stringify(["artist:New Artist"]),
        JSON.stringify({
          user: { name: "Alice Raw" },
          track: { album: { name: "New Album" }, imageUrl: "https://example.com/new.jpg" },
        }),
      );
      insert.run(
        "spotify-friends",
        "sf-bob-new",
        "bob_spotify",
        "listen:track:friend",
        "2024-03-03T10:00:00.000Z",
        "Bob Song",
        "Bob Song by Bob Artist",
        JSON.stringify(["spotify:bob_spotify"]),
        JSON.stringify(["artist:Bob Artist"]),
        JSON.stringify({
          user: { name: "Bob Raw" },
          track: { album: { name: "Bob Album" }, imageUrl: "https://example.com/bob.jpg" },
        }),
      );
      db.close();

      const res = await app.request("/api/music/friends/latest");
      expect(res.status).toBe(200);
      const json = await res.json();
      const alice = json.friends.find(
        (friend: { person: string }) => friend.person === "spotify:alice_spotify",
      );
      const bob = json.friends.find(
        (friend: { person: string }) => friend.person === "spotify:bob_spotify",
      );
      expect(alice).toMatchObject({
        contactId: contact.id,
        name: "Alice Friend",
        avatarUrl: "https://example.com/alice.jpg",
        trackName: "New Song",
        artistName: "New Artist",
        albumName: "New Album",
        imageUrl: "https://example.com/new.jpg",
      });
      expect(bob).toMatchObject({
        contactId: null,
        name: "Bob Spotify",
        trackName: "Bob Song",
        artistName: "Bob Artist",
      });
    });

    test("GET /api/music/recent returns recent plays with cached artwork", async () => {
      const db = getDb();
      db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, duration_ms,
          title, content, tags, raw_data
        ) VALUES ('spotify', ?, 'listener', 'listen:track', ?, ?, ?, ?, ?, ?)
      `).run(
        "spotify:track:recent-example@2099-04-05",
        "2099-04-05T10:00:00.000Z",
        200_000,
        "Recent Example",
        "Recent Example by Recent Artist",
        JSON.stringify(["android"]),
        JSON.stringify({
          spotify_track_uri: "spotify:track:recent-example",
          master_metadata_album_artist_name: "Recent Artist",
          master_metadata_album_album_name: "Example Album",
        }),
      );
      db.close();
      setSpotifyResource(
        getAppStateDb(),
        "spotify:track:recent-example",
        "track",
        "Recent Example",
        "https://example.com/cached.jpg",
      );

      const res = await app.request("/api/music/recent");
      expect(res.status).toBe(200);
      expect((await res.json()).recent[0]).toMatchObject({
        trackName: "Recent Example",
        artistName: "Recent Artist",
        albumName: "Example Album",
        imageUrl: "https://example.com/cached.jpg",
      });
    });

    test("GET /api/music/rankings ranks tracks and artists", async () => {
      const db = getDb();
      const insert = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, duration_ms,
          title, content, tags, raw_data
        ) VALUES ('spotify', ?, 'listener', 'listen:track', ?, ?, ?, ?, ?, ?)
      `);
      for (const [index, timestamp] of [
        "2098-04-01T10:00:00.000Z",
        "2098-04-02T10:00:00.000Z",
        "2098-04-03T10:00:00.000Z",
      ].entries()) {
        insert.run(
          `spotify:track:ranked-example@${index}`,
          timestamp,
          180_000,
          "Ranked Example",
          "Ranked Example by Example Artist, Guest Artist",
          JSON.stringify(["artist:Example Artist", "artist:Guest Artist", "album:Example Album"]),
          JSON.stringify({
            track: {
              uri: "spotify:track:ranked-example",
              album: {
                name: "Example Album",
                images: [
                  { url: "https://example.com/large.jpg", height: 640 },
                  { url: "https://example.com/medium.jpg", height: 300 },
                ],
              },
            },
          }),
        );
      }
      insert.run(
        "spotify:track:exported@2098-04-05",
        "2098-04-05T10:00:00.000Z",
        200_000,
        "Exported Song",
        "Exported Song by Export Artist",
        JSON.stringify(["android"]),
        JSON.stringify({
          spotify_track_uri: "spotify:track:exported",
          master_metadata_album_artist_name: "Export Artist",
          master_metadata_album_album_name: "Export Album",
        }),
      );
      db.close();

      const res = await app.request("/api/music/rankings?period=all");
      expect(res.status).toBe(200);
      const json = await res.json();
      const rankedTrack = json.topTracks.find(
        (track: { trackName: string }) => track.trackName === "Ranked Example",
      );
      const exampleArtist = json.topArtists.find(
        (artist: { artistName: string }) => artist.artistName === "Example Artist",
      );
      const guestArtist = json.topArtists.find(
        (artist: { artistName: string }) => artist.artistName === "Guest Artist",
      );
      const exportedTrack = json.topTracks.find(
        (track: { trackName: string }) => track.trackName === "Exported Song",
      );
      const exportArtist = json.topArtists.find(
        (artist: { artistName: string }) => artist.artistName === "Export Artist",
      );

      expect(json).toMatchObject({ period: "all", periodStart: null });
      expect(rankedTrack).toMatchObject({
        artistName: "Example Artist, Guest Artist",
        albumName: "Example Album",
        imageUrl: "https://example.com/medium.jpg",
        playCount: 3,
        listeningMs: 540_000,
      });
      expect(exampleArtist).toMatchObject({ playCount: 3, latestTrackName: "Ranked Example" });
      expect(guestArtist).toMatchObject({ playCount: 3, latestTrackName: "Ranked Example" });
      expect(exportedTrack).toMatchObject({
        artistName: "Export Artist",
        albumName: "Export Album",
      });
      expect(exportArtist).toMatchObject({ playCount: 1, latestTrackName: "Exported Song" });
    });

    test("GET /api/music/rankings falls back to track length when a play has no measured duration", async () => {
      const db = getDb();
      // API-synced plays carry no listened-time equivalent of the export's
      // ms_played, so duration_ms is NULL and the track length in raw_data is
      // the only signal available.
      db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, duration_ms,
          title, content, tags, raw_data
        ) VALUES ('spotify', ?, 'listener', 'listen:track', ?, NULL, ?, ?, ?, ?)
      `).run(
        "spotify:track:api-only@2098-05-01",
        "2098-05-01T10:00:00.000Z",
        "Api Only Song",
        "Api Only Song by Api Artist",
        JSON.stringify(["api", "artist:Api Artist"]),
        JSON.stringify({
          track: { uri: "spotify:track:api-only", name: "Api Only Song", duration_ms: 210_000 },
        }),
      );
      db.close();

      const res = await app.request("/api/music/rankings?period=all");
      expect(res.status).toBe(200);
      const json = await res.json();

      const apiTrack = json.topTracks.find(
        (track: { trackName: string }) => track.trackName === "Api Only Song",
      );
      const apiArtist = json.topArtists.find(
        (artist: { artistName: string }) => artist.artistName === "Api Artist",
      );

      expect(apiTrack).toMatchObject({ playCount: 1, listeningMs: 210_000 });
      expect(apiArtist).toMatchObject({ playCount: 1, listeningMs: 210_000 });
      // The estimate is a read-time fallback only — the stored event keeps a
      // NULL duration so measured and inferred time stay distinguishable.
      const stored = getDb()
        .prepare("SELECT duration_ms AS v FROM events WHERE source_id = ?")
        .get("spotify:track:api-only@2098-05-01") as { v: number | null };
      expect(stored.v).toBeNull();
    });

    test("GET /api/music/rankings trims an inferred duration to the gap since the previous play", async () => {
      const db = getDb();
      const insert = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, duration_ms,
          title, content, tags, raw_data
        ) VALUES ('spotify', ?, 'listener', 'listen:track', ?, NULL, ?, ?, ?, ?)
      `);
      // Five-minute tracks played in sequence. played_at marks when a track
      // stopped, so the interval since the previous play caps how long each one
      // can have been playing for.
      const trackLength = 300_000;
      for (const [name, timestamp] of [
        // Nothing recent precedes it: nothing to trim against, so full length.
        ["Gap Unbounded", "2099-01-01T10:00:00.000Z"],
        // Two minutes after the previous play: cannot have run its full length.
        ["Gap Trimmed", "2099-01-01T10:02:00.000Z"],
        // Stamped milliseconds later, as offline playback reconciled in a burst
        // is. The gap carries no signal, so the length stands rather than being
        // clamped to a listening time nothing supports.
        ["Gap Burst", "2099-01-01T10:02:00.100Z"],
        // Second-precision timestamp against the millisecond one above: orders
        // lexically before it, so the raw gap is negative.
        ["Gap Negative", "2099-01-01T10:02:00Z"],
      ] as const) {
        insert.run(
          `spotify:track:${name.toLowerCase().replace(" ", "-")}@${timestamp}`,
          timestamp,
          name,
          `${name} by Gap Artist`,
          JSON.stringify(["api", "artist:Gap Artist"]),
          JSON.stringify({
            track: { uri: `spotify:track:${name}`, name, duration_ms: trackLength },
          }),
        );
      }
      db.close();

      const res = await app.request("/api/music/rankings?period=all");
      expect(res.status).toBe(200);
      const json = await res.json();
      const listeningMsFor = (trackName: string) =>
        json.topTracks.find((track: { trackName: string }) => track.trackName === trackName)
          ?.listeningMs;

      expect(listeningMsFor("Gap Unbounded")).toBe(trackLength);
      expect(listeningMsFor("Gap Trimmed")).toBe(2 * 60_000);
      // Both untrustworthy gaps fall back to the length; neither is clamped to
      // the threshold, so the estimate stays an upper bound.
      expect(listeningMsFor("Gap Burst")).toBe(trackLength);
      expect(listeningMsFor("Gap Negative")).toBe(trackLength);

      // The artist total sums the trimmed plays, not four full tracks.
      const gapArtist = json.topArtists.find(
        (artist: { artistName: string }) => artist.artistName === "Gap Artist",
      );
      expect(gapArtist).toMatchObject({ playCount: 4, listeningMs: 3 * trackLength + 2 * 60_000 });
    });

    test("GET /api/music/rankings ignores measured plays when finding the previous play", async () => {
      const db = getDb();
      const insert = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, duration_ms,
          title, content, tags, raw_data
        ) VALUES ('spotify', ?, 'listener', 'listen:track', ?, ?, ?, ?, ?, ?)
      `);
      const trackLength = 300_000;
      // A measured play sits between two unmeasured ones. The gap spans it, so
      // the later play trims against the earlier unmeasured play four minutes
      // back — not against the measured play one minute back.
      insert.run(
        "spotify:track:span-first@2098-09-01",
        "2098-09-01T10:00:00.000Z",
        null,
        "Span First",
        "Span First by Span Artist",
        JSON.stringify(["api", "artist:Span Artist"]),
        JSON.stringify({ track: { uri: "spotify:track:span-first", duration_ms: trackLength } }),
      );
      insert.run(
        "spotify:track:span-measured@2098-09-01",
        "2098-09-01T10:03:00.000Z",
        123_000,
        "Span Measured",
        "Span Measured by Span Artist",
        JSON.stringify(["artist:Span Artist"]),
        JSON.stringify({ master_metadata_album_artist_name: "Span Artist" }),
      );
      insert.run(
        "spotify:track:span-last@2098-09-01",
        "2098-09-01T10:04:00.000Z",
        null,
        "Span Last",
        "Span Last by Span Artist",
        JSON.stringify(["api", "artist:Span Artist"]),
        JSON.stringify({ track: { uri: "spotify:track:span-last", duration_ms: trackLength } }),
      );
      db.close();

      const res = await app.request("/api/music/rankings?period=all");
      const json = await res.json();
      const spanLast = json.topTracks.find(
        (track: { trackName: string }) => track.trackName === "Span Last",
      );

      expect(spanLast).toMatchObject({ listeningMs: 4 * 60_000 });
      // The measured play keeps its own duration regardless.
      const spanMeasured = json.topTracks.find(
        (track: { trackName: string }) => track.trackName === "Span Measured",
      );
      expect(spanMeasured).toMatchObject({ listeningMs: 123_000 });
    });

    test("GET /api/music/rankings trusts a gap exactly at the threshold", async () => {
      const db = getDb();
      const insert = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, duration_ms,
          title, content, tags, raw_data
        ) VALUES ('spotify', ?, 'listener', 'listen:track', ?, NULL, ?, ?, ?, ?)
      `);
      for (const [name, timestamp] of [
        ["Boundary First", "2098-11-01T10:00:00.000Z"],
        // Exactly 30s later: the threshold is inclusive, so this gap is trusted
        // and trims rather than falling back to the full length.
        ["Boundary Exact", "2098-11-01T10:00:30.000Z"],
      ] as const) {
        insert.run(
          `spotify:track:${name.toLowerCase().replace(" ", "-")}@${timestamp}`,
          timestamp,
          name,
          `${name} by Boundary Artist`,
          JSON.stringify(["api", "artist:Boundary Artist"]),
          JSON.stringify({ track: { uri: `spotify:track:${name}`, duration_ms: 300_000 } }),
        );
      }
      db.close();

      const res = await app.request("/api/music/rankings?period=all");
      const json = await res.json();
      const boundary = json.topTracks.find(
        (t: { trackName: string }) => t.trackName === "Boundary Exact",
      );

      expect(boundary).toMatchObject({ listeningMs: 30_000 });
    });

    test("GET /api/music/rankings gives an unmeasured play following a measured one its full length", async () => {
      const db = getDb();
      const insert = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, duration_ms,
          title, content, tags, raw_data
        ) VALUES ('spotify', ?, 'listener', 'listen:track', ?, ?, ?, ?, ?, ?)
      `);
      // The export and API eras meet here: the only nearby play is measured, so
      // the first unmeasured play has no predecessor to trim against.
      insert.run(
        "spotify:track:era-measured@2098-12-01",
        "2098-12-01T10:00:00.000Z",
        200_000,
        "Era Measured",
        "Era Measured by Era Artist",
        JSON.stringify(["artist:Era Artist"]),
        JSON.stringify({ master_metadata_album_artist_name: "Era Artist" }),
      );
      insert.run(
        "spotify:track:era-unmeasured@2098-12-01",
        "2098-12-01T10:01:00.000Z",
        null,
        "Era Unmeasured",
        "Era Unmeasured by Era Artist",
        JSON.stringify(["api", "artist:Era Artist"]),
        JSON.stringify({ track: { uri: "spotify:track:era-unmeasured", duration_ms: 300_000 } }),
      );
      db.close();

      const res = await app.request("/api/music/rankings?period=all");
      const json = await res.json();
      const unmeasured = json.topTracks.find(
        (t: { trackName: string }) => t.trackName === "Era Unmeasured",
      );

      // Not 60_000: the measured play one minute back is not a predecessor.
      expect(unmeasured).toMatchObject({ listeningMs: 300_000 });
    });

    test("GET /api/music/rankings counts an unmeasured play with no track length as zero", async () => {
      const db = getDb();
      db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, duration_ms,
          title, content, tags, raw_data
        ) VALUES ('spotify', ?, 'listener', 'listen:track', ?, NULL, ?, ?, ?, ?)
      `).run(
        "spotify:track:no-length@2098-10-01",
        "2098-10-01T10:00:00.000Z",
        "No Length Song",
        "No Length Song by Lengthless Artist",
        JSON.stringify(["api", "artist:Lengthless Artist"]),
        // No duration_ms anywhere: nothing measured, nothing to infer from.
        JSON.stringify({ track: { uri: "spotify:track:no-length" } }),
      );
      db.close();

      const res = await app.request("/api/music/rankings?period=all");
      const json = await res.json();
      const track = json.topTracks.find(
        (t: { trackName: string }) => t.trackName === "No Length Song",
      );

      expect(track).toMatchObject({ playCount: 1, listeningMs: 0 });
      // The summary total is built from the same expression, so it stays a
      // number rather than going NULL when a play contributes nothing.
      expect(typeof json.listeningMs).toBe("number");
      expect(json.listeningMs).toBeGreaterThan(0);
    });

    test("music exclusions leave plays out of the top lists but not the Plays total", async () => {
      const db = getDb();
      // Five plays each, so these rank inside the top 25 whatever else the shared test database holds.
      const insert = db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, duration_ms, title, tags, raw_data)
        VALUES ('spotify', ?, 'listener', 'listen:track', ?, 180000, ?, ?, ?)
        RETURNING id
      `);
      const plays = (title: string, tags: string[], rawData: object) => Array.from({ length: 5 }, (_, day) =>
        (insert.get(`spotify:track:${title}@${day}`, `2096-05-0${day + 1}T10:00:00Z`, title, JSON.stringify(tags), JSON.stringify(rawData)) as { id: number }).id,
      )[0] as number;
      const exported = (title: string, artist: string, album: string, tags: string[]) => plays(title, tags, {
        spotify_track_uri: `spotify:track:${title}`,
        master_metadata_album_artist_name: artist,
        master_metadata_album_album_name: album,
      });
      const fromPlaylist = plays("Mix Track", ["api", "artist:Excl Artist One", "album:Excl Album", "playlist:Excl Mix"], {
        context: { type: "playlist", uri: "spotify:playlist:excl-mix" },
        track: { uri: "spotify:track:mix", name: "Mix Track", artists: [{ name: "Excl Artist One" }], album: { name: "Excl Album" } },
      });
      const albumTrack = exported("Album Track", "Excl Artist One", "Excl Album", ["artist:Excl Artist One", "album:Excl Album"]);
      exported("Private Track", "Excl Artist Two", "Private Album", ["incognito"]);
      const soloTrack = exported("Solo Track", "Excl Artist Three", "Solo Album", []);
      db.close();

      const listed = async () => {
        const json = await (await app.request("/api/music/rankings?period=all")).json() as MusicRankingsOverview;
        return {
          totalPlays: json.totalPlays,
          filter: json.filter,
          names: [
            ...json.topTracks.map((track) => track.trackName),
            ...json.topArtists.map((artist) => artist.artistName),
          ].filter((name) => /Track$|^Excl Artist/.test(name)).sort(),
        };
      };
      const exclude = async (body: object) => {
        const res = await app.request("/api/music/exclusions", { method: "POST", body: JSON.stringify(body) });
        return { status: res.status, json: await res.json() };
      };
      const include = (id: number) => app.request(`/api/music/exclusions/${id}`, { method: "DELETE" });
      const filterOnly = async () => {
        const { playedPlaylists: _, ...filter } = await (await app.request("/api/music/exclusions")).json() as MusicExclusionsResponse;
        return filter;
      };
      const privateSessions = (excluded: boolean) => app.request("/api/music/exclusions/private-sessions", {
        method: "PUT",
        body: JSON.stringify({ excluded }),
      });

      const before = await listed();
      expect(before.names).toEqual([
        "Album Track", "Excl Artist One", "Excl Artist Three", "Excl Artist Two", "Mix Track", "Private Track", "Solo Track",
      ]);
      expect(before.filter).toEqual({ exclusions: [], excludePrivateSessions: false });

      expect((await exclude({ kind: "playlist", eventId: albumTrack })).status).toBe(404);
      expect((await exclude({ kind: "artist" })).status).toBe(400);

      const cases: [MusicExclusionRequest, string, string[]][] = [
        [{ kind: "playlist", eventId: fromPlaylist }, "Excl Mix", ["Mix Track"]],
        // Matches the export play of the same album as well as the live-synced one.
        [{ kind: "album", eventId: albumTrack }, "Excl Album · Excl Artist One", ["Album Track", "Excl Artist One", "Mix Track"]],
        [{ kind: "track", eventId: soloTrack }, "Solo Track · Excl Artist Three", ["Excl Artist Three", "Solo Track"]],
        [{ kind: "artist", artistName: "Excl Artist One" }, "Excl Artist One", ["Album Track", "Excl Artist One", "Mix Track"]],
      ];
      let lastId = 0;
      for (const [body, label, gone] of cases) {
        const created = await exclude(body);
        expect(created.status).toBe(201);
        // Ids are never reused, so a stale "include again" cannot remove a newer exclusion.
        expect(created.json.exclusion.id).toBeGreaterThan(lastId);
        lastId = created.json.exclusion.id;
        expect(created.json.exclusion.label).toBe(label);
        const after = await listed();
        expect(after.totalPlays).toBe(before.totalPlays);
        expect(after.filter.exclusions).toEqual([created.json.exclusion]);
        // Only the public fields: the key plays are matched on stays on the server.
        expect(await filterOnly()).toStrictEqual({
          exclusions: [{ id: created.json.exclusion.id, kind: body.kind, label }],
          excludePrivateSessions: false,
        });
        expect(after.names).toEqual(before.names.filter((name) => !gone.includes(name)));
        expect((await include(created.json.exclusion.id)).status).toBe(200);
      }

      expect((await privateSessions(true)).status).toBe(200);
      const withoutPrivate = await listed();
      expect(withoutPrivate.totalPlays).toBe(before.totalPlays);
      expect(withoutPrivate.filter.excludePrivateSessions).toBe(true);
      expect(await filterOnly()).toEqual({ exclusions: [], excludePrivateSessions: true });
      expect(withoutPrivate.names).toEqual(before.names.filter((name) => !["Excl Artist Two", "Private Track"].includes(name)));
      expect((await privateSessions(false)).status).toBe(200);
      expect((await listed()).names).toEqual(before.names);
    });

    test("played playlists are listed until excluded, named by cache, then latest tag, then id, with any cached cover", async () => {
      const db = getDb();
      const insert = db.prepare(`
        INSERT INTO events (source, source_id, source_account, type, timestamp, title, tags, raw_data)
        VALUES ('spotify', ?, 'listener', 'listen:track', ?, 'Picker Track', ?, ?)
        RETURNING id
      `);
      const play = (uri: string, timestamp: string, tags: string[]) => (insert.get(
        `spotify:track:picker@${uri}@${timestamp}`,
        timestamp,
        JSON.stringify(tags),
        JSON.stringify({ context: { type: "playlist", uri }, track: { uri: "spotify:track:picker" } }),
      ) as { id: number }).id;
      play("spotify:playlist:picker-renamed", "2097-01-01T10:00:00Z", ["playlist:Old Name"]);
      play("spotify:playlist:picker-renamed", "2097-01-02T10:00:00Z", ["playlist:New Name"]);
      play("spotify:playlist:picker-renamed", "2097-01-03T10:00:00Z", []);
      const cachedPlay = play("spotify:playlist:picker-cached", "2097-01-04T10:00:00Z", ["playlist:Tagged Name"]);
      play("spotify:playlist:picker-cached", "2097-01-05T10:00:00Z", ["playlist:Tagged Name"]);
      play("spotify:playlist:picker-unnamed", "2097-01-06T10:00:00Z", []);
      // Spotify reports some plays to the millisecond: the later of these is the .500 one.
      play("spotify:playlist:picker-precision", "2097-01-07T10:00:00.500Z", ["playlist:Later Name"]);
      play("spotify:playlist:picker-precision", "2097-01-07T10:00:00Z", ["playlist:Earlier Name"]);
      db.close();
      setSpotifyResource(getAppStateDb(), "spotify:playlist:picker-cached", "playlist", "Cached Name", "https://example.com/cover.jpg");

      const listed = async () => {
        const json = await (await app.request("/api/music/exclusions")).json() as MusicExclusionsResponse;
        return json.playedPlaylists.filter((playlist) => playlist.playlistUri.includes(":picker-"));
      };
      const exclude = (body: object) => app.request("/api/music/exclusions", { method: "POST", body: JSON.stringify(body) });

      const all: MusicPlayedPlaylist[] = [
        { playlistUri: "spotify:playlist:picker-renamed", name: "New Name", imageUrl: null, plays: 3, lastPlayedAt: "2097-01-03T10:00:00Z" },
        { playlistUri: "spotify:playlist:picker-precision", name: "Later Name", imageUrl: null, plays: 2, lastPlayedAt: "2097-01-07T10:00:00.500Z" },
        { playlistUri: "spotify:playlist:picker-cached", name: "Cached Name", imageUrl: "https://example.com/cover.jpg", plays: 2, lastPlayedAt: "2097-01-05T10:00:00Z" },
        { playlistUri: "spotify:playlist:picker-unnamed", name: "picker-unnamed", imageUrl: null, plays: 1, lastPlayedAt: "2097-01-06T10:00:00Z" },
      ];
      expect(await listed()).toEqual(all);

      expect((await exclude({ kind: "playlist", playlistUri: "spotify:playlist:never-played" })).status).toBe(404);
      expect((await exclude({ kind: "playlist", playlistUri: " " })).status).toBe(400);
      const created = await exclude({ kind: "playlist", playlistUri: "spotify:playlist:picker-renamed" });
      expect(created.status).toBe(201);
      const { exclusion } = await created.json();
      expect(exclusion.label).toBe("New Name");
      expect(await listed()).toEqual(all.slice(1));
      expect((await app.request(`/api/music/exclusions/${exclusion.id}`, { method: "DELETE" })).status).toBe(200);
      expect(await listed()).toEqual(all);

      // Excluding from a play names the playlist the same way.
      const fromPlay = await exclude({ kind: "playlist", eventId: cachedPlay });
      const { exclusion: fromPlayExclusion } = await fromPlay.json();
      expect(fromPlayExclusion.label).toBe("Cached Name");
      expect((await app.request(`/api/music/exclusions/${fromPlayExclusion.id}`, { method: "DELETE" })).status).toBe(200);
    });

    test("GET /api/music/rankings rejects unknown periods", async () => {
      const res = await app.request("/api/music/rankings?period=quarter");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Invalid music period. Expected 4w, 6m, 12m, or all.",
      });
    });
  });

  describe("Attachments", () => {
    const attachmentSource = "api-global-attachments";
    let statsBefore: AttachmentsStats;
    let describedAttachmentId: number;
    let videoAttachmentId: number;

    beforeAll(async () => {
      const statsResponse = await app.request("/api/attachments/stats");
      expect(statsResponse.status).toBe(200);
      statsBefore = await statsResponse.json() as AttachmentsStats;

      const db = getDb();
      const insertEvent = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, title, content,
          raw_data, conversation_id
        ) VALUES (?, ?, 'alice', 'message:guild', ?, 'Global attachments', 'attachment', '{}', 'global-attachments-thread')
      `);
      const insertAttachment = db.prepare(`
        INSERT INTO attachments (
          event_id, source, source_id, content_hash, filename, mime_type,
          storage_path, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertDescription = db.prepare(`
        INSERT INTO attachment_descriptions (content_hash, model, description, created_at, duration_ms)
        VALUES (?, ?, ?, ?, ?)
      `);

      const describedEvent = insertEvent.run(attachmentSource, "global-described", "2030-05-03T00:00:00Z");
      const describedAttachment = insertAttachment.run(describedEvent.lastInsertRowid, attachmentSource, "global-described", "global-described-hash", "described.png", "image/png", "global/described.png", "stored");
      describedAttachmentId = Number(describedAttachment.lastInsertRowid);
      insertDescription.run("global-described-hash", "global-attachments-test-model", "A described image.", "2030-05-03 00:01:00", 31);
      insertDescription.run("global-described-hash", "another-test-model", "A newer description.", "2030-05-04T00:01:00Z", 47);

      const videoEvent = insertEvent.run(attachmentSource, "global-video", "2030-05-03T00:00:00Z");
      const videoAttachment = insertAttachment.run(videoEvent.lastInsertRowid, attachmentSource, "global-video", "global-video-hash", "video.mp4", "video/mp4", "global/video.mp4", "stored");
      videoAttachmentId = Number(videoAttachment.lastInsertRowid);

      const audioEvent = insertEvent.run(attachmentSource, "global-audio", "2030-05-02T00:00:00Z");
      insertAttachment.run(audioEvent.lastInsertRowid, attachmentSource, "global-audio", "global-audio-hash", "audio.mp3", "audio/mpeg", "global/audio.mp3", "stored");

      const undescribedImageEvent = insertEvent.run(attachmentSource, "global-undescribed-image", "2030-05-01T00:00:00Z");
      insertAttachment.run(undescribedImageEvent.lastInsertRowid, attachmentSource, "global-undescribed-image", "global-undescribed-image-hash", "undesc.png", "image/png", "global/undesc.png", "stored");

      const pendingEvent = insertEvent.run(attachmentSource, "global-pending", "2030-04-30T00:00:00Z");
      insertAttachment.run(pendingEvent.lastInsertRowid, attachmentSource, "global-pending", "global-pending-hash", "pending.png", "image/png", null, "pending");

      const failedEvent = insertEvent.run(attachmentSource, "global-failed", "2030-04-29T00:00:00Z");
      insertAttachment.run(failedEvent.lastInsertRowid, attachmentSource, "global-failed", "global-failed-hash", "failed.png", "image/png", null, "failed");

      const unrecoverableEvent = insertEvent.run(attachmentSource, "global-unrecoverable", "2030-04-28T00:00:00Z");
      insertAttachment.run(unrecoverableEvent.lastInsertRowid, attachmentSource, "global-unrecoverable", "global-unrecoverable-hash", "unrecoverable.png", "image/png", null, "unrecoverable");

      const untimestampedEvent = insertEvent.run(attachmentSource, "global-untimestamped", null);
      insertAttachment.run(untimestampedEvent.lastInsertRowid, attachmentSource, "global-untimestamped", "global-untimestamped-hash", "untimestamped.pdf", "application/pdf", "global/untimestamped.pdf", "stored");
      db.close();
    });

    test("GET /api/attachments paginates newest-first without gaps", async () => {
      const first = await app.request(`/api/attachments?source=${attachmentSource}&limit=1`);
      expect(first.status).toBe(200);
      expectServerTimings(first, ["attachments.list"]);
      const firstJson = await first.json();
      expect(firstJson.attachments.map((attachment: { filename: string }) => attachment.filename)).toEqual(["video.mp4"]);
      expect(firstJson.nextCursor).toEqual(expect.any(String));

      const second = await app.request(`/api/attachments?source=${attachmentSource}&limit=1&cursor=${encodeURIComponent(firstJson.nextCursor)}`);
      expect(second.status).toBe(200);
      const secondJson = await second.json();
      expect(secondJson.attachments.map((attachment: { filename: string }) => attachment.filename)).toEqual(["described.png"]);

      const filenames = [...firstJson.attachments, ...secondJson.attachments].map(
        (attachment: { filename: string }) => attachment.filename,
      );
      let cursor = secondJson.nextCursor as string | null;
      while (cursor) {
        const page = await app.request(`/api/attachments?source=${attachmentSource}&limit=1&cursor=${encodeURIComponent(cursor)}`);
        expect(page.status).toBe(200);
        const json = await page.json();
        filenames.push(...json.attachments.map((attachment: { filename: string }) => attachment.filename));
        cursor = json.nextCursor;
      }

      expect(filenames).toEqual(["video.mp4", "described.png", "audio.mp3", "undesc.png", "untimestamped.pdf"]);
      expect(new Set(filenames).size).toBe(filenames.length);
      expect(cursor).toBeNull();
    });

    test("GET /api/attachments applies and composes filters", async () => {
      const image = await app.request(`/api/attachments?source=${attachmentSource}&mime=image`);
      expect((await image.json()).attachments.map((attachment: { filename: string }) => attachment.filename)).toEqual(["described.png", "undesc.png"]);

      const described = await app.request(`/api/attachments?source=${attachmentSource}&described=true`);
      expect((await described.json()).attachments.map((attachment: { filename: string }) => attachment.filename)).toEqual(["described.png"]);

      const undescribed = await app.request(`/api/attachments?source=${attachmentSource}&described=false`);
      expect((await undescribed.json()).attachments.map((attachment: { filename: string }) => attachment.filename))
        .toEqual(["undesc.png"]);

      const failed = await app.request(`/api/attachments?source=${attachmentSource}&status=failed`);
      expect((await failed.json()).attachments.map((attachment: { filename: string }) => attachment.filename)).toEqual(["failed.png"]);

      const composed = await app.request(`/api/attachments?source=${attachmentSource}&mime=image&described=true&status=stored`);
      expect((await composed.json()).attachments.map((attachment: { filename: string }) => attachment.filename)).toEqual(["described.png"]);

      const pendingUndescribed = await app.request(`/api/attachments?source=${attachmentSource}&status=pending&described=false`);
      expect((await pendingUndescribed.json()).attachments.map((attachment: { filename: string }) => attachment.filename)).toEqual(["pending.png"]);

      const excluded = await app.request(`/api/attachments?exclude_sources=${attachmentSource}`);
      expect((await excluded.json()).attachments.map((attachment: { source: string }) => attachment.source))
        .not.toContain(attachmentSource);

      const explicitSource = await app.request(
        `/api/attachments?source=${attachmentSource}&exclude_sources=${attachmentSource}`,
      );
      expect((await explicitSource.json()).attachments).toHaveLength(5);
    });

    test("GET /api/attachments/stats returns corpus-wide attachment counts", async () => {
      const response = await app.request("/api/attachments/stats");
      expect(response.status).toBe(200);
      expectServerTimings(response, ["attachments.stats"]);
      const stats = await response.json() as AttachmentsStats;

      expect(stats.total).toBe(statsBefore.total + 8);
      expect(stats.byStatus.stored).toBe(statsBefore.byStatus.stored + 5);
      expect(stats.byStatus.pending).toBe(statsBefore.byStatus.pending + 1);
      expect(stats.byStatus.failed).toBe(statsBefore.byStatus.failed + 1);
      expect(stats.byStatus.unrecoverable).toBe(statsBefore.byStatus.unrecoverable + 1);
      expect(stats.distinctHashes).toBe(statsBefore.distinctHashes + 8);
      expect(stats.descriptionEligibleHashes).toBe(statsBefore.descriptionEligibleHashes + 2);
      expect(stats.describedHashes).toBe(statsBefore.describedHashes + 1);
      expect(stats.needingDescription).toBe(statsBefore.needingDescription + 1);
      expect(stats.byModel.find((entry) => entry.model === "global-attachments-test-model")).toEqual({
        model: "global-attachments-test-model",
        count: 1,
      });
      expect(stats.bySource.find((entry) => entry.source === attachmentSource)).toEqual({
        source: attachmentSource,
        count: 8,
      });
    });

    test("attachment responses use the configured description model order", async () => {
      const db = getDb();
      const event = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, title, content,
          raw_data, conversation_id
        ) VALUES (
          'discord', 'described-attachment-api-1', 'alice', 'message:guild',
          '2026-01-04T00:00:00Z', 'Descriptions #general', 'an image', '{}',
          'described-attachment-thread'
        )
      `).run();
      const contentHash = "described-attachment-api-hash";
      const attachment = db.prepare(`
        INSERT INTO attachments (
          event_id, source, source_id, content_hash, filename, mime_type,
          storage_path, status
        ) VALUES (?, 'discord', 'described-attachment-api-image', ?,
          'image.png', 'image/png', 'discord/described/image.png', 'stored')
      `).run(event.lastInsertRowid, contentHash);
      const insertDescription = db.prepare(`
        INSERT INTO attachment_descriptions (content_hash, model, description, created_at)
        VALUES (?, ?, ?, ?)
      `);
      insertDescription.run(
        contentHash,
        "older-model",
        "An older generated description.",
        "2026-01-04T00:01:00Z",
      );
      insertDescription.run(
        contentHash,
        "newer-model",
        "A newer generated description.",
        "2026-01-04T00:02:00Z",
      );
      db.close();

      const appDb = getAppStateDb();
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'attachment-descriptions'").run();
      appDb.prepare(`
        INSERT INTO sync_sources (source, enabled, settings)
        VALUES ('attachment-descriptions', 1, ?)
      `).run(JSON.stringify({ models: ["older-model", "newer-model"] }));

      const eventId = Number(event.lastInsertRowid);
      const eventRes = await app.request(`/api/events/${eventId}/attachments`);
      expect(eventRes.status).toBe(200);
      const eventJson = await eventRes.json();
      expect(eventJson.attachments[0].description).toBe("An older generated description.");

      const listRes = await app.request("/api/attachments?source=discord");
      expect(listRes.status).toBe(200);
      const listJson = await listRes.json();
      expect(listJson.attachments.find((item: { id: number }) => item.id === Number(attachment.lastInsertRowid)).description)
        .toBe("An older generated description.");

      const detailRes = await app.request(`/api/attachments/${attachment.lastInsertRowid}`);
      expect(detailRes.status).toBe(200);
      expect((await detailRes.json()).description).toBe("An older generated description.");

      const params = new URLSearchParams({
        source: "discord",
        sourceAccount: "alice",
        conversationId: "described-attachment-thread",
      });
      const conversationRes = await app.request(`/api/conversation?${params}`);
      expect(conversationRes.status).toBe(200);
      const conversationJson = await conversationRes.json();
      expect(conversationJson.attachments[eventId][0].description).toBe(
        "An older generated description.",
      );

      const mediaRes = await app.request(`/api/conversation/media?${params}`);
      expect(mediaRes.status).toBe(200);
      const mediaJson = await mediaRes.json();
      expect(mediaJson.attachments[0].description).toBe("An older generated description.");

      const exportRes = await app.request("/api/conversation/export-range", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ startEventId: eventId, endEventId: eventId }),
      });
      expect(exportRes.status).toBe(200);
      expect((await exportRes.json()).text).toContain("An older generated description.");

      appDb.prepare("DELETE FROM sync_sources WHERE source = 'attachment-descriptions'").run();
    });

    test("GET /api/attachments/:id returns all descriptions newest first", async () => {
      const response = await app.request(`/api/attachments/${describedAttachmentId}`);
      expect(response.status).toBe(200);
      const detail = await response.json();
      expect(detail).toMatchObject({
        id: describedAttachmentId,
        filename: "described.png",
        description: "A newer description.",
        descriptionModel: "another-test-model",
      });
      expect(detail.descriptions).toEqual([
        {
          model: "another-test-model",
          description: "A newer description.",
          createdAt: "2030-05-04T00:01:00Z",
          durationMs: 47,
        },
        {
          model: "global-attachments-test-model",
          description: "A described image.",
          createdAt: "2030-05-03T00:01:00Z",
          durationMs: 31,
        },
      ]);
    });

    test("GET /api/attachments/:id returns 404 for an unknown attachment", async () => {
      const response = await app.request("/api/attachments/999999999");
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Attachment not found" });
    });

    test("POST /api/attachments/:id/describe validates the attachment", async () => {
      const unknown = await app.request("/api/attachments/999999999/describe", {
        method: "POST",
        body: JSON.stringify({ model: "vision-model" }),
      });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: "Attachment not found" });

      const nonImage = await app.request(`/api/attachments/${videoAttachmentId}/describe`, {
        method: "POST",
        body: JSON.stringify({ model: "vision-model" }),
      });
      expect(nonImage.status).toBe(400);
      expect((await nonImage.json()).error).toContain("not eligible");

      const db = getDb();
      const event = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp, title, content,
          raw_data, conversation_id
        ) VALUES (?, 'global-no-hash', 'alice', 'message:guild', ?, 'Global attachments', 'attachment', '{}', 'global-attachments-thread')
      `).run(attachmentSource, "2030-05-05T00:00:00Z");
      const attachment = db.prepare(`
        INSERT INTO attachments (event_id, source, source_id, filename, mime_type, storage_path, status)
        VALUES (?, ?, 'global-no-hash', 'no-hash.png', 'image/png', 'global/no-hash.png', 'stored')
      `).run(event.lastInsertRowid, attachmentSource);
      db.close();

      const missingHash = await app.request(`/api/attachments/${attachment.lastInsertRowid}/describe`, {
        method: "POST",
        body: JSON.stringify({ model: "vision-model" }),
      });
      expect(missingHash.status).toBe(400);
      expect((await missingHash.json()).error).toContain("content hash");
    });

    test("POST /api/attachments/:id/describe rejects invalid image limits before generation", async () => {
      for (const maxImageDimension of [0, -1, 1.5, 2049, "1024", null]) {
        const response = await app.request(`/api/attachments/${describedAttachmentId}/describe`, {
          method: "POST",
          body: JSON.stringify({ model: "vision-model", maxImageDimension }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "maxImageDimension must be an integer between 1 and 2048" });
      }
    });

    test("manual description requests can outlive the server idle timeout", async () => {
      const timedOutRequests: Array<{ request: Request; seconds: number }> = [];
      const request = new Request("http://localhost/api/attachments/999999999/describe", {
        method: "POST",
        body: JSON.stringify({ model: "vision-model" }),
      });
      const response = await fetchApiRequest(request, {
        timeout: (timedRequest, seconds) => timedOutRequests.push({ request: timedRequest, seconds }),
      });

      expect(response.status).toBe(404);
      expect(timedOutRequests).toEqual([{ request, seconds: 0 }]);
    });

    test("GET /api/media/* returns 400 for empty path", async () => {
      const res = await app.request("/api/media/");
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toHaveProperty("error");
    });

    test("GET /api/media/* returns 404 for non-existent file", async () => {
      const res = await app.request("/api/media/nonexistent/file.jpg");
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json).toHaveProperty("error");
    });

    test("GET /api/media/* refuses paths outside the media root", async () => {
      const root = mkdtempSync(join(tmpdir(), "api-media-traversal-"));
      const priorMediaPath = process.env.TIMELINE_MEDIA_PATH;

      try {
        const mediaRoot = join(root, "media");
        mkdirSync(mediaRoot);
        writeFileSync(join(root, "secret.txt"), "outside the media root");
        process.env.TIMELINE_MEDIA_PATH = mediaRoot;

        // URL parsing collapses a literal "../", so traversal arrives encoded.
        for (const path of ["%2e%2e%2fsecret.txt", "..%2Fsecret.txt", encodeURIComponent(join(root, "secret.txt"))]) {
          const res = await app.request(`/api/media/${path}`);
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({ error: "Invalid path" });
        }
      } finally {
        if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
        else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("GET /api/media/* serves a stored local file", async () => {
      const root = mkdtempSync(join(tmpdir(), "api-media-test-"));
      const priorMediaPath = process.env.TIMELINE_MEDIA_PATH;

      try {
        process.env.TIMELINE_MEDIA_PATH = root;
        mkdirSync(join(root, "discord", "channel"), { recursive: true });
        writeFileSync(join(root, "discord", "channel", "hello.txt"), "hello media");

        const res = await app.request("/api/media/discord/channel/hello.txt");

        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
        expect(res.headers.get("Content-Length")).toBe("11");
        expect(await res.text()).toBe("hello media");
      } finally {
        if (priorMediaPath === undefined) delete process.env.TIMELINE_MEDIA_PATH;
        else process.env.TIMELINE_MEDIA_PATH = priorMediaPath;
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("Call recordings", () => {
    /** Import a synthetic one-frame recording through the real importer. */
    async function importRecording(db: Database, dir: string, name: string): Promise<number> {
      const { importRecordingFile } = await import("../platforms/call-recordings/parser");
      const path = join(dir, name);
      writeFileSync(path, new Uint8Array([...new TextEncoder().encode("#!AMR\n"), 0x7c]));
      const outcome = await importRecordingFile(db, path, {
        sourceAccount: "api-test",
        importBatch: "api-test",
        timeZone: "UTC",
        convert: async () => ({ bytes: new TextEncoder().encode("RIFF-audio"), extension: ".wav", mimeType: "audio/wav" }),
      });
      if (outcome.status !== "imported") throw new Error(`recording not imported: ${outcome.status}`);
      return outcome.eventId;
    }

    test("GET /api/day returns the call each recording recorded", async () => {
      const { getDb, initDb } = await import("../db/schema");
      const dir = mkdtempSync(join(tmpdir(), "api-call-day-"));
      const db = getDb();
      try {
        initDb(db);
        const id = await importRecording(db, dir, "phone_20990301-100020_07700900123.amr");
        const call = db.prepare(`
          INSERT INTO events (source, source_id, source_account, type, timestamp, duration_ms, title, people, raw_data, conversation_id)
          VALUES ('phone', 'api-day-call', 'api-test', 'call:outgoing', '2099-03-01T10:00:00.000Z', 300000, 'John Doe',
                  '["phone:api-test","phone:+447700900123"]', '{"number":"+447700900123"}', '+447700900123')
          RETURNING id`).get() as { id: number };

        const res = await app.request("/api/day?date=2099-03-01");
        expect(res.status).toBe(200);
        const body = await res.json() as { callLinks: Record<string, Array<{ id: number }>> };
        expect(body.callLinks[String(id)]?.map((linked) => linked.id)).toEqual([call.id]);
      } finally {
        db.prepare("DELETE FROM attachments WHERE source = 'call-recordings'").run();
        db.prepare("DELETE FROM events WHERE source = 'call-recordings' OR source_id = 'api-day-call'").run();
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("GET /api/call-recordings/:id/audio serves a recording's playable copy", async () => {
      const { getDb, initDb } = await import("../db/schema");
      const dir = mkdtempSync(join(tmpdir(), "api-call-audio-"));
      const db = getDb();
      try {
        initDb(db);
        const id = await importRecording(db, dir, "phone_20990201-100000_07700900123.amr");
        const other = db.prepare("SELECT id FROM events WHERE source != 'call-recordings' LIMIT 1").get() as { id: number } | null;

        const part = await app.request(`/api/call-recordings/${id}/audio`, { headers: { Range: "bytes=5-" } });
        expect(part.status).toBe(206);
        expect(part.headers.get("Content-Type")).toBe("audio/wav");
        expect(await part.text()).toBe("audio");

        expect((await app.request("/api/call-recordings/999999999/audio")).status).toBe(404);
        expect((await app.request("/api/call-recordings/not-a-number/audio")).status).toBe(404);
        if (other) expect((await app.request(`/api/call-recordings/${other.id}/audio`)).status).toBe(404);
      } finally {
        db.prepare("DELETE FROM attachments WHERE source = 'call-recordings'").run();
        db.prepare("DELETE FROM events WHERE source = 'call-recordings'").run();
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Discord Emoji", () => {
    test("GET /api/discord/emoji/:id returns 400 for non-numeric id", async () => {
      const res = await app.request("/api/discord/emoji/not-a-snowflake");
      expect(res.status).toBe(400);
    });

    test("GET /api/discord/emoji/:id returns 404 with day-cache for tombstoned rows", async () => {
      const { getDb, initDb } = await import("../db/schema");
      const db = getDb();
      initDb(db);
      const id = "9999999999999999999";
      db.prepare(`DELETE FROM discord_emojis WHERE emoji_id = ?`).run(id);
      db.prepare(
        `INSERT INTO discord_emojis (emoji_id, name, animated, status) VALUES (?, 'tombstoned-test', 0, 'tombstoned')`,
      ).run(id);
      db.close();

      const res = await app.request(`/api/discord/emoji/${id}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
    });

    test("GET /api/discord/emoji/:id strips a .png/.gif suffix from the id", async () => {
      const { getDb, initDb } = await import("../db/schema");
      const db = getDb();
      initDb(db);
      const id = `9${Date.now()}${crypto.getRandomValues(new Uint32Array(1))[0]}`;
      db.prepare(
        `INSERT INTO discord_emojis (emoji_id, name, animated, status) VALUES (?, 'suffixed-test', 0, 'tombstoned')`,
      ).run(id);

      try {
        // Reaching the tombstoned row's 404 means the suffix was stripped; an
        // unstripped id fails validation with a 400 instead.
        for (const suffix of [".png", ".gif"]) {
          const res = await app.request(`/api/discord/emoji/${id}${suffix}`);
          expect(res.status).toBe(404);
          expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
        }
      } finally {
        db.prepare("DELETE FROM discord_emojis WHERE emoji_id = ?").run(id);
        db.close();
      }
    });
  });

  describe("Media read-through (restore from remote on local miss)", () => {
    // Parametrized over every public media-serving route, so a route that
    // forgets to wire up restore-from-remote fails here (the emoji route was
    // exactly that gap). Drives the app's media store through an injected
    // write-through store over an in-memory remote.
    class FakeRemote implements RemoteBlobStore {
      readonly blobs = new Map<string, Uint8Array>();
      async put(hash: string, content: Uint8Array) {
        this.blobs.set(hash, Uint8Array.from(content));
      }
      async has(hash: string) {
        return this.blobs.has(hash);
      }
      async get(hash: string) {
        const v = this.blobs.get(hash);
        return v ? Buffer.from(v) : null;
      }
      async presentHashes(hashes: Iterable<string>) {
        const present = new Set<string>();
        for (const h of hashes) if (this.blobs.has(h)) present.add(h);
        return present;
      }
    }

    type Db = ReturnType<typeof getDb>;
    interface RouteCase {
      name: string;
      source: string;
      relativePath: string;
      seed(db: Db, storagePath: string, hash: string): void;
      requestPath(storagePath: string): string;
      cleanup(db: Db): void;
    }

    const cases: RouteCase[] = [
      {
        name: "attachment via /api/media/*",
        source: "discord",
        relativePath: "restore-test/att.png",
        seed(db, storagePath, hash) {
          db.prepare("DELETE FROM events WHERE source = 'discord' AND source_id = 'restore-evt'").run();
          const evt = db
            .prepare(
              "INSERT INTO events (source, source_id, type, raw_data) VALUES ('discord', 'restore-evt', 'message:dm', '{}') RETURNING id",
            )
            .get() as { id: number };
          db.prepare(
            "INSERT INTO attachments (event_id, source, source_id, content_hash, storage_path, status) VALUES (?, 'discord', 'restore-att', ?, ?, 'stored')",
          ).run(evt.id, hash, storagePath);
        },
        requestPath: (storagePath) => `/api/media/${storagePath}`,
        cleanup(db) {
          db.prepare("DELETE FROM attachments WHERE source_id = 'restore-att'").run();
          db.prepare("DELETE FROM events WHERE source = 'discord' AND source_id = 'restore-evt'").run();
        },
      },
      {
        name: "emoji via /api/discord/emoji/:id",
        source: "discord-emoji",
        relativePath: "1234567890.png",
        seed(db, storagePath, hash) {
          db.prepare("DELETE FROM discord_emojis WHERE emoji_id = '1234567890'").run();
          db.prepare(
            "INSERT INTO discord_emojis (emoji_id, name, animated, ext, content_hash, storage_path, status) VALUES ('1234567890', 'restore-emoji', 0, 'png', ?, ?, 'stored')",
          ).run(hash, storagePath);
        },
        requestPath: () => "/api/discord/emoji/1234567890",
        cleanup(db) {
          db.prepare("DELETE FROM discord_emojis WHERE emoji_id = '1234567890'").run();
        },
      },
    ];

    for (const routeCase of cases) {
      test(`restores a missing local file from the remote: ${routeCase.name}`, async () => {
        const root = mkdtempSync(join(tmpdir(), "api-restore-"));
        const remote = new FakeRemote();
        const store = new WriteThroughMediaStore(new LocalMediaStore(root), remote);
        const db = getDb();
        setMediaStoreOverride(store);
        try {
          const content = Buffer.from(`restore ${routeCase.name}`);
          const res = await store.storeFile({
            source: routeCase.source,
            relativePath: routeCase.relativePath,
            content,
          });
          routeCase.seed(db, res.storagePath, res.hash);

          // Simulate local cache loss; only the remote has the blob now.
          rmSync(root, { recursive: true, force: true });

          const httpRes = await app.request(routeCase.requestPath(res.storagePath));
          expect(httpRes.status).toBe(200);
          expect(Buffer.from(await httpRes.arrayBuffer()).equals(content)).toBe(true);
        } finally {
          setMediaStoreOverride(null);
          routeCase.cleanup(db);
          db.close();
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  });

  describe("Self Contact", () => {
    async function createTestContact(displayName: string): Promise<{ id: number; is_self: number }> {
      const res = await app.request("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
      expect(res.status).toBe(200);
      return (await res.json()).contact;
    }

    async function patchContact(id: number, body: object): Promise<{ id: number; is_self: number }> {
      const res = await app.request(`/api/contacts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      return (await res.json()).contact;
    }

    test("PATCH isSelf reassigns the single self flag between contacts", async () => {
      const alice = await createTestContact("Alice Example");
      const bob = await createTestContact("Bob Example");
      try {
        expect(alice.is_self).toBe(0);

        const aliceSelf = await patchContact(alice.id, { isSelf: true });
        expect(aliceSelf.is_self).toBe(1);

        // Marking Bob clears Alice — at most one self contact
        const bobSelf = await patchContact(bob.id, { isSelf: true });
        expect(bobSelf.is_self).toBe(1);
        const aliceRes = await app.request(`/api/contacts/${alice.id}`);
        expect((await aliceRes.json()).contact.is_self).toBe(0);

        const bobCleared = await patchContact(bob.id, { isSelf: false });
        expect(bobCleared.is_self).toBe(0);
      } finally {
        await app.request(`/api/contacts/${alice.id}`, { method: "DELETE" });
        await app.request(`/api/contacts/${bob.id}`, { method: "DELETE" });
      }
    });

    test("PATCH rejects non-boolean isSelf values without changing the self contact", async () => {
      const alice = await createTestContact("Alice Example");
      const bob = await createTestContact("Bob Example");
      try {
        await patchContact(alice.id, { isSelf: true });

        for (const isSelf of ["false", null, 1, {}]) {
          const res = await app.request(`/api/contacts/${bob.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isSelf }),
          });
          expect(res.status).toBe(400);
          expect(await res.json()).toEqual({ error: "isSelf must be a boolean" });
        }

        const aliceRes = await app.request(`/api/contacts/${alice.id}`);
        const bobRes = await app.request(`/api/contacts/${bob.id}`);
        expect((await aliceRes.json()).contact.is_self).toBe(1);
        expect((await bobRes.json()).contact.is_self).toBe(0);
      } finally {
        await app.request(`/api/contacts/${alice.id}`, { method: "DELETE" });
        await app.request(`/api/contacts/${bob.id}`, { method: "DELETE" });
      }
    });
  });

  describe("Error Handling", () => {
    test("GET /api/events/:id returns 404 for non-existent event", async () => {
      const res = await app.request("/api/events/999999999");
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json).toHaveProperty("error");
    });

    test("GET /api/contacts/:id returns 404 for non-existent contact", async () => {
      const res = await app.request("/api/contacts/999999999");
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json).toHaveProperty("error");
    });

  });

  describe("Sync & Inbox", () => {
    // Upload endpoint requires watcher to be enabled
    beforeAll(() => setServiceComponents({ watcherEnabled: true }));
    afterAll(() => setServiceComponents({ watcherEnabled: false }));

    test("GET /api/status returns service status", async () => {
      const res = await app.request("/api/status");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("service");
      expect(json).toHaveProperty("scheduler");
      expect(json).toHaveProperty("inbox");
      expect(json.service.version.commitFull).toMatch(/^[0-9a-f]{40}$/);
      expect(json.service).not.toHaveProperty("update");
      expect(json).not.toHaveProperty("database");
      expect(Array.isArray(json.queue)).toBe(true);
      expect(Array.isArray(json.freshness)).toBe(true);
    });

    test("GET /api/attachments/description-history returns daily points", async () => {
      const res = await app.request("/api/attachments/description-history");
      expect(res.status).toBe(200);
      expectServerTimings(res, ["attachments.description-history"]);
      const json = await res.json();
      expect(json).toHaveProperty("points");
      expect(Array.isArray(json.points)).toBe(true);
    });

    test("GET /api/sync/sources lists registered sources with DB config", async () => {
      const appDb = getAppStateDb();
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'trakt'").run();
      appDb.prepare(
        `INSERT INTO sync_sources (source, enabled, interval, settings)
         VALUES ('trakt', 0, '4h', '{"account":"alice"}')`
      ).run();

      try {
        const res = await app.request("/api/sync/sources");
        expect(res.status).toBe(200);
        const json = await res.json();
        const trakt = json.sources.find((source: { name: string }) => source.name === "trakt");
        expect(trakt).toMatchObject({
          name: "trakt",
          configured: true,
          enabled: false,
          interval: "4h",
          effectiveInterval: "4h",
          effectiveIntervalMs: 4 * 60 * 60 * 1000,
          settings: { account: "alice" },
        });
        const backup = json.sources.find((source: { name: string }) => source.name === "backup");
        expect(backup).not.toHaveProperty("authStatus");
        for (const sourceName of ["spotify", "monzo", "google-health", "swarm", "trakt"]) {
          const source = json.sources.find((entry: { name: string }) => entry.name === sourceName);
          expect(source).toMatchObject({ name: sourceName });
          expect(["connected", "needs-reauth", "not-configured"]).toContain(source.authStatus);
        }
        expect(backup.settingsSchema).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              key: "destination",
              type: "string",
              format: "path",
              required: true,
            }),
            expect.objectContaining({ key: "keep_count", type: "number", default: 24 }),
          ])
        );
        const amp = json.sources.find((source: { name: string }) => source.name === "amp");
        expect(amp.settingsSchema).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ key: "account", type: "string" }),
            expect.objectContaining({ key: "mode", type: "select", default: "auto" }),
            expect.objectContaining({ key: "url", type: "string", default: "https://ampcode.com/" }),
            expect.objectContaining({
              key: "path",
              type: "string",
              format: "path",
              default: expect.any(String),
            }),
            expect.objectContaining({
              key: "secrets_path",
              type: "string",
              format: "path",
              default: expect.any(String),
            }),
            expect.objectContaining({ key: "page_size", type: "number", default: 100 }),
            expect.objectContaining({ key: "include_archived", type: "boolean", default: true }),
            expect.objectContaining({ key: "include_empty", type: "boolean", default: true }),
            expect.objectContaining({ key: "refresh_raw_data", type: "boolean", default: false }),
          ])
        );
        const attachmentDescriptions = json.sources.find(
          (source: { name: string }) => source.name === "attachment-descriptions"
        );
        expect(attachmentDescriptions.settingsSchema).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ key: "time_budget_ms", default: 300_000 }),
            expect.objectContaining({ key: "limit", default: 500 }),
          ])
        );
        const backupOffsite = json.sources.find(
          (source: { name: string }) => source.name === "backup-offsite"
        );
        expect(backupOffsite.settingsSchema).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ key: "keep_count", default: 28 }),
            expect.objectContaining({ key: "skip_blocked_networks", default: false }),
            expect.objectContaining({ key: "require_unmetered", default: false }),
            expect.objectContaining({ key: "on_unknown", default: "proceed" }),
          ])
        );
        for (const source of json.sources) {
          for (const field of source.settingsSchema as Array<Record<string, unknown>>) {
            if (field.default === undefined) continue;
            switch (field.type) {
              case "boolean":
                expect(typeof field.default).toBe("boolean");
                break;
              case "number":
                expect(typeof field.default).toBe("number");
                break;
              case "string-list":
                expect(Array.isArray(field.default)).toBe(true);
                break;
              case "select":
                expect(field.options).toContain(field.default);
                break;
              default:
                expect(typeof field.default).toBe("string");
            }
          }
        }
        for (const sourceName of ["claude-code", "opencode", "codex", "t3code", "trakt", "wakatime"]) {
          const source = json.sources.find((candidate: { name: string }) => candidate.name === sourceName);
          expect(source.settingsSchema).toEqual(
            expect.arrayContaining([expect.objectContaining({ key: "account", required: true })])
          );
        }
        const discord = json.sources.find((source: { name: string }) => source.name === "discord");
        expect(discord.settingsSchema).toEqual([]);
      } finally {
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'trakt'").run();
      }
    });

    test("retired sync source settings do not appear in sync or status pages", async () => {
      const appDb = getAppStateDb();
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'fitbit'").run();
      appDb.prepare(
        "INSERT INTO sync_sources (source, enabled, interval, settings) VALUES ('fitbit', 1, 'invalid', 'invalid')",
      ).run();
      appDb.prepare(
        "INSERT OR REPLACE INTO sync_state (source, state) VALUES ('fitbit', '{\"access_token\":\"synthetic\"}')",
      ).run();
      setServiceComponents({ schedulerEnabled: true });

      try {
        const sourcesRes = await app.request("/api/sync/sources");
        expect(sourcesRes.status).toBe(200);
        const sources = await sourcesRes.json();
        expect(sources.sources.some((source: { name: string }) => source.name === "fitbit")).toBe(false);

        const statusRes = await app.request("/api/status");
        expect(statusRes.status).toBe(200);
        const status = await statusRes.json();
        expect(status.scheduler.sources.some((source: { source: string }) => source.source === "fitbit")).toBe(false);

        const pageRes = await app.request("/status.md");
        expect(pageRes.status).toBe(200);

        const patchRes = await app.request("/api/sync/sources/fitbit", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        });
        expect(patchRes.status).toBe(404);
        expect(appDb.prepare("SELECT source FROM sync_sources WHERE source = 'fitbit'").get()).toEqual({ source: "fitbit" });
        expect(appDb.prepare("SELECT state FROM sync_state WHERE source = 'fitbit'").get()).toBeTruthy();
      } finally {
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'fitbit'").run();
        appDb.prepare("DELETE FROM sync_state WHERE source = 'fitbit'").run();
        setServiceComponents({ schedulerEnabled: false });
      }
    });

    test("GET /api/sync/sources reports Trakt tokens stored in sync state as connected", async () => {
      // The preload points homedir() at this run's HOME, where Trakt reads its client credentials.
      const configPath = join(homedir(), ".config", "timeline", "trakt.json");
      const priorConfig = existsSync(configPath) ? readFileSync(configPath, "utf-8") : null;
      const appDb = getAppStateDb();
      const priorState = getSyncState(appDb, "trakt");
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ client_id: "test-client-id", client_secret: "test-client-secret" }));
      setSyncState(appDb, "trakt", {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() + 60_000,
      });

      try {
        const res = await createSyncSourceRoutes("4h").request("/api/sync/sources");
        expect(res.status).toBe(200);
        const json = await res.json();
        const trakt = json.sources.find((source: { name: string }) => source.name === "trakt");
        expect(trakt.authStatus).toBe("connected");
      } finally {
        if (priorConfig === null) rmSync(configPath);
        else writeFileSync(configPath, priorConfig);
        if (priorState === null) deleteSyncState(appDb, "trakt");
        else setSyncState(appDb, "trakt", priorState);
      }
    });

    test("GET /api/sync/sources uses the API startup scheduler default", async () => {
      const appDb = getAppStateDb();
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'trakt'").run();
      const routes = createSyncSourceRoutes("7h");

      try {
        const res = await routes.request("/api/sync/sources");
        expect(res.status).toBe(200);
        const json = await res.json();
        const trakt = json.sources.find((source: { name: string }) => source.name === "trakt");
        expect(trakt).toMatchObject({
          name: "trakt",
          configured: false,
          interval: null,
          effectiveInterval: "7h",
          effectiveIntervalMs: 7 * 60 * 60 * 1000,
          defaultInterval: "7h",
        });
      } finally {
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'trakt'").run();
      }
    });

    test("GET /api/sync/sources reports a source's own default interval", async () => {
      const appDb = getAppStateDb();
      const registered = SYNC_SOURCES.find((source) => source.name === "google-messages");
      if (!registered?.defaultInterval) throw new Error("google-messages has no default interval");
      const sourceDefault = registered.defaultInterval;
      const routes = createSyncSourceRoutes("7h");
      const fetchSource = async () => {
        const res = await routes.request("/api/sync/sources");
        expect(res.status).toBe(200);
        const json = await res.json();
        return json.sources.find((source: { name: string }) => source.name === "google-messages");
      };
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'google-messages'").run();

      try {
        expect(await fetchSource()).toMatchObject({
          interval: null,
          effectiveInterval: sourceDefault,
          effectiveIntervalMs: parseInterval(sourceDefault),
          defaultInterval: sourceDefault,
        });

        appDb.prepare(
          `INSERT INTO sync_sources (source, enabled, interval, settings)
           VALUES ('google-messages', 1, '4h', '{}')`
        ).run();
        expect(await fetchSource()).toMatchObject({
          interval: "4h",
          effectiveInterval: "4h",
          effectiveIntervalMs: 4 * 60 * 60 * 1000,
          defaultInterval: sourceDefault,
        });
      } finally {
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'google-messages'").run();
      }
    });

    test("GET /api/sync/sources combines module and DB enabled flags", async () => {
      const appDb = getAppStateDb();
      const registered = SYNC_SOURCES.find((source) => source.name === "trakt");
      if (!registered) throw new Error("trakt sync source is not registered");
      const previousEnabled = registered.enabled;
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'trakt'").run();
      appDb.prepare(
        `INSERT INTO sync_sources (source, enabled, interval, settings)
         VALUES ('trakt', 1, '4h', '{}')`
      ).run();
      registered.enabled = false;

      try {
        const getRes = await app.request("/api/sync/sources");
        expect(getRes.status).toBe(200);
        const getJson = await getRes.json();
        const trakt = getJson.sources.find((source: { name: string }) => source.name === "trakt");
        expect(trakt).toMatchObject({
          name: "trakt",
          configured: true,
          enabled: false,
        });

        const patchRes = await app.request("/api/sync/sources/trakt", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        });
        expect(patchRes.status).toBe(200);
        expect(await patchRes.json()).toMatchObject({
          name: "trakt",
          configured: true,
          enabled: false,
        });
      } finally {
        registered.enabled = previousEnabled;
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'trakt'").run();
      }
    });

    test("PATCH /api/sync/sources/:source updates enabled and nudges the worker", async () => {
      const appDb = getAppStateDb();
      let nudgeCount = 0;
      setSyncConfigChangedNotifier(() => {
        nudgeCount++;
      });
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'trakt'").run();

      try {
        const patchRes = await app.request("/api/sync/sources/trakt", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        });
        expect(patchRes.status).toBe(200);
        expect(await patchRes.json()).toMatchObject({
          name: "trakt",
          configured: true,
          enabled: false,
        });

        const row = appDb
          .prepare("SELECT enabled, interval, settings FROM sync_sources WHERE source = 'trakt'")
          .get() as { enabled: number; interval: string | null; settings: string } | null;
        expect(row).toEqual({ enabled: 0, interval: null, settings: "{}" });
        expect(nudgeCount).toBe(1);

        const getRes = await app.request("/api/sync/sources");
        const getJson = await getRes.json();
        const trakt = getJson.sources.find((source: { name: string }) => source.name === "trakt");
        expect(trakt.enabled).toBe(false);
      } finally {
        setSyncConfigChangedNotifier(() => {});
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'trakt'").run();
      }
    });

    test("PATCH /api/sync/sources/:source updates interval and nudges the worker", async () => {
      const appDb = getAppStateDb();
      let nudgeCount = 0;
      setSyncConfigChangedNotifier(() => {
        nudgeCount++;
      });
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'trakt'").run();

      try {
        const patchRes = await app.request("/api/sync/sources/trakt", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interval: "30m" }),
        });
        expect(patchRes.status).toBe(200);
        expect(await patchRes.json()).toMatchObject({
          name: "trakt",
          configured: true,
          enabled: false,
          interval: "30m",
          effectiveInterval: "30m",
          effectiveIntervalMs: 30 * 60 * 1000,
        });

        const row = appDb
          .prepare("SELECT enabled, interval, settings FROM sync_sources WHERE source = 'trakt'")
          .get() as { enabled: number; interval: string | null; settings: string } | null;
        expect(row).toEqual({ enabled: 0, interval: "30m", settings: "{}" });
        expect(nudgeCount).toBe(1);
      } finally {
        setSyncConfigChangedNotifier(() => {});
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'trakt'").run();
      }
    });

    test("PATCH /api/sync/sources/:source rejects invalid or unsafe intervals", async () => {
      const appDb = getAppStateDb();
      let nudgeCount = 0;
      setSyncConfigChangedNotifier(() => {
        nudgeCount++;
      });
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'trakt'").run();

      try {
        const invalidIntervals = [
          ["every hour", "Invalid interval format"],
          ["0s", "greater than 0ms"],
          ["2147484s", "no more than 2147483647ms"],
        ];
        for (const [interval, errorMessage] of invalidIntervals) {
          const res = await app.request("/api/sync/sources/trakt", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ interval }),
          });
          expect(res.status).toBe(400);
          const json = await res.json();
          expect(json.error).toContain(errorMessage);
          expect(json.field).toBe("interval");
        }
        expect(nudgeCount).toBe(0);

        const row = appDb
          .prepare("SELECT source FROM sync_sources WHERE source = 'trakt'")
          .get();
        expect(row).toBeNull();
      } finally {
        setSyncConfigChangedNotifier(() => {});
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'trakt'").run();
      }
    });

    test("PATCH /api/sync/sources/:source clears interval override with null", async () => {
      const appDb = getAppStateDb();
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'trakt'").run();
      appDb.prepare(
        `INSERT INTO sync_sources (source, enabled, interval, settings)
         VALUES ('trakt', 1, '4h', '{"account":"alice"}')`
      ).run();

      try {
        const res = await app.request("/api/sync/sources/trakt", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interval: null }),
        });
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toMatchObject({
          name: "trakt",
          configured: true,
          enabled: true,
          interval: null,
          settings: { account: "alice" },
        });
        expect(typeof json.effectiveInterval).toBe("string");
        expect(typeof json.effectiveIntervalMs).toBe("number");
        expect(typeof json.defaultInterval).toBe("string");

        const row = appDb
          .prepare("SELECT interval, settings FROM sync_sources WHERE source = 'trakt'")
          .get() as { interval: string | null; settings: string } | null;
        expect(row).toEqual({ interval: null, settings: '{"account":"alice"}' });
      } finally {
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'trakt'").run();
      }
    });

    test("PATCH /api/sync/sources/:source merges settings and nudges the worker", async () => {
      const appDb = getAppStateDb();
      let nudgeCount = 0;
      setSyncConfigChangedNotifier(() => {
        nudgeCount++;
      });
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'backup'").run();
      appDb.prepare(
        `INSERT INTO sync_sources (source, enabled, interval, settings)
         VALUES ('backup', 1, '4h', '{"legacy_option":true,"destination":"/tmp/old-backups"}')`
      ).run();

      try {
        const res = await app.request("/api/sync/sources/backup", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            settings: { destination: "/tmp/test-backups", keep_count: 3 },
          }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          settings: {
            legacy_option: true,
            destination: "/tmp/test-backups",
            keep_count: 3,
          },
        });
        expect(nudgeCount).toBe(1);
      } finally {
        setSyncConfigChangedNotifier(() => {});
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'backup'").run();
      }
    });

    test("PATCH /api/sync/sources/:source trims string settings and rejects whitespace-only values", async () => {
      const appDb = getAppStateDb();
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'backup'").run();

      try {
        const trimmed = await app.request("/api/sync/sources/backup", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: { destination: "  /tmp/test-backups  " } }),
        });
        expect(trimmed.status).toBe(200);
        expect((await trimmed.json()).settings).toEqual({ destination: "/tmp/test-backups" });

        const whitespace = await app.request("/api/sync/sources/backup", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: { destination: "   " } }),
        });
        expect(whitespace.status).toBe(400);
        expect(await whitespace.json()).toEqual({
          error: "settings.destination must be a non-empty string",
          field: "settings.destination",
        });
      } finally {
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'backup'").run();
      }
    });

    test("packaged sync settings reject relative paths", async () => {
      const appDb = getAppStateDb();
      const previousResourceRoot = process.env.TIMELINE_RESOURCE_ROOT;
      process.env.TIMELINE_RESOURCE_ROOT = process.cwd();
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'backup'").run();

      try {
        const response = await app.request("/api/sync/sources/backup", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: { destination: "./backups" } }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error:
            "sync.backup.destination must be an absolute path for the packaged service: ./backups. Use an absolute path or a path beginning with ~/.",
          field: "settings",
        });
      } finally {
        if (previousResourceRoot === undefined) {
          delete process.env.TIMELINE_RESOURCE_ROOT;
        } else {
          process.env.TIMELINE_RESOURCE_ROOT = previousResourceRoot;
        }
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'backup'").run();
      }
    });

    test("PATCH /api/sync/sources/:source rejects empty string-list settings", async () => {
      const amp = SYNC_SOURCES.find((source) => source.name === "amp");
      if (!amp?.configSchema) throw new Error("amp sync source is missing its settings schema");
      const field = {
        key: "test_string_list",
        type: "string-list" as const,
        label: "Test string list",
      };
      amp.configSchema.push(field);

      try {
        const res = await app.request("/api/sync/sources/amp", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: { test_string_list: [] } }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: "settings.test_string_list must be a non-empty array; use null to clear the key",
          field: "settings.test_string_list",
        });
      } finally {
        amp.configSchema.pop();
      }
    });

    test("PATCH /api/sync/sources/:source validates settings keys and values", async () => {
      const requests = [
        ["backup", { settings: [] }, "settings must be a JSON object", "settings"],
        [
          "backup",
          { settings: { unknown_setting: true } },
          "Unknown settings key: unknown_setting",
          "settings.unknown_setting",
        ],
        [
          "backup",
          { settings: { destination: 42 } },
          "settings.destination must be a non-empty string",
          "settings.destination",
        ],
        [
          "backup",
          { settings: { keep_count: 1.5 } },
          "settings.keep_count must be a safe integer",
          "settings.keep_count",
        ],
        [
          "backup",
          { settings: { keep_count: 1e20 } },
          "settings.keep_count must be a safe integer",
          "settings.keep_count",
        ],
        [
          "backup",
          { settings: { keep_count: 2 ** 53 } },
          "settings.keep_count must be a safe integer",
          "settings.keep_count",
        ],
        [
          "backup",
          { settings: { keep_count: 0 } },
          "settings.keep_count must be at least 1",
          "settings.keep_count",
        ],
        [
          "attachment-descriptions",
          { settings: { time_budget_ms: MAX_TIMEOUT_DELAY_MS + 1 } },
          `settings.time_budget_ms must be at most ${MAX_TIMEOUT_DELAY_MS}`,
          "settings.time_budget_ms",
        ],
        [
          "amp",
          { settings: { mode: "invalid" } },
          "settings.mode must be one of: auto, api, files",
          "settings.mode",
        ],
        [
          "discord",
          { settings: {} },
          "settings are not editable for this source",
          "settings",
        ],
      ];

      for (const [source, body, error, field] of requests) {
        const res = await app.request(`/api/sync/sources/${source}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error, field });
      }
    });

    test("PATCH /api/sync/sources/:source validates enabled with a field path", async () => {
      const res = await app.request("/api/sync/sources/trakt", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: "yes" }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "enabled must be a boolean",
        field: "enabled",
      });
    });

    test("PATCH /api/sync/sources/:source applies combined configuration atomically", async () => {
      const appDb = getAppStateDb();
      let nudgeCount = 0;
      setSyncConfigChangedNotifier(() => {
        nudgeCount++;
      });
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'backup'").run();
      appDb.prepare(
        `INSERT INTO sync_sources (source, enabled, interval, settings)
         VALUES ('backup', 1, '4h', '{"destination":"/tmp/original-backups","keep_count":3}')`
      ).run();

      try {
        const res = await app.request("/api/sync/sources/backup", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled: false,
            interval: "30m",
            settings: { destination: "/tmp/new-backups", keep_count: 0 },
          }),
        });

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: "settings.keep_count must be at least 1",
          field: "settings.keep_count",
        });
        const row = appDb
          .prepare("SELECT enabled, interval, settings FROM sync_sources WHERE source = 'backup'")
          .get() as { enabled: number; interval: string | null; settings: string } | null;
        expect(row).toEqual({
          enabled: 1,
          interval: "4h",
          settings: '{"destination":"/tmp/original-backups","keep_count":3}',
        });
        expect(nudgeCount).toBe(0);
      } finally {
        setSyncConfigChangedNotifier(() => {});
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'backup'").run();
      }
    });

    test("attachment description settings persist, validate, and clear a smaller image limit", async () => {
      const appDb = getAppStateDb();
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'attachment-descriptions'").run();
      const setLimit = (max_image_dimension: unknown) => app.request("/api/sync/sources/attachment-descriptions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { max_image_dimension } }),
      });
      try {
        const saved = await setLimit(1024);
        expect(saved.status).toBe(200);
        expect((await saved.json()).settings).toEqual({ max_image_dimension: 1024 });
        for (const invalid of [0, -1, 1.5, 2049, "1024"]) {
          const rejected = await setLimit(invalid);
          expect(rejected.status).toBe(400);
          expect((await rejected.json()).field).toBe("settings.max_image_dimension");
        }
        const row = appDb.prepare("SELECT settings FROM sync_sources WHERE source = 'attachment-descriptions'")
          .get() as { settings: string };
        expect(JSON.parse(row.settings)).toEqual({ max_image_dimension: 1024 });
        const cleared = await setLimit(null);
        expect(cleared.status).toBe(200);
        expect((await cleared.json()).settings).toEqual({});
      } finally {
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'attachment-descriptions'").run();
      }
    });

    test("PATCH /api/sync/sources/:source accepts the maximum time budget", async () => {
      const appDb = getAppStateDb();
      appDb.prepare("DELETE FROM sync_sources WHERE source = 'attachment-descriptions'").run();

      try {
        const res = await app.request("/api/sync/sources/attachment-descriptions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: { time_budget_ms: MAX_TIMEOUT_DELAY_MS } }),
        });
        expect(res.status).toBe(200);
        expect((await res.json()).settings).toEqual({ time_budget_ms: MAX_TIMEOUT_DELAY_MS });
      } finally {
        appDb.prepare("DELETE FROM sync_sources WHERE source = 'attachment-descriptions'").run();
      }
    });

    test("PATCH /api/sync/sources/:source returns 404 for unknown sources", async () => {
      const res = await app.request("/api/sync/sources/not-a-source", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(404);
    });

    test("PATCH /api/sync/sources/:source rejects unknown body keys", async () => {
      const res = await app.request("/api/sync/sources/trakt", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, extra: true }),
      });
      expect(res.status).toBe(400);
    });

    test("PUT /api/settings/network saves a trimmed, de-duplicated blocked-network list", async () => {
      try {
        const res = await app.request("/api/settings/network", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blockedNetworks: [" iPhone ", "Train WiFi", "iphone"] }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ blockedNetworks: ["iPhone", "Train WiFi"] });

        const get = await app.request("/api/settings/network");
        expect(get.status).toBe(200);
        expect(await get.json()).toEqual({ blockedNetworks: ["iPhone", "Train WiFi"] });
      } finally {
        setBlockedNetworks(getAppStateDb(), []);
      }
    });

    test("PUT /api/settings/network rejects malformed lists", async () => {
      for (const body of [{}, { blockedNetworks: "iPhone" }, { blockedNetworks: ["ok", ""] }, { blockedNetworks: [1] }]) {
        const res = await app.request("/api/settings/network", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ field: "blockedNetworks" });
      }
    });

    test("status endpoints expose skipped sync logs as deferred", async () => {
      const appDb = getAppStateDb();
      const source = "trakt";
      const staleSource = `status_stale_test_${crypto.randomUUID().replaceAll("-", "_")}`;

      appDb.prepare("DELETE FROM sync_sources WHERE source = ?").run(source);
      appDb.prepare(`
        INSERT INTO sync_sources (source, enabled, interval, settings)
        VALUES (?, 1, '1h', '{}')
      `).run(source);
      appDb.prepare(`
        INSERT INTO scheduler_state (source, last_run_at, next_run_at, interval_ms, enabled)
        VALUES (?, datetime('now'), datetime('now', '+1 hour'), 3600000, 1)
      `).run(source);
      appDb.prepare(`
        INSERT INTO scheduler_state (source, last_run_at, next_run_at, interval_ms, enabled)
        VALUES (?, datetime('now'), datetime('now', '+1 hour'), 3600000, 1)
      `).run(staleSource);
      appDb.prepare(`
        INSERT INTO sync_log
          (source, started_at, finished_at, success, skipped, events_added, events_updated, error, duration_ms)
        VALUES (?, datetime('now'), datetime('now'), 1, 1, 0, 0, NULL, 5)
      `).run(source);

      setServiceComponents({ schedulerEnabled: true });

      try {
        const statusRes = await app.request("/api/status");
        expect(statusRes.status).toBe(200);
        const statusJson = await statusRes.json();
        const sourceStatus = statusJson.scheduler.sources.find((s: { source: string }) => s.source === source);
        expect(sourceStatus?.lastRun).toMatchObject({
          success: true,
          skipped: true,
        });
        expect(statusJson.scheduler.sources.some((s: { source: string }) => s.source === staleSource)).toBe(false);

        const historyRes = await app.request(`/api/status/sync-history?source=${source}&limit=1`);
        expect(historyRes.status).toBe(200);
        const historyJson = await historyRes.json();
        expect(historyJson.entries[0]).toMatchObject({
          source,
          success: 1,
          skipped: 1,
        });

        const markdownRes = await app.request("/status.md");
        expect(markdownRes.status).toBe(200);
        const markdown = await markdownRes.text();
        expect(markdown).toContain(`| ${source} | 1 | - | 1 | - | - |`);
        expect(markdown).toContain(`| ${source} | deferred |`);
        expect(markdown).not.toContain(`| ${source} | OK 0 events`);
      } finally {
        appDb.prepare("DELETE FROM sync_sources WHERE source = ?").run(source);
        appDb.prepare("DELETE FROM scheduler_state WHERE source = ?").run(source);
        appDb.prepare("DELETE FROM scheduler_state WHERE source = ?").run(staleSource);
        appDb.prepare("DELETE FROM sync_log WHERE source = ?").run(source);
        setServiceComponents({ schedulerEnabled: false });
      }
    });

    test("GET /api/status/inbox-sources returns sources list", async () => {
      const res = await app.request("/api/status/inbox-sources");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toHaveProperty("basePath");
      expect(json).toHaveProperty("sources");
      expect(Array.isArray(json.sources)).toBe(true);
    });

    test("POST /api/inbox/upload rejects missing file", async () => {
      const formData = new FormData();
      formData.append("source", "test");
      const res = await app.request("/api/inbox/upload", {
        method: "POST",
        body: formData,
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.message).toContain("No file");
    });

    test("POST /api/inbox/upload rejects missing source", async () => {
      const file = new File(["test"], "test.json", { type: "application/json" });
      const formData = new FormData();
      formData.append("file", file);
      const res = await app.request("/api/inbox/upload", {
        method: "POST",
        body: formData,
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.message).toContain("source");
    });

    test("POST /api/inbox/upload rejects unknown source", async () => {
      const file = new File(["test"], "test.json", { type: "application/json" });
      const formData = new FormData();
      formData.append("file", file);
      formData.append("source", "nonexistent-source");
      const res = await app.request("/api/inbox/upload", {
        method: "POST",
        body: formData,
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.message).toContain("Unknown inbox source");
    });

    test.each([".hidden", "x/.hidden.xml"])("POST /api/inbox/upload rejects filename %s", async (name) => {
      const file = new File(["test"], name, { type: "application/json" });
      const formData = new FormData();
      formData.append("file", file);
      formData.append("source", "test");
      const res = await app.request("/api/inbox/upload", {
        method: "POST",
        body: formData,
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.message).toContain("Invalid filename");
    });

    test("POST /api/inbox/upload publishes complete files and cleans up failed writes", async () => {
      const source = "upload-test";
      const filename = "sample.json";
      const payload = '{"value":42}';
      const directory = mkdtempSync(join(tmpdir(), "inbox-upload-"));
      const configPath = join(directory, "config.toml");
      const sourceDir = join(directory, "source");
      const finalPath = join(sourceDir, filename);
      const previousConfig = process.env.TIMELINE_CONFIG;
      const db = getAppStateDb();
      const upload = () => {
        const body = new FormData();
        body.append("file", new File([payload], filename));
        body.append("source", source);
        return app.request("/api/inbox/upload", { method: "POST", body });
      };

      writeFileSync(configPath, `[inbox.sources.${source}]\nlocal = "${sourceDir}"\npatterns = ["*", ".upload-*.tmp"]\n`);
      process.env.TIMELINE_CONFIG = configPath;
      try {
        const response = await upload();
        expect(response.status).toBe(200);
        expect(readFileSync(finalPath, "utf8")).toBe(payload);
        expect(readdirSync(sourceDir)).toEqual([filename]);
        markFileProcessed(db, source, finalPath, await hashFile(finalPath), payload.length);

        expect((await upload()).status).toBe(200);
        expect(readFileSync(finalPath, "utf8")).toBe(payload);
        expect(readdirSync(sourceDir)).toEqual([filename]);
        expect(await findUnprocessedFiles(db, source, sourceDir)).toEqual([]);

        let filesDuringWrite: Awaited<ReturnType<typeof findUnprocessedFiles>> | undefined;
        const writeFailure = spyOn(Bun, "write").mockImplementation(async (destination) => {
          const tempPath = String(destination);
          writeFileSync(tempPath, '{"value":');
          filesDuringWrite = await findUnprocessedFiles(db, source, sourceDir, ["*", ".upload-*.tmp"]);
          throw new Error("Injected upload write failure");
        });
        try {
          expect((await upload()).status).toBe(500);
          expect(writeFailure).toHaveBeenCalledTimes(1);
          const tempPath = String(writeFailure.mock.calls[0]?.[0]);
          expect(dirname(tempPath)).toBe(sourceDir);
          expect(tempPath).toMatch(/\/\.upload-[0-9a-f-]+\.tmp$/);
          expect(filesDuringWrite).toEqual([]);
          expect(readFileSync(finalPath, "utf8")).toBe(payload);
          expect(readdirSync(sourceDir)).toEqual([filename]);
        } finally {
          writeFailure.mockRestore();
        }
      } finally {
        process.env.TIMELINE_CONFIG = previousConfig;
        db.prepare("DELETE FROM processed_files WHERE source = ?").run(source);
        db.prepare("DELETE FROM jobs WHERE source = ?").run(source);
        rmSync(directory, { recursive: true, force: true });
      }
    });

    test("POST /api/status/trigger-sync rejects missing source", async () => {
      const res = await app.request("/api/status/trigger-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.message).toContain("source");
    });

    test("POST /api/status/trigger-sync rejects unregistered source without a job", async () => {
      const source = "fitbit";
      const db = getAppStateDb();
      const countJobs = () =>
        (db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE source = ?").get(source) as { count: number }).count;
      const before = countJobs();

      const res = await app.request("/api/status/trigger-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ success: false, message: "Unknown sync source: fitbit" });
      expect(countJobs()).toBe(before);
    });

    test("POST /api/status/trigger-sync enqueues a job", async () => {
      const source = "google-health";

      const res = await app.request("/api/status/trigger-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(typeof json.jobId).toBe("number");

      // Second trigger for the same source dedupes onto the existing queued job.
      const res2 = await app.request("/api/status/trigger-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      const json2 = await res2.json();
      expect(json2.success).toBe(true);
      expect(json2.jobId).toBe(json.jobId);
      expect(json2.deduped).toBe(true);

      // The job is fetchable via /api/jobs/:id.
      const jobRes = await app.request(`/api/jobs/${json.jobId}`);
      expect(jobRes.status).toBe(200);
      const jobJson = await jobRes.json();
      expect(jobJson.job.id).toBe(json.jobId);
      expect(jobJson.job.kind).toBe("sync");
      expect(jobJson.job.source).toBe(source);
      expect(jobJson.job.status).toBe("queued");
    });

    test("GET /api/status/trigger-sync rejects unregistered source without a job", async () => {
      const source = "fitbit";
      const db = getAppStateDb();
      const countJobs = () =>
        (db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE source = ?").get(source) as { count: number }).count;
      const before = countJobs();

      const res = await app.request(`/api/status/trigger-sync?source=${source}`);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ success: false, message: "Unknown sync source: fitbit" });
      expect(countJobs()).toBe(before);
    });

    test("GET /api/status/trigger-sync enqueues a registered source and redirects", async () => {
      const source = "steam";
      const res = await app.request(`/api/status/trigger-sync?source=${source}`);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/status");
      const jobs = getAppStateDb()
        .prepare("SELECT kind, source, status FROM jobs WHERE source = ? ORDER BY id DESC LIMIT 1")
        .get(source) as { kind: string; source: string; status: string } | null;
      expect(jobs).toEqual({ kind: "sync", source, status: "queued" });
    });
  });

  describe("Jobs API", () => {
    test("GET /api/jobs falls back for negative limit", async () => {
      const appDb = getAppStateDb();
      const prefix = `jobs-negative-limit-${crypto.randomUUID()}`;

      try {
        // enqueueJob commits each job in its own transaction, so insert the rows directly.
        seed(appDb, () => {
          const insert = appDb.prepare("INSERT INTO jobs (kind, source, dedupe_key) VALUES ('sync', ?, ?)");
          for (let i = 0; i < 55; i++) insert.run(`${prefix}-${i}`, `${prefix}:${i}`);
        });

        const res = await app.request("/api/jobs?limit=-1");
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.jobs).toHaveLength(50);
        expect(json.count).toBe(50);
      } finally {
        appDb.prepare("DELETE FROM jobs WHERE source LIKE ?").run(`${prefix}-%`);
      }
    });

    test("GET /api/jobs rejects invalid status", async () => {
      const res = await app.request("/api/jobs?status=banana");
      expect(res.status).toBe(400);
    });

    test("GET /api/jobs filters by status", async () => {
      const appDb = getAppStateDb();
      const source = `jobs-status-filter-${crypto.randomUUID()}`;
      try {
        const queued = enqueueJob({ kind: "sync", source, dedupeKey: `${source}:queued` }, appDb).jobId;
        const cancelled = enqueueJob({ kind: "sync", source, dedupeKey: `${source}:cancelled` }, appDb).jobId;
        expect(cancelJob(cancelled, appDb)).toBe(true);

        const jobIds = async (status: string) => {
          const res = await app.request(`/api/jobs?source=${source}&status=${status}`);
          expect(res.status).toBe(200);
          return ((await res.json()).jobs as Array<{ id: number }>).map((job) => job.id);
        };
        expect(await jobIds("queued")).toEqual([queued]);
        expect(await jobIds("cancelled")).toEqual([cancelled]);
        expect((await jobIds("queued,cancelled")).sort((a, b) => a - b)).toEqual([queued, cancelled]);
      } finally {
        appDb.prepare("DELETE FROM jobs WHERE source = ?").run(source);
      }
    });

    test("GET /api/jobs/:id returns 404 for missing job", async () => {
      const res = await app.request("/api/jobs/9999999");
      expect(res.status).toBe(404);
    });

    test("POST /api/jobs/:id/cancel cancels a queued job", async () => {
      // Enqueue a job we can cancel
      const trig = await app.request("/api/status/trigger-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "trakt" }),
      });
      const trigJson = await trig.json();
      const jobId = trigJson.jobId;

      const cancel = await app.request(`/api/jobs/${jobId}/cancel`, {
        method: "POST",
      });
      expect(cancel.status).toBe(200);
      const cancelJson = await cancel.json();
      expect(cancelJson.job.status).toBe("cancelled");

      // Cancelling an already-terminal job is rejected.
      const again = await app.request(`/api/jobs/${jobId}/cancel`, {
        method: "POST",
      });
      expect(again.status).toBe(409);
    });
  });

  describe("MCP sessions API", () => {
    test("serves dashboard routes without shadowing the MCP transport", async () => {
      // The SPA fallback is only registered when web/dist exists (not built
      // in the backend test environment), so assert against "/" — the
      // canonical SPA route — rather than a fixed 200. If the MCP transport
      // shadowed these paths again, they would diverge from "/" with a
      // JSON-RPC error response instead.
      const root = await app.request("/");
      for (const path of ["/mcp-sessions", "/mcp-sessions/session-direct-load"]) {
        const res = await app.request(path);
        expect(res.status).toBe(root.status);
        expect(res.headers.get("content-type")).toBe(root.headers.get("content-type"));
        expect(await res.text()).not.toContain("jsonrpc");
      }
    });

    test("GET /api/mcp/sessions lists aggregate session stats", async () => {
      const appDb = getAppStateDb();
      const sessionId = `api-mcp-${crypto.randomUUID()}`;

      try {
        appDb.prepare(`
          INSERT INTO mcp_sessions (
            id, transport, client_name, client_version, token_hash,
            created_at, last_activity_at
          )
          VALUES (?, 'http', 'Test Client', '1.0.0', 'abc123def4567890',
            datetime('now', '-2 minutes'), datetime('now'))
        `).run(sessionId);
        appDb.prepare(`
          INSERT INTO mcp_tool_calls (
            session_id, tool_name, args_json, args_chars, result_text,
            result_chars, is_error, truncated, duration_ms
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(sessionId, "query_events", "{}", 2, "ok", 2, 0, 0, 15);
        appDb.prepare(`
          INSERT INTO mcp_tool_calls (
            session_id, tool_name, args_json, args_chars, result_text,
            result_chars, is_error, truncated, duration_ms
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(sessionId, "run_sql", "{\"sql\":\"bad\"}", 13, "Error: bad SQL", 14, 1, 0, 20);

        const res = await app.request("/api/mcp/sessions?limit=20");
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(Array.isArray(json.sessions)).toBe(true);
        const session = json.sessions.find((row: { id: string }) => row.id === sessionId);
        expect(session).toBeDefined();
        if (!session) throw new Error("Expected seeded MCP session in list response");
        expect(session.call_count).toBe(2);
        expect(session.error_count).toBe(1);
        expect(session.client_name).toBe("Test Client");
        expect(session.token_hash).toBe("abc123def4567890");
      } finally {
        appDb.prepare("DELETE FROM mcp_sessions WHERE id = ?").run(sessionId);
      }
    });

    test("GET /api/mcp/sessions/:id returns session detail and calls", async () => {
      const appDb = getAppStateDb();
      const sessionId = `api-mcp-${crypto.randomUUID()}`;

      try {
        appDb.prepare(`
          INSERT INTO mcp_sessions (id, transport, client_name, created_at, last_activity_at)
          VALUES (?, 'stdio', 'Claude Code', datetime('now'), datetime('now'))
        `).run(sessionId);
        appDb.prepare(`
          INSERT INTO mcp_tool_calls (
            session_id, tool_name, args_json, args_chars, result_text,
            result_chars, is_error, truncated, duration_ms, created_at
          )
          VALUES (?, 'get_summary', '{}', 2, 'summary', 7, 0, 0, 9, datetime('now'))
        `).run(sessionId);

        const res = await app.request(`/api/mcp/sessions/${encodeURIComponent(sessionId)}`);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.session.id).toBe(sessionId);
        expect(json.session.transport).toBe("stdio");
        expect(json.calls).toHaveLength(1);
        expect(json.calls[0].tool_name).toBe("get_summary");
        expect(json.count).toBe(1);
        expect(json.stats).toEqual({
          call_count: 1,
          error_count: 0,
          avg_duration_ms: 9,
        });
      } finally {
        appDb.prepare("DELETE FROM mcp_sessions WHERE id = ?").run(sessionId);
      }
    });

    test("GET /api/mcp/sessions/:id.md returns markdown without changing the JSON route", async () => {
      const appDb = getAppStateDb();
      const sessionId = `api-mcp-${crypto.randomUUID()}`;

      try {
        appDb.prepare(`
          INSERT INTO mcp_sessions (id, transport, client_name, created_at, last_activity_at)
          VALUES (?, 'stdio', 'Claude Code', datetime('now'), datetime('now'))
        `).run(sessionId);
        appDb.prepare(`
          INSERT INTO mcp_tool_calls (
            session_id, tool_name, args_json, args_chars, result_text,
            result_chars, is_error, truncated, duration_ms, created_at
          )
          VALUES (?, 'get_summary', '{"date":"2026-07-03"}', 21, 'summary', 7, 0, 0, 9, datetime('now'))
        `).run(sessionId);

        const markdownRes = await app.request(`/api/mcp/sessions/${encodeURIComponent(sessionId)}.md`);
        expect(markdownRes.status).toBe(200);
        expect(markdownRes.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
        const markdown = await markdownRes.text();
        expect(markdown).toContain(`# MCP session \`${sessionId}\``);
        expect(markdown).toContain("`get_summary`");

        const jsonRes = await app.request(`/api/mcp/sessions/${encodeURIComponent(sessionId)}`);
        expect(jsonRes.status).toBe(200);
        expect(jsonRes.headers.get("content-type")).toContain("application/json");
        const json = await jsonRes.json();
        expect(json.session.id).toBe(sessionId);
      } finally {
        appDb.prepare("DELETE FROM mcp_sessions WHERE id = ?").run(sessionId);
      }
    });

    test("GET /api/mcp/sessions/:id.md returns 404 for missing sessions", async () => {
      const res = await app.request("/api/mcp/sessions/api-mcp-missing.md");
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("MCP session not found");
    });

    test("GET /api/mcp/sessions/:id returns true totals beyond the page", async () => {
      const appDb = getAppStateDb();
      const sessionId = `api-mcp-${crypto.randomUUID()}`;

      try {
        appDb.prepare(`
          INSERT INTO mcp_sessions (id, transport, client_name, created_at, last_activity_at)
          VALUES (?, 'stdio', 'Claude Code', datetime('now'), datetime('now'))
        `).run(sessionId);

        const insert = appDb.prepare(`
          INSERT INTO mcp_tool_calls (
            session_id, tool_name, args_json, args_chars, result_text,
            result_chars, is_error, truncated, duration_ms, created_at
          )
          VALUES (?, ?, '{}', 2, 'ok', 2, ?, 0, ?, datetime('now', ?))
        `);
        seed(appDb, () => {
          for (let i = 0; i < 205; i++) {
            insert.run(sessionId, "get_summary", i % 5 === 0 ? 1 : 0, i + 1, `-${i} seconds`);
          }
        });

        const res = await app.request(`/api/mcp/sessions/${encodeURIComponent(sessionId)}?limit=-1`);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.calls).toHaveLength(200);
        expect(json.count).toBe(205);
        expect(json.stats.call_count).toBe(205);
        expect(json.stats.error_count).toBe(41);
        expect(Math.round(json.stats.avg_duration_ms)).toBe(103);
      } finally {
        appDb.prepare("DELETE FROM mcp_sessions WHERE id = ?").run(sessionId);
      }
    });

    test("GET /api/mcp/sessions falls back for negative limit", async () => {
      const appDb = getAppStateDb();
      const prefix = `api-mcp-limit-${crypto.randomUUID()}`;

      try {
        const insert = appDb.prepare(`
          INSERT INTO mcp_sessions (id, transport, created_at, last_activity_at)
          VALUES (?, 'http', datetime('now'), datetime('now'))
        `);
        seed(appDb, () => {
          for (let i = 0; i < 55; i++) {
            insert.run(`${prefix}-${i}`);
          }
        });

        const res = await app.request("/api/mcp/sessions?limit=-1");
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.sessions).toHaveLength(50);
        expect(json.count).toBe(50);
      } finally {
        appDb.prepare("DELETE FROM mcp_sessions WHERE id LIKE ?").run(`${prefix}-%`);
      }
    });

    test("GET /api/mcp/sessions/:id returns 404 for missing session", async () => {
      const res = await app.request("/api/mcp/sessions/api-mcp-missing");
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("MCP session not found");
    });
  });

  describe("Coding Project Conversations", () => {
    test("GET /api/coding/projects/:name/conversations groups by source-specific project field", async () => {
      const { getDb, initDb } = await import("../db/schema");
      const db = getDb();
      initDb(db);

      const insert = db.prepare(`
        INSERT OR IGNORE INTO events (
          source, source_id, source_account, type, timestamp,
          title, content, people, tags, raw_data, import_batch, conversation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Conductor: repo_name match.
      insert.run(
        "conductor",
        "coding-project-test-cond-1",
        "alice",
        "conductor:message:user",
        "2099-02-01T10:00:00.000Z",
        "coding-project-test / valencia-v1: Plan auth",
        "hello",
        JSON.stringify(["conductor:alice"]),
        null,
        JSON.stringify({ repo_name: "coding-project-test", workspace_name: "valencia-v1" }),
        "test-coding-projects",
        "session-cond-1"
      );

      // Amp run inside a Conductor workspace: should still associate with the repo.
      insert.run(
        "amp",
        "coding-project-test-amp-conductor-1",
        "alice",
        "amp:message:user",
        "2099-02-02T10:00:00.000Z",
        "Plan migrations",
        "do the migration",
        JSON.stringify(["amp:alice"]),
        null,
        JSON.stringify({
          workspace_roots: ["/Users/x/conductor/workspaces/coding-project-test/beta-v2"],
        }),
        "test-coding-projects",
        "thread-amp-conductor-1"
      );

      // Amp run in a plain (non-Conductor) workspace.
      insert.run(
        "amp",
        "coding-project-test-amp-plain-1",
        "alice",
        "amp:message:user",
        "2099-02-03T10:00:00.000Z",
        "Fix bug",
        "fix the bug",
        JSON.stringify(["amp:alice"]),
        null,
        JSON.stringify({ workspace_roots: ["/tmp/coding-project-test"] }),
        "test-coding-projects",
        "thread-amp-plain-1"
      );

      // Unrelated conductor message — should NOT appear under our project.
      insert.run(
        "conductor",
        "coding-project-other-cond-1",
        "alice",
        "conductor:message:user",
        "2099-02-04T10:00:00.000Z",
        "other-project: irrelevant",
        "nope",
        JSON.stringify(["conductor:alice"]),
        null,
        JSON.stringify({ repo_name: "other-project" }),
        "test-coding-projects",
        "session-other-1"
      );

      // Claude-code session launched from .../coding-project-test that
      // cd'd into a "web" subdir mid-session. cwd ends in /web but the
      // session's project (per the title) is "coding-project-test". This
      // event must NOT match a query for project name "web".
      insert.run(
        "claude-code",
        "coding-project-test-cc-subdir-1",
        "alice",
        "claude-code:message:user",
        "2099-02-05T10:00:00.000Z",
        "coding-project-test (ancient-snuggling-slug)",
        "hi",
        JSON.stringify(["claude-code:alice"]),
        null,
        JSON.stringify({ cwd: "/Users/x/Developer/coding-project-test/web" }),
        "test-coding-projects",
        "session-cc-subdir-1"
      );

      db.close();

      const res = await app.request("/api/coding/projects/coding-project-test/conversations");
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json).toHaveProperty("conversations");
      expect(json).toHaveProperty("total");
      expect(Array.isArray(json.conversations)).toBe(true);

      const sources = json.conversations.map((c: { source: string }) => c.source).sort();
      expect(sources).toEqual(["amp", "amp", "claude-code", "conductor"]);

      // The unrelated "other-project" message must be excluded.
      const titles = json.conversations.map((c: { title: string }) => c.title);
      expect(titles).not.toContain("other-project: irrelevant");

      // Querying the "web" project must NOT pull in the claude-code session
      // that merely cd'd into a /web subdirectory.
      const webRes = await app.request("/api/coding/projects/web/conversations");
      const webJson = await webRes.json();
      const webTitles = webJson.conversations.map((c: { title: string }) => c.title);
      expect(webTitles).not.toContain("coding-project-test (ancient-snuggling-slug)");

      // Shape check on a single conversation.
      const first = json.conversations[0];
      expect(first).toHaveProperty("source");
      expect(first).toHaveProperty("title");
      expect(first).toHaveProperty("messageCount");
      expect(first).toHaveProperty("lastMessage");
      expect(first).toHaveProperty("lastEventId");
      expect(typeof first.lastEventId).toBe("number");
    });

    test("conversation scopes split Messages, chat assistants, and coding agents", async () => {
      const db = getDb();
      const insert = db.prepare(`
        INSERT OR IGNORE INTO events (source, source_id, source_account, type, timestamp, title, content, raw_data, conversation_id)
        VALUES (?, ?, 'alice', ?, '2099-03-01T10:00:00.000Z', ?, 'hi', ?, ?)
      `);
      insert.run("codex", "ai-list-api-codex", "codex:message:user", "ai-list-api session", JSON.stringify({ cwd: "/srv/ai-list-api-project" }), "ai-list-api-codex-thread");
      insert.run("amp", "ai-list-api-amp", "amp:message:user", "ai-list-api scratch", "{}", "ai-list-api-amp-thread");
      insert.run("chatgpt", "ai-list-api-chatgpt", "chatgpt:message:user", "ai-list-api chat", "{}", "ai-list-api-chatgpt-thread");
      insert.run("discord", "ai-list-api-discord", "message:dm", "ai-list-api dm", "{}", "ai-list-api-discord-thread");
      db.close();

      const ids = (json: { conversations: { conversationId: string }[] }) =>
        json.conversations.map((c) => c.conversationId).sort();

      const messages = await (await app.request("/api/conversations?search=ai-list-api")).json();
      expect(ids(messages)).toEqual(["ai-list-api-discord-thread"]);
      const messageSources = await (await app.request("/api/conversations/sources")).json();
      expect(messageSources.sources).not.toContain("codex");
      expect(messageSources.sources).not.toContain("chatgpt");

      const assistants = await (await app.request("/api/conversations?scope=assistants&search=ai-list-api")).json();
      expect(ids(assistants)).toEqual(["ai-list-api-chatgpt-thread"]);
      const assistantSources = await (await app.request("/api/conversations/sources?scope=assistants")).json();
      expect(assistantSources.sources).toEqual(["chatgpt"]);
      expect((await app.request("/api/conversations?scope=coding")).status).toBe(400);
      expect((await app.request("/api/conversations/sources?scope=bogus")).status).toBe(400);

      const res = await app.request("/api/coding/conversations?search=ai-list-api");
      expect(res.status).toBe(200);
      expectServerTimings(res, ["coding.conversations.list"]);
      const coding = await res.json();
      expect(coding.conversations.map((c: { source: string; project: string | null }) => [c.source, c.project]).sort()).toEqual([
        ["amp", null],
        ["codex", "ai-list-api-project"],
      ]);

      const byProject = await (await app.request("/api/coding/conversations?project=ai-list-api-project")).json();
      expect(ids(byProject)).toEqual(["ai-list-api-codex-thread"]);

      const unassigned = await (await app.request("/api/coding/conversations?unassigned=1&search=ai-list-api")).json();
      expect(ids(unassigned)).toEqual(["ai-list-api-amp-thread"]);

      expect((await app.request("/api/coding/conversations?project=x&unassigned=1")).status).toBe(400);
      expect((await app.request("/api/coding/conversations?unassigned=0")).status).toBe(400);
      const badPaging = await app.request("/api/coding/conversations?limit=-1&offset=abc");
      expect(badPaging.status).toBe(200);
      expect((await badPaging.json()).conversations.length).toBeLessThanOrEqual(50);

      const filters = await (await app.request("/api/coding/conversations/filters")).json();
      expect(filters.sources).toContain("codex");
      expect(filters.sources).not.toContain("chatgpt");
      expect(filters.projects).toContainEqual({ name: "ai-list-api-project", count: 1 });
      expect(filters.unassigned).toBeGreaterThanOrEqual(1);
    });

    test("GET /api/coding/projects/:name/conversations returns empty list for unknown project", async () => {
      const res = await app.request(
        "/api/coding/projects/definitely-not-a-real-project-xyz/conversations"
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.conversations).toEqual([]);
      expect(json.total).toBe(0);
    });
  });
});
