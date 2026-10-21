import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { OpenAIEmbeddingClient } from "./client";
import { contentHash, EVENT_LEAN_PROFILE, MAX_RENDERED_BYTES, renderEventLean } from "./content";
import { buildCorpusWhere, EVENT_CORPUS_POLICY, type CorpusFilterTerm } from "./corpus";
import {
  ensureContentProfile,
  ensureModelProfile,
  getEmbeddingsDb,
  getModelProfile,
  hasVector,
  initEmbeddingsDb,
  insertVector,
  searchVectors,
  upsertDocument,
} from "./db";
import { MAX_BATCH_BYTES } from "./indexer";
import { configureBunSqliteForSqliteVec, loadSqliteVec } from "./sqlite-vec";

function event(overrides = {}) {
  return {
    id: 101,
    source: "test",
    type: "message",
    timestamp: "2026-01-01T00:00:00Z",
    end_timestamp: null,
    title: "Alice update",
    content: "Alice met Bob at Example Cafe",
    location_name: null,
    ...overrides,
  };
}

interface SeedEvent {
  id: number;
  source: string;
  type: string;
  timestamp: string;
  title: string;
  content: string;
}

describe("lean event rendering", () => {
  it("verbalizes source and type without repeating source words", () => {
    const cases = [
      ["discord", "message:guild", "discord message guild"],
      ["trakt", "trakt:movie", "trakt movie"],
      ["google-search", "search", "google search"],
      ["youtube", "youtube:watch", "youtube watch"],
      ["facebook", "reaction:like", "facebook reaction like"],
      ["google-fit", "activity:walking", "google fit activity walking"],
    ];

    for (const [source, type, expected] of cases) {
      expect(renderEventLean(event({ source, type, content: "body", title: null }))).toBe(`${expected}\nbody`);
    }
  });

  it("collapses a title duplicated or prefixed by content", () => {
    expect(renderEventLean(event({ title: "  Project update ", content: "Project update" }))).toBe(
      "test message\nProject update"
    );
    expect(renderEventLean(event({ title: "  Project update  ", content: "Project update with details" }))).toBe(
      "test message\nProject update with details"
    );
    expect(
      renderEventLean(event({ title: "Different title", content: "Body", location_name: "Example Cafe" }))
    ).toBe("test message\nDifferent title\nBody\nExample Cafe");
  });

  it("shortens only the content of an oversized event to fit the byte budget", () => {
    const content = `${"word ".repeat(1000)}${"é".repeat(5000)}`;
    const rendered = renderEventLean(event({ title: "Long title", content, location_name: "Example Cafe" }));

    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(MAX_RENDERED_BYTES);
    expect(Buffer.byteLength(rendered)).toBeGreaterThan(MAX_RENDERED_BYTES - 2);
    expect(rendered.startsWith(`test message\nLong title\n${"word ".repeat(1000)}é`)).toBe(true);
    expect(rendered.endsWith("é\nExample Cafe")).toBe(true);
    expect(rendered).not.toContain("�");
  });

  it("leaves an event at the byte budget unchanged", () => {
    const content = "x".repeat(MAX_RENDERED_BYTES - "test message\n".length);
    expect(renderEventLean(event({ title: null, content }))).toBe(`test message\n${content}`);
  });
});

describe("embedding corpus policy", () => {
  it("compiles SQL that limits the corpus, excludes votes, and requires content", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, source TEXT, type TEXT, content TEXT)");
      const insert = db.prepare("INSERT INTO events (id, source, type, content) VALUES (?, ?, ?, ?)");
      insert.run(1, "manual", "note", "Retained");
      insert.run(2, "spotify", "listen:track", "Not allowlisted");
      insert.run(3, "reddit", "vote:up", "Excluded vote");
      insert.run(4, "reddit", "comment", "Retained comment");
      insert.run(5, "discord", "message", "   ");
      insert.run(6, "discord", "message", "\n\n");
      insert.run(7, "discord", "message", "\t\t");

      const where = buildCorpusWhere({ include: [], exclude: [] });
      expect(db.prepare(`SELECT id FROM events WHERE ${where.clause} ORDER BY id`).all(...where.params)).toEqual([
        { id: 1 },
        { id: 4 },
      ]);
    } finally {
      db.close();
    }
  });

  it("compiles valid SQL when the policy denylist is empty", () => {
    const excluded = EVENT_CORPUS_POLICY.excluded as unknown as CorpusFilterTerm[];
    const originalExcluded = [...excluded];
    excluded.length = 0;

    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, source TEXT, type TEXT, content TEXT)");
      db.prepare("INSERT INTO events (id, source, type, content) VALUES (?, ?, ?, ?)").run(
        1,
        "manual",
        "note",
        "Retained"
      );

      const where = buildCorpusWhere({ include: [], exclude: [] });
      expect(db.prepare(`SELECT id FROM events WHERE ${where.clause}`).all(...where.params)).toEqual([{ id: 1 }]);
    } finally {
      excluded.push(...originalExcluded);
      db.close();
    }
  });
});

