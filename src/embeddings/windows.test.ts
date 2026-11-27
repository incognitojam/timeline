import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { EmbeddingsConfig } from "../config";
import { wrapDatabase } from "../db/pool";
import { initDb } from "../db/schema";
import { Database } from "../db/sqlite";
import { skipWithoutSqliteVec } from "../testing/sqlite-vec";
import { createEmbeddingClient, resolveEmbeddingProfile } from "./config";
import { EVENT_LEAN_PROFILE } from "./content";
import {
  ensureContentProfile,
  ensureModelProfile,
  getEmbeddingsDb,
  initEmbeddingsDb,
  insertVector,
  setIndexCursor,
  upsertDocument,
  vecTableName,
} from "./db";
import { formatWindowHit, searchEmbeddingsWithWindows } from "./search";
import { configureBunSqliteForSqliteVec } from "./sqlite-vec";
import {
  conversationWindowProfile,
  cutWindows,
  indexConversationWindows,
  splitSessions,
  WINDOW_MAX_BYTES,
  type WindowIndexCounts,
  type WindowLine,
} from "./windows";

function line(eventId: number, minute: number, bytes = 10): WindowLine {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 10, minute)).toISOString();
  const text = "x".repeat(bytes);
  return { eventId, timestamp, text, bytes, title: "Bob" };
}

describe("cutting conversation windows", () => {
  it("splits sessions on a gap longer than 30 minutes", () => {
    const sessions = splitSessions([line(1, 0), line(2, 30), line(3, 61), line(4, 62)]);
    expect(sessions.map(session => session.map(entry => entry.eventId))).toEqual([[1, 2], [3, 4]]);
  });

  it("skips a one-message session", () => {
    expect(cutWindows([line(1, 0)])).toEqual([]);
    expect(cutWindows([line(1, 0), line(2, 1)])).toEqual([{ lines: [line(1, 0), line(2, 1)], overlap: 0 }]);
  });

  it("caps a window's bytes and repeats two messages into the next", () => {
    // Three 900-byte lines fit under the cap; a fourth does not.
    const session = [1, 2, 3, 4, 5].map(id => line(id, id, 900));
    const windows = cutWindows(session);
    expect(windows.map(window => ({ ids: window.lines.map(entry => entry.eventId), overlap: window.overlap }))).toEqual([
      { ids: [1, 2, 3], overlap: 0 },
      { ids: [2, 3, 4], overlap: 2 },
      { ids: [3, 4, 5], overlap: 2 },
    ]);
    for (const window of windows) {
      expect(window.lines.reduce((total, entry) => total + entry.bytes + 1, 0)).toBeLessThanOrEqual(WINDOW_MAX_BYTES);
    }
  });

  it("gives a window at least one message of its own when one line fills the cap", () => {
    const windows = cutWindows([line(1, 0, 2000), line(2, 1, 2000), line(3, 2, 2000)]);
    expect(windows.map(window => window.lines.slice(window.overlap).map(entry => entry.eventId))).toEqual([[1], [2], [3]]);
  });
});

const vecIt = it.skipIf(skipWithoutSqliteVec);