function sqliteVecAvailable(): boolean {
  configureBunSqliteForSqliteVec();
  const probe = new Database(":memory:");
  try {
    initEmbeddingsDb(probe);
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

const sqliteVecIt = sqliteVecAvailable() ? it : it.skip;

/** Write a config.toml pointing [embeddings] at a test server; returns its path. */
function writeEmbeddingsConfig(dir: string, baseUrl: string, extra = ""): string {
  const path = join(dir, "config.toml");
  writeFileSync(path, `[embeddings]\nbase_url = "${baseUrl}"\nmodel = "fake"\ndimensions = 3\n${extra}\n`);
  return path;
}

describe("embeddings sqlite-vec foundation", () => {
  let db: Database;

  beforeEach(() => {
    configureBunSqliteForSqliteVec();
    db = new Database(":memory:");
    initEmbeddingsDb(db);
  });

  afterEach(() => db.close());

  sqliteVecIt("loads sqlite-vec, inserts vectors, and returns nearest neighbors linked to events", () => {
    const profile = ensureContentProfile(db, EVENT_LEAN_PROFILE);
    const model = ensureModelProfile(db, {
      name: "local-test",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "test-model",
      dimensions: 3,
      api_key_env: null,
      document_prefix: "",
    });
    const first = upsertDocument(db, {
      sourceKind: "event",
      sourceKey: "101",
      title: "first",
      snippet: "first",
      startTimestamp: null,
      endTimestamp: null,
      contentProfileId: profile.id,
      contentProfileVersion: profile.version,
      renderedContent: "first",
      contentHash: contentHash("first"),
      eventIds: [101],
    });
    const second = upsertDocument(db, {
      sourceKind: "event",
      sourceKey: "102",
      title: "second",
      snippet: "second",
      startTimestamp: null,
      endTimestamp: null,
      contentProfileId: profile.id,
      contentProfileVersion: profile.version,
      renderedContent: "second",
      contentHash: contentHash("second"),
      eventIds: [102],
    });

    insertVector(db, first.id, model.id, [1, 0, 0]);
    insertVector(db, second.id, model.id, [0, 1, 0]);

    expect(searchVectors(db, [0.9, 0.1, 0], model.id, 1)).toEqual([
      { document_id: first.id, event_id: 101, distance: expect.any(Number) },
    ]);
  });

  sqliteVecIt("searches only vectors for the requested model profile", () => {
    const profile = ensureContentProfile(db, EVENT_LEAN_PROFILE);
    const modelA = ensureModelProfile(db, {
      name: "model-a",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "a",
      dimensions: 3,
      api_key_env: null,
      document_prefix: "",
    });
    const modelB = ensureModelProfile(db, {
      name: "model-b",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "b",
      dimensions: 3,
      api_key_env: null,
      document_prefix: "",
    });
    const first = upsertDocument(db, {
      sourceKind: "event",
      sourceKey: "101",
      title: "first",
      snippet: "first",
      startTimestamp: null,
      endTimestamp: null,
      contentProfileId: profile.id,
      contentProfileVersion: profile.version,
      renderedContent: "first",
      contentHash: contentHash("first"),
      eventIds: [101],
    });
    const second = upsertDocument(db, {
      sourceKind: "event",
      sourceKey: "102",
      title: "second",
      snippet: "second",
      startTimestamp: null,
      endTimestamp: null,
      contentProfileId: profile.id,
      contentProfileVersion: profile.version,
      renderedContent: "second",
      contentHash: contentHash("second"),
      eventIds: [102],
    });

    insertVector(db, first.id, modelA.id, [0, 1, 0]);
    insertVector(db, second.id, modelB.id, [1, 0, 0]);

    expect(searchVectors(db, [1, 0, 0], modelA.id, 1)).toEqual([
      { document_id: first.id, event_id: 101, distance: expect.any(Number) },
    ]);
    expect(searchVectors(db, [1, 0, 0], modelB.id, 1)).toEqual([
      { document_id: second.id, event_id: 102, distance: expect.any(Number) },
    ]);
  });

  sqliteVecIt("rejects vector dimension mismatch explicitly", () => {
    const profile = ensureContentProfile(db, EVENT_LEAN_PROFILE);
    const model = ensureModelProfile(db, {
      name: "local-test",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "test-model",
      dimensions: 3,
      api_key_env: null,
      document_prefix: "",
    });
    const document = upsertDocument(db, {
      sourceKind: "event",
      sourceKey: "101",
      title: null,
      snippet: null,
      startTimestamp: null,
      endTimestamp: null,
      contentProfileId: profile.id,
      contentProfileVersion: profile.version,
      renderedContent: "content",
      contentHash: contentHash("content"),
      eventIds: [101],
    });

    expect(() => insertVector(db, document.id, model.id, [1, 2])).toThrow();
    expect(hasVector(db, document.id, model.id)).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS count FROM embedding_vectors").get() as { count: number }).count).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM vec_model_${model.id}`).get() as { count: number }).count).toBe(0);

    insertVector(db, document.id, model.id, [1, 2, 3]);
    expect(hasVector(db, document.id, model.id)).toBe(true);
  });

  sqliteVecIt("indexes models of different dimensions side by side in one database", () => {
    const profile = ensureContentProfile(db, EVENT_LEAN_PROFILE);
    const small = ensureModelProfile(db, {
      name: "small",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "small-model",
      dimensions: 3,
      api_key_env: null,
      document_prefix: "",
    });
    const large = ensureModelProfile(db, {
      name: "large",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "large-model",
      dimensions: 5,
      api_key_env: null,
      document_prefix: "",
    });
    const document = upsertDocument(db, {
      sourceKind: "event",
      sourceKey: "101",
      title: null,
      snippet: null,
      startTimestamp: null,
      endTimestamp: null,
      contentProfileId: profile.id,
      contentProfileVersion: profile.version,
      renderedContent: "content",
      contentHash: contentHash("content"),
      eventIds: [101],
    });

    insertVector(db, document.id, small.id, [1, 0, 0]);
    insertVector(db, document.id, large.id, [0, 0, 0, 1, 0]);

    expect(searchVectors(db, [1, 0, 0], small.id, 1)).toEqual([
      { document_id: document.id, event_id: 101, distance: expect.any(Number) },
    ]);
    expect(searchVectors(db, [0, 0, 0, 1, 0], large.id, 1)).toEqual([
      { document_id: document.id, event_id: 101, distance: expect.any(Number) },
    ]);
    // Each model's vectors live in their own width-specific table.
    expect((db.prepare(`SELECT COUNT(*) AS count FROM vec_model_${small.id}`).get() as { count: number }).count).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM vec_model_${large.id}`).get() as { count: number }).count).toBe(1);
  });

  sqliteVecIt("refuses to rebind an existing profile name to a different dimension", () => {
    ensureModelProfile(db, {
      name: "local",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "model-a",
      dimensions: 3,
      api_key_env: null,
      document_prefix: "",
    });

    expect(() =>
      ensureModelProfile(db, {
        name: "local",
        provider: "openai-compatible",
        endpoint: "http://127.0.0.1:1234/v1/embeddings",
        model: "model-a",
        dimensions: 4,
        api_key_env: null,
        document_prefix: "",
      })
    ).toThrow(/already bound to 3 dimensions/);

    expect(db.prepare("SELECT dimensions FROM embedding_model_profiles WHERE name = 'local'").all()).toEqual([
      { dimensions: 3 },
    ]);
  });

  sqliteVecIt("rejects search vectors that do not match the model dimensions", () => {
    const profile = ensureContentProfile(db, EVENT_LEAN_PROFILE);
    const model = ensureModelProfile(db, {
      name: "local-test",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "test-model",
      dimensions: 3,
      api_key_env: null,
      document_prefix: "",
    });
    const document = upsertDocument(db, {
      sourceKind: "event",
      sourceKey: "101",
      title: null,
      snippet: null,
      startTimestamp: null,
      endTimestamp: null,
      contentProfileId: profile.id,
      contentProfileVersion: profile.version,
      renderedContent: "content",
      contentHash: contentHash("content"),
      eventIds: [101],
    });
    insertVector(db, document.id, model.id, [1, 2, 3]);

    expect(() => searchVectors(db, [1, 2], model.id, 1)).toThrow(
      /Vector has 2 dimensions, but model profile \d+ expects 3/
    );
  });

  sqliteVecIt("does not skip retries when stale vector metadata exists without a vec row", () => {
    const profile = ensureContentProfile(db, EVENT_LEAN_PROFILE);
    const model = ensureModelProfile(db, {
      name: "local-test",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "test-model",
      dimensions: 3,
      api_key_env: null,
      document_prefix: "",
    });
    const document = upsertDocument(db, {
      sourceKind: "event",
      sourceKey: "101",
      title: null,
      snippet: null,
      startTimestamp: null,
      endTimestamp: null,
      contentProfileId: profile.id,
      contentProfileVersion: profile.version,
      renderedContent: "content",
      contentHash: contentHash("content"),
      eventIds: [101],
    });

    db.prepare("INSERT INTO embedding_vectors (document_id, model_profile_id) VALUES (?, ?)").run(document.id, model.id);

    expect(hasVector(db, document.id, model.id)).toBe(false);

    insertVector(db, document.id, model.id, [1, 2, 3]);

    expect(hasVector(db, document.id, model.id)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS count FROM embedding_vectors").get() as { count: number }).count).toBe(1);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM vec_model_${model.id}`).get() as { count: number }).count).toBe(1);
  });

  sqliteVecIt("reuses unchanged rendered content and separates formatter versions", () => {
    const v1 = ensureContentProfile(db, EVENT_LEAN_PROFILE);
    const rendered = renderEventLean(event());
    const first = upsertDocument(db, {
      sourceKind: "event",
      sourceKey: "101",
      title: "Alice update",
      snippet: "Alice met Bob at Example Cafe",
      startTimestamp: "2026-01-01T00:00:00Z",
      endTimestamp: null,
      contentProfileId: v1.id,
      contentProfileVersion: v1.version,
      renderedContent: rendered,
      contentHash: contentHash(rendered),
      eventIds: [101],
    });
    const reused = upsertDocument(db, {
      sourceKind: "event",
      sourceKey: "101",
      title: "Alice update",
      snippet: "Alice met Bob at Example Cafe",
      startTimestamp: "2026-01-01T00:00:00Z",
      endTimestamp: null,
      contentProfileId: v1.id,
      contentProfileVersion: v1.version,
      renderedContent: rendered,
      contentHash: contentHash(rendered),
      eventIds: [101],
    });
    const v2 = ensureContentProfile(db, { name: "event-lean", formatter: "event-lean", version: 2 });
    const changedProfile = upsertDocument(db, {
      sourceKind: "event",
      sourceKey: "101",
      title: "Alice update",
      snippet: "Alice met Bob at Example Cafe",
      startTimestamp: "2026-01-01T00:00:00Z",
      endTimestamp: null,
      contentProfileId: v2.id,
      contentProfileVersion: v2.version,
      renderedContent: rendered,
      contentHash: contentHash(rendered),
      eventIds: [101],
    });

    expect(first.created).toBe(true);
    expect(reused).toEqual({ id: first.id, created: false });
    expect(changedProfile.created).toBe(true);
    expect(changedProfile.id).not.toBe(first.id);
  });

  sqliteVecIt("links additional source events when reusing an unchanged document", () => {
    const profile = ensureContentProfile(db, EVENT_LEAN_PROFILE);
    const model = ensureModelProfile(db, {
      name: "local-test",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "test-model",
      dimensions: 3,
      api_key_env: null,
      document_prefix: "",
    });
    const rendered = "shared content";
    const first = upsertDocument(db, {
      sourceKind: "event",
      sourceKey: "101",
      title: "first",
      snippet: rendered,
      startTimestamp: null,
      endTimestamp: null,
      contentProfileId: profile.id,
      contentProfileVersion: profile.version,
      renderedContent: rendered,
      contentHash: contentHash(rendered),
      eventIds: [101],
    });
    const reused = upsertDocument(db, {
      sourceKind: "event",
      sourceKey: "102",
      title: "second",
      snippet: rendered,
      startTimestamp: null,
      endTimestamp: null,
      contentProfileId: profile.id,
      contentProfileVersion: profile.version,
      renderedContent: rendered,
      contentHash: contentHash(rendered),
      eventIds: [102],
    });

    insertVector(db, first.id, model.id, [1, 0, 0]);

    expect(reused).toEqual({ id: first.id, created: false });
    expect(
      db
        .prepare("SELECT event_id, position, role FROM embedding_document_events WHERE document_id = ? ORDER BY event_id")
        .all(first.id)
    ).toEqual([
      { event_id: 101, position: 0, role: "primary" },
      { event_id: 102, position: 0, role: "primary" },
    ]);
    expect(searchVectors(db, [1, 0, 0], model.id, 1)).toEqual([
      { document_id: first.id, event_id: 101, distance: expect.any(Number) },
      { document_id: first.id, event_id: 102, distance: expect.any(Number) },
    ]);
  });

  sqliteVecIt("refuses to repoint an existing profile name at a different model", () => {
    ensureModelProfile(db, {
      name: "local",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "model-a",
      dimensions: 3,
      api_key_env: null,
      document_prefix: "",
    });

    expect(() =>
      ensureModelProfile(db, {
        name: "local",
        provider: "openai-compatible",
        endpoint: "http://127.0.0.1:1234/v1/embeddings",
        model: "model-b",
        dimensions: 3,
        api_key_env: null,
        document_prefix: "",
      })
    ).toThrow(/already bound to model "model-a"/);

    expect(db.prepare("SELECT model FROM embedding_model_profiles WHERE name = 'local'").all()).toEqual([
      { model: "model-a" },
    ]);
  });

  sqliteVecIt("refuses to switch an existing profile to a different document prefix", () => {
    const profile = {
      name: "local",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "model-a",
      dimensions: 3,
      api_key_env: null,
      document_prefix: "",
    };
    ensureModelProfile(db, profile);

    expect(() => ensureModelProfile(db, { ...profile, document_prefix: "title: none | text: " })).toThrow(
      /indexed with document prefix ""/
    );
    expect(getModelProfile(db, "local")?.document_prefix).toBe("");
  });

  sqliteVecIt("adds an empty document prefix to profiles created before the column existed", () => {
    const legacy = new Database(":memory:");
    try {
      legacy.exec(`
        CREATE TABLE embedding_model_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          model TEXT NOT NULL,
          dimensions INTEGER NOT NULL CHECK (dimensions > 0),
          api_key_env TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO embedding_model_profiles (name, provider, endpoint, model, dimensions)
        VALUES ('old', 'openai-compatible', 'http://127.0.0.1:1234/v1/embeddings', 'model-a', 3);
      `);
      // A read-only search can't migrate, so it reads the pre-column profile as unprefixed.
      expect(getModelProfile(legacy, "old")?.document_prefix).toBe("");

      initEmbeddingsDb(legacy);
      expect(legacy.prepare("SELECT document_prefix FROM embedding_model_profiles WHERE name = 'old'").get()).toEqual({
        document_prefix: "",
      });
    } finally {
      legacy.close();
    }
  });

  sqliteVecIt("refreshes operational fields without re-minting a profile for the same model", () => {
    const first = ensureModelProfile(db, {
      name: "local",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "model-a",
      dimensions: 3,
      api_key_env: null,
      document_prefix: "",
    });
    const refreshed = ensureModelProfile(db, {
      name: "local",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:9999/v1/embeddings",
      model: "model-a",
      dimensions: 3,
      api_key_env: "SOME_KEY",
      document_prefix: "",
    });

    expect(refreshed.id).toBe(first.id);
    expect(refreshed.endpoint).toBe("http://127.0.0.1:9999/v1/embeddings");
    expect(refreshed.api_key_env).toBe("SOME_KEY");
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM embedding_model_profiles").get() as { count: number }).count
    ).toBe(1);
  });

  sqliteVecIt("adds vectors for a new model without duplicating documents", () => {
    const profile = ensureContentProfile(db, EVENT_LEAN_PROFILE);
    const document = upsertDocument(db, {
      sourceKind: "event",
      sourceKey: "101",
      title: null,
      snippet: null,
      startTimestamp: null,
      endTimestamp: null,
      contentProfileId: profile.id,
      contentProfileVersion: profile.version,
      renderedContent: "content",
      contentHash: contentHash("content"),
      eventIds: [101],
    });
    const modelA = ensureModelProfile(db, {
      name: "model-a",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "a",
      dimensions: 3,
      api_key_env: null,
      document_prefix: "",
    });
    const modelB = ensureModelProfile(db, {
      name: "model-b",
      provider: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1/embeddings",
      model: "b",
      dimensions: 3,
      api_key_env: null,
      document_prefix: "",
    });

    insertVector(db, document.id, modelA.id, [1, 0, 0]);
    insertVector(db, document.id, modelB.id, [0, 1, 0]);

    expect((db.prepare("SELECT COUNT(*) AS count FROM embedding_documents").get() as { count: number }).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM embedding_vectors").get() as { count: number }).count).toBe(2);
  });
});

describe("sqlite-vec availability", () => {
  it("fails explicitly when sqlite-vec cannot be loaded", () => {
    configureBunSqliteForSqliteVec();
    const probe = new Database(":memory:");
    try {
      if (sqliteVecAvailable()) {
        expect(() => initEmbeddingsDb(probe)).not.toThrow();
      } else {
        expect(() => initEmbeddingsDb(probe)).toThrow(/sqlite-vec is unavailable/);
      }
    } finally {
      probe.close();
    }
  });

  it("opens embeddings databases with configured custom SQLite before loading sqlite-vec", () => {
    const path = process.env.TIMELINE_SQLITE_LIBRARY_PATH;
    if (!path) return;

    const db = getEmbeddingsDb(":memory:");
    try {
      initEmbeddingsDb(db);
      expect((db.prepare("SELECT vec_version() AS version").get() as { version: string }).version).toMatch(/^v/);
    } finally {
      db.close();
    }
  });

  it("loads sqlite-vec in a worker thread after the main thread chose the SQLite library", async () => {
    if (!process.env.TIMELINE_SQLITE_LIBRARY_PATH) return;
    const dir = mkdtempSync(join(tmpdir(), "emb-worker-"));
    try {
      const dbModule = join(process.cwd(), "src/embeddings/db.ts");
      const workerPath = join(dir, "worker.ts");
      writeFileSync(
        workerPath,
        `import { getEmbeddingsDb, initEmbeddingsDb } from ${JSON.stringify(dbModule)};
const db = getEmbeddingsDb(":memory:");
initEmbeddingsDb(db);
postMessage((db.prepare("SELECT vec_version() AS version").get() as { version: string }).version);`
      );
      const mainPath = join(dir, "main.ts");
      writeFileSync(
        mainPath,
        `import { getEmbeddingsDb } from ${JSON.stringify(dbModule)};
getEmbeddingsDb(":memory:").close();
const worker = new Worker(${JSON.stringify(workerPath)});
worker.onmessage = event => { console.log(event.data); worker.terminate(); };
worker.onerror = event => { console.error(event.message); process.exit(1); };`
      );
      const proc = Bun.spawn(["bun", mainPath], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      expect(await new Response(proc.stderr).text()).toBe("");
      expect(proc.exitCode).toBe(0);
      expect(await new Response(proc.stdout).text()).toMatch(/^v/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs vector queries on a DbPool worker opened for vector search", async () => {
    if (!process.env.TIMELINE_SQLITE_LIBRARY_PATH) return;
    const dir = mkdtempSync(join(tmpdir(), "emb-pool-"));
    try {
      const dbModule = join(process.cwd(), "src/embeddings/db.ts");
      const poolModule = join(process.cwd(), "src/db/pool.ts");
      const mainPath = join(dir, "main.ts");
      writeFileSync(
        mainPath,
        `import { getEmbeddingsDb, initEmbeddingsDb } from ${JSON.stringify(dbModule)};
import { DbPool } from ${JSON.stringify(poolModule)};
const path = ${JSON.stringify(join(dir, "embeddings.db"))};
const db = getEmbeddingsDb(path);
initEmbeddingsDb(db);
db.close();
const vectorPool = await DbPool.create(path, { workers: 1, vectorSearch: true });
const plainPool = await DbPool.create(path, { workers: 1 });
const version = await vectorPool.get("SELECT vec_version() AS version");
const mmap = await vectorPool.get("PRAGMA mmap_size");
const plain = await plainPool.get("SELECT vec_version() AS version").then(() => "loaded", error => error.message);
await vectorPool.closeAndWait();
await plainPool.closeAndWait();
console.log(JSON.stringify({ version, mmap, plain }));`
      );
      const proc = Bun.spawn(["bun", mainPath], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      expect(await new Response(proc.stderr).text()).toBe("");
      expect(proc.exitCode).toBe(0);
      const result = JSON.parse(await new Response(proc.stdout).text());
      expect(result.version.version).toMatch(/^v/);
      expect(result.mmap.mmap_size).toBeGreaterThan(0);
      // An ordinary read pool does not load sqlite-vec.
      expect(result.plain).toContain("no such function: vec_version");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails fast when the configured custom SQLite library cannot load", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `import { getEmbeddingsDb } from "./src/embeddings/db.ts"; getEmbeddingsDb(":memory:");`,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TIMELINE_SQLITE_LIBRARY_PATH: "/not/a/sqlite/library.dylib",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(proc.exitCode).not.toBe(0);
    expect(stderr).toContain("Failed to load TIMELINE_SQLITE_LIBRARY_PATH for sqlite-vec");
  });
});

describe("OpenAI-compatible embedding client", () => {
  it("fails fast for missing config and missing configured API key", () => {
    expect(() => new OpenAIEmbeddingClient({ provider: "", endpoint: "x", model: "m", dimensions: 3, documentPrefix: "", queryPrefix: "", timeoutMs: 5000 })).toThrow(
      /provider/
    );
    expect(
      () =>
        new OpenAIEmbeddingClient(
          {
            provider: "openai-compatible",
            endpoint: "http://example.com",
            model: "m",
            dimensions: 3,
            apiKeyEnv: "MISSING",
            documentPrefix: "",
            queryPrefix: "",
            timeoutMs: 5000,
          },
          {}
        )
    ).toThrow(/MISSING/);
  });

  it("sends multiple inputs in one request and restores vectors by response index", async () => {
    let requestBody: unknown;
    const server = Bun.serve({
      port: 0,
      fetch: async request => {
        requestBody = await request.json();
        return Response.json({
          data: [
            { index: 1, embedding: [0, 1, 0] },
            { index: 0, embedding: [1, 0, 0] },
          ],
        });
      },
    });
    try {
      const client = new OpenAIEmbeddingClient({
        provider: "openai-compatible",
        endpoint: `${server.url}v1/embeddings`,
        model: "test",
        dimensions: 3,
        documentPrefix: "",
        queryPrefix: "",
        timeoutMs: 5000,
      });
      const vectors = await Effect.runPromise(client.embedDocuments(["first", "second"]));
      expect(requestBody).toEqual({ model: "test", input: ["first", "second"] });
      expect(vectors).toEqual([
        [1, 0, 0],
        [0, 1, 0],
      ]);
    } finally {
      server.stop(true);
    }
  });

  it("prepends the document prefix to documents and the query prefix to queries", async () => {
    const inputs: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async request => {
        const body = (await request.json()) as { input: string[] };
        inputs.push(body.input);
        return Response.json({ data: body.input.map((_input, index) => ({ index, embedding: [1, 0, 0] })) });
      },
    });
    try {
      const client = new OpenAIEmbeddingClient({
        provider: "openai-compatible",
        endpoint: `${server.url}v1/embeddings`,
        model: "test",
        dimensions: 3,
        documentPrefix: "doc: ",
        queryPrefix: "query: ",
        timeoutMs: 5000,
      });
      await Effect.runPromise(client.embedDocuments(["first", "second"]));
      await Effect.runPromise(client.embedQuery("cats"));
      expect(inputs).toEqual([["doc: first", "doc: second"], ["query: cats"]]);
    } finally {
      server.stop(true);
    }
  });

  it("fails per-event when a batched response has the wrong number of vectors", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
    });
    try {
      const client = new OpenAIEmbeddingClient({
        provider: "openai-compatible",
        endpoint: `${server.url}v1/embeddings`,
        model: "test",
        dimensions: 3,
        documentPrefix: "",
        queryPrefix: "",
        timeoutMs: 5000,
      });
      const error = await Effect.runPromise(Effect.flip(client.embedDocuments(["first", "second"])));
      expect(error._tag).toBe("EventEmbeddingError");
      expect(error.message).toMatch(/count mismatch/);
    } finally {
      server.stop(true);
    }
  });

  it("makes unauthenticated requests and fails fatally on a dimension mismatch", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async request => {
        expect(request.headers.get("authorization")).toBeNull();
        return Response.json({ data: [{ embedding: [1, 2] }] });
      },
    });
    try {
      const client = new OpenAIEmbeddingClient({
        provider: "openai-compatible",
        endpoint: `${server.url}v1/embeddings`,
        model: "test",
        dimensions: 3,
        documentPrefix: "",
        queryPrefix: "",
        timeoutMs: 5000,
      });
      const error = await Effect.runPromise(Effect.flip(client.embedQuery("hello")));
      expect(error._tag).toBe("FatalEmbeddingError");
      expect(error.message).toMatch(/dimension mismatch/);
    } finally {
      server.stop(true);
    }
  });

  it("fails per-event when the provider rejects one input with a 4xx", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("input too long", { status: 400 }) });
    try {
      const client = new OpenAIEmbeddingClient({
        provider: "openai-compatible",
        endpoint: `${server.url}v1/embeddings`,
        model: "test",
        dimensions: 3,
        documentPrefix: "",
        queryPrefix: "",
        timeoutMs: 5000,
      });
      const error = await Effect.runPromise(Effect.flip(client.embedQuery("hello")));
      expect(error._tag).toBe("EventEmbeddingError");
      expect(error.message).toMatch(/HTTP 400/);
    } finally {
      server.stop(true);
    }
  });

  it("fails fatally and aborts the request when the provider never answers", async () => {
    let aborted: Promise<void> | undefined;
    const server = Bun.serve({
      port: 0,
      fetch: request => {
        aborted = new Promise(resolve => request.signal.addEventListener("abort", () => resolve()));
        return new Promise<Response>(() => {});
      },
    });
    try {
      const client = new OpenAIEmbeddingClient({
        provider: "openai-compatible",
        endpoint: `${server.url}v1/embeddings`,
        model: "test",
        dimensions: 3,
        documentPrefix: "",
        queryPrefix: "",
        timeoutMs: 100,
      });
      const error = await Effect.runPromise(Effect.flip(client.embedDocuments(["hello"])));
      expect(error._tag).toBe("FatalEmbeddingError");
      expect(error.message).toMatch(/timed out after 0.1s/);
      await aborted;
    } finally {
      server.stop(true);
    }
  });

  it("fails fatally when the provider returns a 5xx", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("upstream down", { status: 503 }) });
    try {
      const client = new OpenAIEmbeddingClient({
        provider: "openai-compatible",
        endpoint: `${server.url}v1/embeddings`,
        model: "test",
        dimensions: 3,
        documentPrefix: "",
        queryPrefix: "",
        timeoutMs: 5000,
      });
      const error = await Effect.runPromise(Effect.flip(client.embedQuery("hello")));
      expect(error._tag).toBe("FatalEmbeddingError");
      expect(error.message).toMatch(/HTTP 503/);
    } finally {
      server.stop(true);
    }
  });

  it("keeps HTTP errors typed when the error body cannot be read", async () => {
    const originalFetch = globalThis.fetch;
    const response = Object.assign(new Response("", { status: 503 }), {
      text: () => Promise.reject(new Error("body stream dropped")),
    });
    globalThis.fetch = (() => Promise.resolve(response)) as unknown as typeof fetch;
    try {
      const client = new OpenAIEmbeddingClient({
        provider: "openai-compatible",
        endpoint: "http://example.com/v1/embeddings",
        model: "test",
        dimensions: 3,
        documentPrefix: "",
        queryPrefix: "",
        timeoutMs: 5000,
      });
      const error = await Effect.runPromise(Effect.flip(client.embedQuery("hello")));
      expect(error._tag).toBe("FatalEmbeddingError");
      expect(error.message).toMatch(/HTTP 503/);
      expect(error.message).toMatch(/could not read response body/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("treats a 429 as fatal and surfaces Retry-After (throttling is provider-wide)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }),
    });
    try {
      const client = new OpenAIEmbeddingClient({
        provider: "openai-compatible",
        endpoint: `${server.url}v1/embeddings`,
        model: "test",
        dimensions: 3,
        documentPrefix: "",
        queryPrefix: "",
        timeoutMs: 5000,
      });
      const error = await Effect.runPromise(Effect.flip(client.embedQuery("hello")));
      expect(error._tag).toBe("FatalEmbeddingError");
      expect(error.message).toMatch(/HTTP 429/);
      expect(error.message).toMatch(/retry-after: 30/);
    } finally {
      server.stop(true);
    }
  });
});