describe("conversation window indexing", () => {
  let dir: string;
  let timelineDbPath: string;
  let embeddingsDb: Database;
  let server: ReturnType<typeof Bun.serve>;
  let embeddedInputs: string[];
  let rejectInputs: boolean;
  let config: EmbeddingsConfig;

  const session = Date.UTC(2026, 0, 1, 10, 0);
  const minutes = (count: number) => count * 60_000;
  const conversation = "dm-bob";

  function insertMessage(id: number, at: number | string, sender: string, content: string): void {
    const db = new Database(timelineDbPath);
    try {
      db.prepare(
        `INSERT INTO events (id, source, source_id, source_account, type, timestamp, title, content, people, raw_data, conversation_id)
         VALUES (?, 'discord', ?, 'alex', 'message:dm', ?, 'Bob', ?, ?, '{}', ?)`
      ).run(
        id,
        `m${id}`,
        typeof at === "string" ? at : new Date(at).toISOString(),
        content,
        JSON.stringify([sender]),
        conversation
      );
    } finally {
      db.close();
    }
  }

  // Vectors point along "lighthouse" or "garden", so a query picks a window.
  function vectorFor(text: string): number[] {
    return [text.includes("lighthouse") ? 1 : 0, text.includes("garden") ? 1 : 0, 0.1];
  }

  function target() {
    const modelConfig = resolveEmbeddingProfile(config);
    return {
      embeddingsDb,
      client: createEmbeddingClient(modelConfig),
      contentProfile: ensureContentProfile(embeddingsDb, conversationWindowProfile("discord")),
      modelProfile: ensureModelProfile(embeddingsDb, modelConfig),
    };
  }

  async function indexWindows(now: number, maxWindows?: number): Promise<WindowIndexCounts> {
    const counts: WindowIndexCounts = { windows: 0, embedded: 0, embeddedBytes: 0, reused: 0, removed: 0, errors: 0 };
    const timelineDb = new Database(timelineDbPath, { readonly: true });
    try {
      await Effect.runPromise(
        indexConversationWindows(
          target(),
          timelineDb,
          { source: "discord", batchSize: 64, concurrency: 2, deadline: Number.POSITIVE_INFINITY, now, maxWindows },
          counts
        )
      );
    } finally {
      timelineDb.close();
    }
    return counts;
  }

  function windowDocuments() {
    return embeddingsDb
      .prepare(
        `SELECT d.id, d.rendered_content, d.start_timestamp, d.end_timestamp,
           (SELECT json_group_array(event_id || ':' || role) FROM (
             SELECT event_id, role FROM embedding_document_events WHERE document_id = d.id ORDER BY position
           )) AS members
         FROM embedding_documents d WHERE d.source_kind = 'conversation-window' ORDER BY d.start_timestamp, d.id`
      )
      .all() as { id: number; rendered_content: string; start_timestamp: string; end_timestamp: string; members: string }[];
  }

  /** Everything single-event search reads, which window indexing must never change. */
  function singleEventState(modelProfileId: number, eventProfileId: number) {
    return {
      documents: embeddingsDb.prepare("SELECT * FROM embedding_documents WHERE source_kind != 'conversation-window' ORDER BY id").all(),
      links: embeddingsDb
        .prepare(
          `SELECT ede.* FROM embedding_document_events ede JOIN embedding_documents d ON d.id = ede.document_id
           WHERE d.source_kind != 'conversation-window' ORDER BY ede.document_id, ede.position`
        )
        .all(),
      vectors: embeddingsDb.prepare(`SELECT rowid, embedding FROM ${vecTableName(modelProfileId)} ORDER BY rowid`).all(),
      cursors: embeddingsDb
        .prepare("SELECT model_profile_id, last_event_id FROM embedding_index_cursors WHERE content_profile_id = ?")
        .all(eventProfileId),
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "emb-windows-"));
    timelineDbPath = join(dir, "timeline.db");
    configureBunSqliteForSqliteVec();
    const timelineDb = new Database(timelineDbPath);
    try {
      initDb(timelineDb);
      const contactId = Number(timelineDb.prepare("INSERT INTO contacts (display_name) VALUES ('Bob')").run().lastInsertRowid);
      timelineDb.prepare("INSERT INTO identities (platform, platform_id, contact_id) VALUES ('discord', 'bob', ?)").run(contactId);
    } finally {
      timelineDb.close();
    }
    embeddedInputs = [];
    rejectInputs = false;
    server = Bun.serve({
      port: 0,
      fetch: async request => {
        const body = (await request.json()) as { input: string[] };
        // A per-input rejection, as a provider gives for one bad document.
        if (rejectInputs && body.input.some(text => text.includes("wait which one"))) {
          return new Response("input rejected", { status: 400 });
        }
        embeddedInputs.push(...body.input);
        return Response.json({ data: body.input.map((text, index) => ({ index, embedding: vectorFor(text) })) });
      },
    });
    config = { base_url: `${server.url}v1`, model: "test", dimensions: 3 };
    embeddingsDb = getEmbeddingsDb(join(dir, "embeddings.db"));
    initEmbeddingsDb(embeddingsDb);
  });

  afterEach(() => {
    embeddingsDb.close();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  vecIt("embeds closed sessions only, naming senders as the export does, and maps windows back to events", async () => {
    insertMessage(1, session, "discord:alex", "did you see the lighthouse?");
    insertMessage(2, session + minutes(1), "discord:bob", "yes!");
    insertMessage(3, session + minutes(2), "discord:alex", "amazing");
    // A lone message: its single-event vector covers it.
    insertMessage(4, session + minutes(120), "discord:bob", "hello?");
    insertMessage(5, session + minutes(240), "discord:alex", "the garden is growing");
    insertMessage(6, session + minutes(241), "discord:bob", "nice");

    // The last session ended 10 minutes ago, so it is still open.
    const first = await indexWindows(session + minutes(251));
    expect(first).toMatchObject({ windows: 1, embedded: 1, removed: 0, errors: 0 });
    expect(windowDocuments().map(document => [document.rendered_content, JSON.parse(document.members)])).toEqual([
      [
        "discord conversation: Bob, 2026-01-01 10:00–10:02 UTC\n10:00 <discord:alex> did you see the lighthouse?\n10:01 <Bob> yes!\n10:02 <discord:alex> amazing",
        ["1:primary", "2:primary", "3:primary"],
      ],
    ]);

    // Once it closes, a later run embeds it and leaves the first window alone.
    const second = await indexWindows(session + minutes(300));
    expect(second).toMatchObject({ windows: 1, embedded: 1, reused: 0, removed: 0 });
    expect(windowDocuments().map(document => JSON.parse(document.members))).toEqual([
      ["1:primary", "2:primary", "3:primary"],
      ["5:primary", "6:primary"],
    ]);
    expect(embeddingsDb.prepare("SELECT COUNT(*) AS count FROM conversation_window_pending").get()).toEqual({ count: 0 });
    expect(await indexWindows(session + minutes(400))).toMatchObject({ windows: 0, embedded: 0 });

    // A window hit maps back to the conversation, its span, and its own messages.
    const result = await searchEmbeddingsWithWindows(
      { config, embeddingsDb: async () => wrapDatabase(embeddingsDb) },
      "lighthouse",
      10,
      1
    );
    expect(result.hits).toEqual([]);
    expect(result.windows).toEqual([
      {
        distance: expect.any(Number),
        source: "discord",
        sourceAccount: "alex",
        conversationId: conversation,
        title: "Bob",
        start: "2026-01-01T10:00:00.000Z",
        end: "2026-01-01T10:02:00.000Z",
        eventIds: [1, 2, 3],
        snippet: "<discord:alex> did you see the lighthouse? / <Bob> yes! / <discord:alex> amazing",
      },
    ]);
    const hit = result.windows[0];
    if (!hit) throw new Error("expected a window hit");
    expect(formatWindowHit(hit)).toBe(
      'window discord "Bob" 2026-01-01 10:00–10:02 #1 conversation dm-bob: <discord:alex> did you see the lighthouse? / <Bob> yes! / <discord:alex> amazing'
    );
  });

  vecIt("marks a window's repeated messages as overlap", async () => {
    for (const id of [1, 2, 3, 4]) insertMessage(id, session + minutes(id), "discord:bob", `${id} ${"y".repeat(900)}`);
    await indexWindows(session + minutes(60));
    expect(windowDocuments().map(document => JSON.parse(document.members))).toEqual([
      ["1:primary", "2:primary", "3:primary"],
      ["2:overlap", "3:overlap", "4:primary"],
    ]);
  });

  vecIt("re-windows after a late message, replacing only the windows it changed", async () => {
    // A single-event index built before windows existed.
    const eventProfile = ensureContentProfile(embeddingsDb, EVENT_LEAN_PROFILE);
    const { modelProfile } = target();
    const eventDocument = upsertDocument(embeddingsDb, {
      sourceKind: "event",
      sourceKey: "1",
      title: "Bob",
      snippet: "did you see the lighthouse?",
      startTimestamp: null,
      endTimestamp: null,
      contentProfileId: eventProfile.id,
      contentProfileVersion: eventProfile.version,
      renderedContent: "discord message dm\ndid you see the lighthouse?",
      contentHash: "event-1",
      eventIds: [1],
    });
    insertVector(embeddingsDb, eventDocument.id, modelProfile.id, [1, 0, 0]);
    setIndexCursor(embeddingsDb, eventProfile.id, modelProfile.id, 3);

    insertMessage(1, session, "discord:alex", "did you see the lighthouse?");
    insertMessage(2, session + minutes(2), "discord:bob", "yes!");
    insertMessage(3, session + minutes(120), "discord:alex", "the garden is growing");
    insertMessage(4, session + minutes(121), "discord:bob", "nice");
    await indexWindows(session + minutes(200));
    const before = windowDocuments();
    expect(before.map(document => JSON.parse(document.members))).toEqual([
      ["1:primary", "2:primary"],
      ["3:primary", "4:primary"],
    ]);
    const singleEventsBefore = singleEventState(modelProfile.id, eventProfile.id);
    const inputsBefore = embeddedInputs.length;

    // Backfilled later with a higher id, but sent between the first two messages.
    insertMessage(10, session + minutes(1), "discord:bob", "wait which one");
    const counts = await indexWindows(session + minutes(200));
    expect(counts).toMatchObject({ windows: 1, embedded: 1, removed: 1, errors: 0 });
    // Only the changed window was embedded again.
    expect(embeddedInputs.length - inputsBefore).toBe(1);

    const after = windowDocuments();
    expect(after.map(document => JSON.parse(document.members))).toEqual([
      ["1:primary", "10:primary", "2:primary"],
      ["3:primary", "4:primary"],
    ]);
    expect(after[1]?.id).toBe(before[1]?.id);
    expect(embeddingsDb.prepare(`SELECT COUNT(*) AS count FROM ${vecTableName(modelProfile.id, "window")}`).get()).toEqual({
      count: 2,
    });
    expect(embeddingsDb.prepare("SELECT COUNT(*) AS count FROM conversation_windows").get()).toEqual({ count: 2 });
    expect(singleEventState(modelProfile.id, eventProfile.id)).toEqual(singleEventsBefore);
  });

  vecIt("records a window the provider rejects and skips it on later runs", async () => {
    insertMessage(1, session, "discord:alex", "did you see the lighthouse?");
    insertMessage(2, session + minutes(2), "discord:bob", "yes!");
    await indexWindows(session + minutes(200));

    insertMessage(10, session + minutes(1), "discord:bob", "wait which one");
    rejectInputs = true;
    expect(await indexWindows(session + minutes(200))).toMatchObject({ embedded: 0, removed: 1, errors: 1 });
    expect(embeddingsDb.prepare("SELECT reason FROM embedding_failures").all()).toEqual([
      { reason: expect.stringContaining("input rejected") },
    ]);
    expect(embeddingsDb.prepare("SELECT COUNT(*) AS count FROM conversation_window_pending").get()).toEqual({ count: 0 });

    // A later change to the conversation does not send the rejected window again.
    rejectInputs = false;
    const inputsBefore = embeddedInputs.length;
    insertMessage(11, session + minutes(300), "discord:alex", "the garden is growing");
    insertMessage(12, session + minutes(301), "discord:bob", "nice");
    expect(await indexWindows(session + minutes(400))).toMatchObject({ embedded: 1, errors: 0 });
    expect(embeddedInputs.slice(inputsBefore).some(text => text.includes("wait which one"))).toBe(false);
  });

  vecIt("refuses a second window run on the same embeddings.db and changes nothing", async () => {
    insertMessage(1, session, "discord:alex", "did you see the lighthouse?");
    insertMessage(2, session + minutes(2), "discord:bob", "yes!");
    // Another run holds the lock, as the service does while the CLI starts.
    const other = new Database(`${join(dir, "embeddings.db")}.windows-lock`);
    try {
      other.exec("BEGIN IMMEDIATE");
      await expect(indexWindows(session + minutes(200))).rejects.toThrow("Another conversation-window run");
      expect(embeddingsDb.prepare("SELECT COUNT(*) AS count FROM conversation_window_pending").get()).toEqual({ count: 0 });
      expect(windowDocuments()).toEqual([]);
    } finally {
      other.close();
    }
    // Once it finishes, a run goes ahead.
    expect(await indexWindows(session + minutes(200))).toMatchObject({ windows: 1, embedded: 1 });
  });

  vecIt("orders messages by instant when a source keeps its UTC offset", async () => {
    insertMessage(1, "2026-01-01T10:00:00Z", "discord:alex", "first");
    // 10:05 UTC, though it sorts before 10:00Z as text.
    insertMessage(2, "2026-01-01T09:05:00-01:00", "discord:bob", "second");
    await indexWindows(session + minutes(200));
    expect(windowDocuments().map(document => JSON.parse(document.members))).toEqual([["1:primary", "2:primary"]]);
  });

  vecIt("stops at the requested number of windows", async () => {
    for (const id of [1, 2, 3, 4, 5, 6]) insertMessage(id, session + minutes(id * 60), "discord:bob", `${id} ${"y".repeat(10)}`);
    for (const id of [11, 12, 13, 14, 15, 16]) insertMessage(id, session + minutes(id * 60 - 600 + 1), "discord:alex", "ok");
    expect(await indexWindows(session + minutes(1000), 1)).toMatchObject({ windows: 1, embedded: 1 });
  });
});