describe("embeddings index CLI exit contract", () => {
  const cliIt = sqliteVecAvailable() ? it.concurrent : it.skip;

  function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        value => {
          clearTimeout(timeout);
          resolve(value);
        },
        error => {
          clearTimeout(timeout);
          reject(error);
        }
      );
    });
  }

  async function readEmbeddingInputs(request: Request): Promise<string[]> {
    const body = (await request.json()) as { input?: unknown };
    if (!Array.isArray(body.input)) throw new Error("expected embedding input array");
    return body.input.map(value => {
      if (typeof value !== "string") throw new Error("expected embedding input string");
      return value;
    });
  }

  function seedTimeline(
    eventsOrCount: SeedEvent[] | number = 1,
    timestamps?: string[]
  ): {
    dir: string;
    timelineDbPath: string;
    embeddingsDbPath: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "emb-cli-"));
    const timelineDbPath = join(dir, "timeline.db");
    const embeddingsDbPath = join(dir, "embeddings.db");
    configureBunSqliteForSqliteVec();
    const seed = new Database(timelineDbPath);
    seed.exec(
      "CREATE TABLE events (id INTEGER PRIMARY KEY, source TEXT, type TEXT, timestamp TEXT, end_timestamp TEXT, title TEXT, content TEXT, location_name TEXT)"
    );
    const insert = seed.prepare(
      "INSERT INTO events (id, source, type, timestamp, title, content) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const events =
      typeof eventsOrCount === "number"
        ? Array.from({ length: eventsOrCount }, (_, index) => {
            const id = index + 1;
            return {
              id,
              source: "manual",
              type: "message",
              timestamp: timestamps?.[index] ?? `2026-01-01T00:00:0${id}Z`,
              title: `note ${id}`,
              content: `hello world ${id}`,
            };
          })
        : eventsOrCount;
    for (const event of events) {
      insert.run(event.id, event.source, event.type, event.timestamp, event.title, event.content);
    }
    seed.close();
    return { dir, timelineDbPath, embeddingsDbPath };
  }

  function makeTimelineEventsRenderIdentically(timelineDbPath: string): void {
    const db = new Database(timelineDbPath);
    try {
      db.prepare("UPDATE events SET timestamp = ?, title = ?, content = ?").run(
        "2026-01-01T00:00:00Z",
        "shared note",
        "same rendered body"
      );
    } finally {
      db.close();
    }
  }

  function failFirstDocumentInsert(embeddingsDbPath: string): void {
    const db = getEmbeddingsDb(embeddingsDbPath);
    try {
      initEmbeddingsDb(db);
      db.exec(`
        CREATE TRIGGER fail_first_embedding_document
        BEFORE INSERT ON embedding_documents
        WHEN NEW.source_key = '1'
        BEGIN
          SELECT RAISE(ABORT, 'simulated document insert failure');
        END;
      `);
    } finally {
      db.close();
    }
  }

  function vectorCount(embeddingsDbPath: string): number {
    const db = new Database(embeddingsDbPath);
    loadSqliteVec(db);
    try {
      // Sum across every per-model vec0 table (the sql filter excludes vec0's
      // internal shadow tables, which also match the name prefix).
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vec_model_%' AND sql LIKE 'CREATE VIRTUAL TABLE%'"
        )
        .all() as { name: string }[];
      return tables.reduce(
        (sum, table) => sum + (db.prepare(`SELECT COUNT(*) AS c FROM ${table.name}`).get() as { c: number }).c,
        0
      );
    } finally {
      db.close();
    }
  }

  function linkedEventCount(embeddingsDbPath: string): number {
    const db = new Database(embeddingsDbPath);
    loadSqliteVec(db);
    try {
      return (db.prepare("SELECT COUNT(*) AS c FROM embedding_document_events").get() as { c: number }).c;
    } finally {
      db.close();
    }
  }

  function documentSourceKeys(embeddingsDbPath: string): string[] {
    const db = new Database(embeddingsDbPath);
    try {
      const rows = db
        .prepare("SELECT source_key FROM embedding_documents ORDER BY source_key")
        .all() as { source_key: string }[];
      return rows.map(row => row.source_key);
    } finally {
      db.close();
    }
  }

  function vectorEventIds(embeddingsDbPath: string): number[] {
    const db = new Database(embeddingsDbPath);
    loadSqliteVec(db);
    try {
      return (
        db
          .prepare(
            `SELECT ede.event_id
             FROM embedding_vectors ev
             JOIN embedding_document_events ede ON ede.document_id = ev.document_id
             ORDER BY ede.event_id`
          )
          .all() as { event_id: number }[]
      ).map(row => row.event_id);
    } finally {
      db.close();
    }
  }

  // Run the real CLI in a subprocess (the exit code is process-level, so it
  // cannot be asserted in-process without corrupting the test runner's own
  // exit code). `respond` builds the provider reply for each request (0-based).
  async function runIndex(
    timelineDbPath: string,
    embeddingsDbPath: string,
    options: {
      limit?: number;
      omitLimit?: boolean;
      batchSize?: number;
      since?: string;
      extraArgs?: string[];
      /** Extra keys appended to the [embeddings] section. */
      configExtra?: string;
      respond: (requestIndex: number, request: Request) => Response | Promise<Response>;
    }
  ): Promise<{ exitCode: number; stdout: string; stderr: string; requests: number }> {
    let requests = 0;
    const server = Bun.serve({ port: 0, fetch: request => options.respond(requests++, request) });
    try {
      const args = ["bun", "src/embeddings/cli.ts", "index"];
      if (!options.omitLimit) args.push("--limit", String(options.limit ?? 1));
      if (options.since) args.push("--since", options.since);
      args.push(...(options.extraArgs ?? []));
      const proc = Bun.spawn(args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TIMELINE_DB_PATH: timelineDbPath,
          TIMELINE_EMBEDDINGS_DB_PATH: embeddingsDbPath,
          TIMELINE_CONFIG: writeEmbeddingsConfig(dirname(embeddingsDbPath), `${server.url}v1`, options.configExtra),
          TIMELINE_EMBEDDING_BATCH_SIZE: String(options.batchSize ?? 16),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { exitCode, stdout, stderr, requests };
    } finally {
      server.stop(true);
    }
  }

  async function runCli(args: string[]): Promise<{ exitCode: number; stderr: string }> {
    const dir = mkdtempSync(join(tmpdir(), "timeline-embeddings-cli-"));
    try {
      const proc = Bun.spawn(["bun", "src/embeddings/cli.ts", ...args], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TIMELINE_CONFIG: writeEmbeddingsConfig(dir, "http://127.0.0.1:1/v1"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      return { exitCode: proc.exitCode ?? 0, stderr: await new Response(proc.stderr).text() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }


  const ok = (embedding: number[]) => async (_requestIndex: number, request: Request) => {
    const inputs = await readEmbeddingInputs(request);
    return Response.json({ data: inputs.map((_input, index) => ({ index, embedding })) });
  };

  cliIt("aborts on a fatal error without hammering the provider for every event", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline(2);
    try {
      // 2 dims from the provider, but configured for 3 -> a fatal config mismatch.
      const { exitCode, stdout, requests } = await runIndex(timelineDbPath, embeddingsDbPath, {
        limit: 2,
        respond: ok([1, 2]),
      });
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain('"embedded":0');
      expect(stdout).toContain('"errors":1');
      expect(requests).toBe(1); // stopped after the first failed embed, did not call again
      expect(vectorCount(embeddingsDbPath)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("skips a per-event document failure and keeps indexing the remaining events", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline(2);
    try {
      failFirstDocumentInsert(embeddingsDbPath);
      const { exitCode, stdout, stderr, requests } = await runIndex(timelineDbPath, embeddingsDbPath, {
        limit: 2,
        respond: ok([1, 2, 3]),
      });
      expect(requests, `CLI exited ${exitCode}: ${stderr}`).toBe(1);
      expect(stdout).toContain('"embedded":1');
      expect(stdout).toContain('"errors":1');
      expect(exitCode).not.toBe(0);
      expect(vectorCount(embeddingsDbPath)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("skips a per-event failure and keeps indexing the remaining events", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline(2);
    try {
      // The provider rejects the first input (per-event) but embeds the second.
      const { exitCode, stdout, requests } = await runIndex(timelineDbPath, embeddingsDbPath, {
        limit: 2,
        batchSize: 1,
        respond: requestIndex =>
          requestIndex === 0 ? new Response("input too long", { status: 400 }) : Response.json({ data: [{ embedding: [1, 2, 3] }] }),
      });
      expect(requests).toBe(2); // did not abort on the first failure
      expect(stdout).toContain('"embedded":1');
      expect(stdout).toContain('"errors":1');
      expect(exitCode).not.toBe(0); // errors > 0 still signals "not fully indexed"
      expect(vectorCount(embeddingsDbPath)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("sends pending documents in configured embedding batches", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline(3);
    const batchLengths: number[] = [];
    try {
      const { exitCode, stdout, requests } = await runIndex(timelineDbPath, embeddingsDbPath, {
        limit: 3,
        batchSize: 2,
        respond: async (requestIndex, request) => {
          const inputs = await readEmbeddingInputs(request);
          batchLengths.push(inputs.length);
          return Response.json({
            data: inputs.map((_input, index) => ({ index, embedding: [requestIndex + 1, index, 1] })).reverse(),
          });
        },
      });
      expect(exitCode).toBe(0);
      expect(requests).toBe(2);
      expect([...batchLengths].sort()).toEqual([1, 2]);
      expect(stdout).toContain('"embedded":3');
      expect(stdout).toContain('"errors":0');
      expect(vectorCount(embeddingsDbPath)).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("caps each embedding batch at MAX_BATCH_BYTES of rendered documents", async () => {
    const perBatch = MAX_BATCH_BYTES / MAX_RENDERED_BYTES;
    const content = "x".repeat(Math.floor(MAX_BATCH_BYTES / perBatch) - 100);
    const events = Array.from({ length: perBatch + 1 }, (_, index) => ({
      id: index + 1,
      source: "manual",
      type: "message",
      timestamp: `2026-01-01T00:00:0${index + 1}Z`,
      title: `long note ${index + 1}`,
      content: `${index + 1}${content}`,
    }));
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline(events);
    const batchLengths: number[] = [];
    try {
      const { exitCode, stdout } = await runIndex(timelineDbPath, embeddingsDbPath, {
        limit: events.length,
        batchSize: 64,
        extraArgs: ["--concurrency", "1"],
        respond: async (_requestIndex, request) => {
          const inputs = await readEmbeddingInputs(request);
          batchLengths.push(inputs.length);
          return Response.json({ data: inputs.map((_input, index) => ({ index, embedding: [1, index, 1] })) });
        },
      });
      expect(exitCode).toBe(0);
      expect(batchLengths).toEqual([perBatch, 1]);
      expect(stdout).toContain(`"embedded":${events.length}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("keeps --concurrency requests in flight and writes vectors in event order", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline(6);
    let inFlight = 0;
    let maxInFlight = 0;
    // No response is sent until three requests are open, so the count does not depend on how fast
    // the CLI sends them. If the CLI never opens three, the held requests hit the 2 s timeout.
    const threeOpen = Promise.withResolvers<void>();
    try {
      const { exitCode, stdout, requests } = await runIndex(timelineDbPath, embeddingsDbPath, {
        limit: 6,
        batchSize: 1,
        extraArgs: ["--concurrency", "3"],
        configExtra: "timeout_seconds = 2",
        respond: async (_requestIndex, request) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (inFlight === 3) threeOpen.resolve();
          await threeOpen.promise;
          const [input] = await readEmbeddingInputs(request);
          // Later events answer first, so completion order is the reverse of event order.
          const id = Number(input?.match(/hello world (\d+)/)?.[1]);
          await Bun.sleep((7 - id) * 25);
          inFlight--;
          return Response.json({ data: [{ index: 0, embedding: [id, 0, 1] }] });
        },
      });
      expect(exitCode).toBe(0);
      expect(requests).toBe(6);
      expect(maxInFlight).toBe(3);
      expect(stdout).toContain('"embedded":6');

      const db = new Database(embeddingsDbPath, { readonly: true });
      try {
        const written = db
          .prepare(
            `SELECT ede.event_id
             FROM embedding_vectors ev
             JOIN embedding_document_events ede ON ede.document_id = ev.document_id
             ORDER BY ev.id`
          )
          .all() as { event_id: number }[];
        expect(written.map(row => row.event_id)).toEqual([1, 2, 3, 4, 5, 6]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("aborts when a request times out and resumes on re-run", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline(3);
    try {
      const timedOut = await runIndex(timelineDbPath, embeddingsDbPath, {
        limit: 3,
        batchSize: 1,
        // Event 2 never responds; allow successful requests time to finish on busy runners.
        configExtra: "timeout_seconds = 1",
        respond: async (_requestIndex, request) => {
          const [input] = await readEmbeddingInputs(request);
          // The provider never answers event 2.
          if (input?.includes("hello world 2")) return new Promise<Response>(() => {});
          return Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] });
        },
      });
      expect(timedOut.exitCode).not.toBe(0);
      expect(timedOut.stdout).toContain('"errors":1');
      // Event 1 is written; event 3 is not, since writes stay in event order.
      expect(vectorEventIds(embeddingsDbPath)).toEqual([1]);

      const resumed = await runIndex(timelineDbPath, embeddingsDbPath, { limit: 3, respond: ok([1, 2, 3]) });
      expect(resumed.exitCode).toBe(0);
      expect(resumed.stdout).toContain('"embedded":2');
      expect(resumed.stdout).toContain('"skipped":1');
      expect(vectorEventIds(embeddingsDbPath)).toEqual([1, 2, 3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("does not enqueue duplicate rendered documents twice within one batch", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline(2);
    const batchLengths: number[] = [];
    try {
      makeTimelineEventsRenderIdentically(timelineDbPath);
      const { exitCode, stdout, requests } = await runIndex(timelineDbPath, embeddingsDbPath, {
        limit: 2,
        batchSize: 2,
        respond: async (_requestIndex, request) => {
          const inputs = await readEmbeddingInputs(request);
          batchLengths.push(inputs.length);
          return Response.json({ data: inputs.map((_input, index) => ({ index, embedding: [1, 2, 3] })) });
        },
      });
      expect(exitCode).toBe(0);
      expect(requests).toBe(1);
      expect(batchLengths).toEqual([1]);
      expect(stdout).toContain('"embedded":1');
      expect(stdout).toContain('"skipped":1');
      expect(stdout).toContain('"errors":0');
      expect(vectorCount(embeddingsDbPath)).toBe(1);
      expect(linkedEventCount(embeddingsDbPath)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("bisects a failed embedding batch and skips only the bad input", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline(3);
    try {
      const { exitCode, stdout, requests } = await runIndex(timelineDbPath, embeddingsDbPath, {
        limit: 3,
        batchSize: 3,
        respond: async (_requestIndex, request) => {
          const inputs = await readEmbeddingInputs(request);
          if (inputs.length > 1) return new Response("batch rejected", { status: 400 });
          const input = inputs[0];
          if (input?.includes("hello world 2")) return new Response("input too long", { status: 400 });
          return Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] });
        },
      });
      expect(requests).toBe(5);
      expect(stdout).toContain('"embedded":2');
      expect(stdout).toContain('"errors":1');
      expect(exitCode).not.toBe(0);
      expect(vectorCount(embeddingsDbPath)).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("exits zero and writes the vector when embedding succeeds", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline();
    try {
      const { exitCode, stdout } = await runIndex(timelineDbPath, embeddingsDbPath, { respond: ok([1, 2, 3]) });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('"limit":1');
      expect(stdout).toContain('"selected":1');
      expect(stdout).toContain('"embedded":1');
      expect(stdout).toContain('"errors":0');
      expect(vectorCount(embeddingsDbPath)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("indexes with the configured document prefix and records it on the profile", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline();
    const inputs: string[] = [];
    try {
      const { exitCode } = await runIndex(timelineDbPath, embeddingsDbPath, {
        configExtra: 'document_prefix = "title: none | text: "',
        respond: async (_requestIndex, request) => {
          const batch = await readEmbeddingInputs(request);
          inputs.push(...batch);
          return Response.json({ data: batch.map((_input, index) => ({ index, embedding: [1, 2, 3] })) });
        },
      });
      expect(exitCode).toBe(0);
      expect(inputs.length).toBe(1);
      expect(inputs[0]?.startsWith("title: none | text: ")).toBe(true);

      const db = new Database(embeddingsDbPath, { readonly: true });
      try {
        expect(getModelProfile(db, "fake:3")?.document_prefix).toBe("title: none | text: ");
        // The stored document is the render alone; the prefix belongs to the model profile.
        const stored = db.prepare("SELECT rendered_content FROM embedding_documents").get() as { rendered_content: string };
        expect(stored.rendered_content.startsWith("title:")).toBe(false);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("reports index counts when interrupted by SIGINT", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline();
    let resolveRequestSeen: (() => void) | undefined;
    let resolveProviderResponse: ((response: Response) => void) | undefined;
    const requestSeen = new Promise<void>(resolve => {
      resolveRequestSeen = resolve;
    });
    const providerResponse = new Promise<Response>(resolve => {
      resolveProviderResponse = resolve;
    });
    const server = Bun.serve({
      port: 0,
      fetch: async request => {
        await readEmbeddingInputs(request);
        resolveRequestSeen?.();
        return providerResponse;
      },
    });

    const proc = Bun.spawn(["bun", "src/embeddings/cli.ts", "index", "--limit", "1"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TIMELINE_DB_PATH: timelineDbPath,
        TIMELINE_EMBEDDINGS_DB_PATH: embeddingsDbPath,
        TIMELINE_CONFIG: writeEmbeddingsConfig(dir, `${server.url}v1`),
        TIMELINE_EMBEDDING_BATCH_SIZE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      await withTimeout(requestSeen, 15000, "embedding request was not started");
      proc.kill("SIGINT");
      await withTimeout(proc.exited, 15000, "embedding index process did not exit after SIGINT");
      const stdout = await new Response(proc.stdout).text();
      expect(proc.exitCode).toBe(130);
      expect(stdout).toContain('"selected":1');
      expect(stdout).toContain('"created":1');
      expect(stdout).toContain('"embedded":0');
      expect(stdout).toContain('"errors":0');
      expect(vectorCount(embeddingsDbPath)).toBe(0);
    } finally {
      resolveProviderResponse?.(Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
      server.stop(true);
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("reports the default index limit and selected candidate count", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline(30);
    try {
      const { exitCode, stdout, requests } = await runIndex(timelineDbPath, embeddingsDbPath, {
        omitLimit: true,
        respond: ok([1, 2, 3]),
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('"limit":25');
      expect(stdout).toContain('"selected":25');
      expect(stdout).toContain('"embedded":25');
      expect(requests).toBe(2);
      expect(vectorCount(embeddingsDbPath)).toBe(25);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("indexes only events on or after --since", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline(2, [
      "2025-12-31T23:59:59Z",
      "2026-01-01T00:00:00Z",
    ]);
    try {
      const { exitCode, stdout, requests } = await runIndex(timelineDbPath, embeddingsDbPath, {
        since: "2026-01-01",
        respond: ok([1, 2, 3]),
      });
      expect(exitCode).toBe(0);
      expect(requests).toBe(1);
      expect(stdout).toContain('"embedded":1');
      expect(documentSourceKeys(embeddingsDbPath)).toEqual(["2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("compares offset --since timestamps as instants", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline(2, [
      "2025-12-31T21:59:59Z",
      "2025-12-31T23:00:00Z",
    ]);
    try {
      const { exitCode, stdout, requests } = await runIndex(timelineDbPath, embeddingsDbPath, {
        since: "2026-01-01T00:00:00+02:00",
        respond: ok([1, 2, 3]),
      });
      expect(exitCode).toBe(0);
      expect(requests).toBe(1);
      expect(stdout).toContain('"embedded":1');
      expect(documentSourceKeys(embeddingsDbPath)).toEqual(["2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("preserves fractional seconds for timestamp --since", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline(2, [
      "2026-01-01T00:00:00.100Z",
      "2026-01-01T00:00:00.600Z",
    ]);
    try {
      const { exitCode, stdout, requests } = await runIndex(timelineDbPath, embeddingsDbPath, {
        since: "2026-01-01T00:00:00.500Z",
        respond: ok([1, 2, 3]),
      });
      expect(exitCode).toBe(0);
      expect(requests).toBe(1);
      expect(stdout).toContain('"embedded":1');
      expect(documentSourceKeys(embeddingsDbPath)).toEqual(["2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("excludes reddit votes by default when indexing", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline([
      {
        id: 1,
        source: "reddit",
        type: "vote:up",
        timestamp: "2026-01-01T00:00:01Z",
        title: "Upvoted post",
        content: "A post that should not be embedded by default",
      },
      {
        id: 2,
        source: "reddit",
        type: "vote:down",
        timestamp: "2026-01-01T00:00:02Z",
        title: "Downvoted post",
        content: "Another post that should not be embedded by default",
      },
      {
        id: 3,
        source: "reddit",
        type: "comment",
        timestamp: "2026-01-01T00:00:03Z",
        title: "Comment",
        content: "A comment that should still be embedded",
      },
    ]);
    try {
      const { exitCode, stdout, requests } = await runIndex(timelineDbPath, embeddingsDbPath, {
        limit: 10,
        respond: ok([1, 2, 3]),
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('"embedded":1');
      expect(requests).toBe(1);
      expect(vectorEventIds(embeddingsDbPath)).toEqual([3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("keeps policy exclusions when an explicit include overrides the allowlist", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline([
      {
        id: 1,
        source: "reddit",
        type: "vote:up",
        timestamp: "2026-01-01T00:00:01Z",
        title: "Upvoted post",
        content: "A post that must remain excluded",
      },
      {
        id: 2,
        source: "reddit",
        type: "vote:down",
        timestamp: "2026-01-01T00:00:02Z",
        title: "Downvoted post",
        content: "Another post that must remain excluded",
      },
      {
        id: 3,
        source: "reddit",
        type: "comment",
        timestamp: "2026-01-01T00:00:03Z",
        title: "Comment",
        content: "A comment that should be embedded",
      },
    ]);
    try {
      const { exitCode, stdout, requests } = await runIndex(timelineDbPath, embeddingsDbPath, {
        limit: 10,
        extraArgs: ["--include", "reddit"],
        respond: ok([1, 2, 3]),
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('"embedded":1');
      expect(requests).toBe(1);
      expect(vectorEventIds(embeddingsDbPath)).toEqual([3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("applies whole-source and source/type index filters together", async () => {
    const { dir, timelineDbPath, embeddingsDbPath } = seedTimeline([
      {
        id: 1,
        source: "spotify",
        type: "listen:track",
        timestamp: "2026-01-01T00:00:01Z",
        title: "Track",
        content: "Filtered by source/type pair",
      },
      {
        id: 2,
        source: "spotify",
        type: "listen:podcast",
        timestamp: "2026-01-01T00:00:02Z",
        title: "Podcast",
        content: "Kept",
      },
      {
        id: 3,
        source: "reddit",
        type: "comment",
        timestamp: "2026-01-01T00:00:03Z",
        title: "Comment",
        content: "Filtered out by whole-source include",
      },
      {
        id: 4,
        source: "spotify",
        type: "listen:audiobook",
        timestamp: "2026-01-01T00:00:04Z",
        title: "Audiobook",
        content: "Filtered by source/type pair",
      },
    ]);
    try {
      const { exitCode, stdout, requests } = await runIndex(timelineDbPath, embeddingsDbPath, {
        limit: 10,
        extraArgs: [
          "--include",
          "spotify",
          "--exclude",
          "spotify:listen:track,spotify:listen:audiobook",
        ],
        respond: ok([1, 2, 3]),
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('"embedded":1');
      expect(requests).toBe(1);
      expect(vectorEventIds(embeddingsDbPath)).toEqual([2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  cliIt("rejects index-only filter flags on search", async () => {
    const { exitCode, stderr } = await runCli(["search", "--include", "spotify", "cats"]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--include is only supported by the index command");
  });
});
