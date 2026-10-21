import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { getEmbeddingsDb, initEmbeddingsDb, insertVector } from "../../embeddings/db";
import { IMAGE_MAX_SIDE, prepareImageForEmbedding } from "../../embeddings/images";
import { configureBunSqliteForSqliteVec } from "../../embeddings/sqlite-vec";
import { LocalMediaStore, setMediaStoreOverride } from "../../media/storage";
import type { SyncConfig } from "../config";
import { embeddingsSyncSource, parseEmbeddingsSyncSettings } from "./embeddings";

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

const vecIt = sqliteVecAvailable() ? it : it.skip;

describe("embeddings sync settings", () => {
  it("defaults the time budget and concurrency and rejects invalid values", () => {
    expect(parseEmbeddingsSyncSettings()).toEqual({ timeBudgetMs: 60_000, concurrency: 4, indexImages: false });
    expect(parseEmbeddingsSyncSettings({ concurrency: 2, time_budget_ms: 5_000, index_images: true })).toEqual({
      timeBudgetMs: 5_000,
      concurrency: 2,
      indexImages: true,
    });
    expect(parseEmbeddingsSyncSettings({ index_images: "yes" })).toBe("invalid index_images setting");
    expect(parseEmbeddingsSyncSettings({ concurrency: 0 })).toBe("invalid concurrency setting");
    expect(parseEmbeddingsSyncSettings({ time_budget_ms: "60s" })).toBe("invalid time_budget_ms setting");
    // A run must finish well inside the job lease.
    expect(parseEmbeddingsSyncSettings({ time_budget_ms: 5 * 60_000 })).toMatchObject({ timeBudgetMs: 5 * 60_000 });
    expect(parseEmbeddingsSyncSettings({ time_budget_ms: 5 * 60_000 + 1 })).toBe("invalid time_budget_ms setting");
  });
});

describe("embeddings sync source", () => {
  const saved = {
    TIMELINE_DB_PATH: process.env.TIMELINE_DB_PATH,
    TIMELINE_EMBEDDINGS_DB_PATH: process.env.TIMELINE_EMBEDDINGS_DB_PATH,
    TIMELINE_CONFIG: process.env.TIMELINE_CONFIG,
  };
  let dir: string;
  let timelineDbPath: string;
  let embeddingsDbPath: string;
  let server: ReturnType<typeof Bun.serve>;
  let requestedInputs: string[][];
  let failRequests: boolean;
  let nextEventId: number;

  function insertEvents(events: Array<{ source: string; type?: string; content: string }>): number[] {
    const db = new Database(timelineDbPath);
    try {
      const insert = db.prepare(
        "INSERT INTO events (id, source, type, timestamp, title, content) VALUES (?, ?, ?, '2026-01-01T00:00:00Z', NULL, ?)"
      );
      return events.map(event => {
        // Sparse ids, like the host's AUTOINCREMENT sequence.
        nextEventId += 1000;
        insert.run(nextEventId, event.source, event.type ?? "message", event.content);
        return nextEventId;
      });
    } finally {
      db.close();
    }
  }

  function embeddedEventIds(): number[] {
    const db = getEmbeddingsDb(embeddingsDbPath);
    try {
      initEmbeddingsDb(db);
      return (
        db
          .prepare(
            `SELECT ede.event_id FROM embedding_vectors ev
             JOIN embedding_document_events ede ON ede.document_id = ev.document_id ORDER BY ede.event_id`
          )
          .all() as { event_id: number }[]
      ).map(row => row.event_id);
    } finally {
      db.close();
    }
  }

  function run(settings: Record<string, unknown> = {}) {
    const config: SyncConfig = { sources: { embeddings: settings } } as unknown as SyncConfig;
    return embeddingsSyncSource.sync({ verbose: false, config });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "emb-sync-"));
    timelineDbPath = join(dir, "timeline.db");
    embeddingsDbPath = join(dir, "embeddings.db");
    const seed = new Database(timelineDbPath);
    seed.exec(
      "CREATE TABLE events (id INTEGER PRIMARY KEY, source TEXT, type TEXT, timestamp TEXT, end_timestamp TEXT, title TEXT, content TEXT, location_name TEXT)"
    );
    seed.close();
    nextEventId = 0;
    requestedInputs = [];
    failRequests = false;
    server = Bun.serve({
      port: 0,
      fetch: async request => {
        if (failRequests) return new Response("upstream down", { status: 503 });
        const { input } = (await request.json()) as { input: string[] };
        requestedInputs.push(input);
        return Response.json({ data: input.map((_text, index) => ({ index, embedding: [1, index, 0] })) });
      },
    });
    const configPath = join(dir, "config.toml");
    writeFileSync(configPath, `[embeddings]\nbase_url = "${server.url}v1"\nmodel = "fake"\ndimensions = 3\n`);
    process.env.TIMELINE_DB_PATH = timelineDbPath;
    process.env.TIMELINE_EMBEDDINGS_DB_PATH = embeddingsDbPath;
    process.env.TIMELINE_CONFIG = configPath;
  });

  afterEach(() => {
    server.stop(true);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  vecIt("embeds corpus events added since the last run and only those", async () => {
    const first = insertEvents([
      { source: "discord", content: "first message" },
      { source: "recall", type: "screen:capture", content: "screen text" },
      { source: "facebook", content: "second message" },
    ]);
    const firstRun = await run();
    expect(firstRun.success).toBe(true);
    expect(firstRun.eventsAdded).toBe(2);
    expect(firstRun.metadata).toMatchObject({ examined: 2, caughtUp: true, lastEventId: first[2] });
    expect(embeddedEventIds()).toEqual([first[0], first[2]]);

    const [added] = insertEvents([{ source: "discord", content: "a new message" }]);
    requestedInputs = [];
    const secondRun = await run();
    expect(secondRun.success).toBe(true);
    expect(secondRun.metadata).toMatchObject({ examined: 1, reused: 0, embedded: 1, lastEventId: added });
    expect(requestedInputs.flat()).toEqual([expect.stringContaining("a new message")]);
    expect(embeddedEventIds()).toEqual([first[0], first[2], added]);

    requestedInputs = [];
    const idleRun = await run();
    expect(idleRun.metadata).toMatchObject({ examined: 0, embedded: 0, caughtUp: true });
    expect(requestedInputs).toEqual([]);
  });

  vecIt("fails on a provider outage and resumes from the last complete step", async () => {
    const [eventId] = insertEvents([{ source: "discord", content: "waiting message" }]);
    failRequests = true;
    const failed = await run();
    expect(failed.success).toBe(false);
    expect(failed.error).toContain("503");
    expect(embeddedEventIds()).toEqual([]);

    failRequests = false;
    const resumed = await run();
    expect(resumed.success).toBe(true);
    expect(embeddedEventIds()).toEqual([eventId]);
  });

  vecIt("stops at the time budget without passing unindexed events", async () => {
    insertEvents([
      ...Array.from({ length: 50 }, (_, index) => ({ source: "discord", content: `message ${index}` })),
      // Counted as remaining while catching up, though the cursor passes it unexamined.
      { source: "discord", content: "" },
      // Outside the corpus, so never counted.
      { source: "recall", type: "screen:capture", content: "screen text" },
    ]);
    // One step holds a full-size batch per concurrent request: 2 × 8 events.
    const partial = await run({ time_budget_ms: 1, concurrency: 2 });
    expect(partial.success).toBe(true);
    expect(partial.metadata).toMatchObject({ examined: 16, embedded: 16, caughtUp: false, remainingQueueDepth: 35 });

    const rest = await run();
    expect(rest.metadata).toMatchObject({ examined: 34, embedded: 34, caughtUp: true, remainingQueueDepth: 0 });
    expect(embeddedEventIds()).toHaveLength(50);
  });

  vecIt("stops cleanly when aborted and resumes from the last complete step", async () => {
    insertEvents(Array.from({ length: 40 }, (_, index) => ({ source: "discord", content: `message ${index}` })));
    const controller = new AbortController();
    let requests = 0;
    server.reload({
      fetch: async request => {
        const { input } = (await request.json()) as { input: string[] };
        requests++;
        // Abort while the second step's request is in flight.
        if (requests === 2) controller.abort();
        return Response.json({ data: input.map((_text, index) => ({ index, embedding: [1, index, 0] })) });
      },
    });
    const config = { sources: { embeddings: { concurrency: 1 } } } as unknown as SyncConfig;
    const aborted = await embeddingsSyncSource.sync({ verbose: false, config, signal: controller.signal });
    expect(aborted.success).toBe(true);
    expect(aborted.error).toBeUndefined();
    expect(aborted.metadata).toMatchObject({ embedded: 8, stoppedReason: "aborted" });

    const rest = await run({ concurrency: 1 });
    expect(rest.metadata).toMatchObject({ examined: 32, embedded: 32, caughtUp: true });
    expect(embeddedEventIds()).toHaveLength(40);
  });

  vecIt("skips vectors that a concurrent index run stored first", async () => {
    insertEvents([
      { source: "discord", content: "first message" },
      { source: "discord", content: "second message" },
    ]);
    server.reload({
      fetch: async request => {
        const { input } = (await request.json()) as { input: string[] };
        // Another index run stores vectors for the same documents while this request is in flight.
        const other = getEmbeddingsDb(embeddingsDbPath);
        try {
          initEmbeddingsDb(other);
          const { id: modelProfileId } = other.prepare("SELECT id FROM embedding_model_profiles").get() as { id: number };
          for (const { id } of other.prepare("SELECT id FROM embedding_documents").all() as { id: number }[]) {
            insertVector(other, id, modelProfileId, [0, 0, 1]);
          }
        } finally {
          other.close();
        }
        return Response.json({ data: input.map((_text, index) => ({ index, embedding: [1, index, 0] })) });
      },
    });
    const result = await run();
    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({ examined: 2, embedded: 0, skipped: 2, errors: 0 });
  });

  it("refuses to run without an [embeddings] section", async () => {
    const configPath = join(dir, "empty.toml");
    writeFileSync(configPath, "");
    process.env.TIMELINE_CONFIG = configPath;
    expect(await embeddingsSyncSource.canSync({})).toContain("Semantic search is not configured");
  });
});

describe("embeddings sync source photos", () => {
  const saved = {
    TIMELINE_DB_PATH: process.env.TIMELINE_DB_PATH,
    TIMELINE_EMBEDDINGS_DB_PATH: process.env.TIMELINE_EMBEDDINGS_DB_PATH,
    TIMELINE_CONFIG: process.env.TIMELINE_CONFIG,
  };
  const MARKER = "<__test_media__>";
  let dir: string;
  let timelineDbPath: string;
  let embeddingsDbPath: string;
  let mediaStore: LocalMediaStore;
  let server: ReturnType<typeof Bun.serve>;
  let vision: boolean;
  let propsRequests: number;
  let imageInputs: number;
  let imageDelayMs: number;
  let nextId: number;

  async function addPhoto(options: { source: string; events: number; mimeType?: string; onDisk?: boolean }) {
    nextId++;
    const image = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: nextId * 20, g: 80, b: 160 } } })
      .png()
      .toBuffer();
    const stored = await mediaStore.storeFile({ source: options.source, relativePath: `photo-${nextId}.png`, content: image });
    if (options.onDisk === false) {
      rmSync(mediaStore.getAbsolutePath(stored.storagePath));
      rmSync(join(dir, "media", "by-hash"), { recursive: true, force: true });
    }
    const db = new Database(timelineDbPath);
    try {
      const eventIds = Array.from({ length: options.events }, (_, index) => {
        const eventId = nextId * 100 + index;
        db.prepare("INSERT INTO events (id, source, type, timestamp, content) VALUES (?, ?, 'message', ?, '')").run(
          eventId,
          options.source,
          `2026-01-0${index + 1}T00:00:00Z`
        );
        db.prepare(
          "INSERT INTO attachments (event_id, source, source_id, content_hash, mime_type, storage_path, status) VALUES (?, ?, ?, ?, ?, ?, 'stored')"
        ).run(eventId, options.source, `att-${eventId}`, stored.hash, options.mimeType ?? "image/png", stored.storagePath);
        return eventId;
      });
      return { hash: stored.hash, eventIds };
    } finally {
      db.close();
    }
  }

  function photoDocuments(): Array<{ source_key: string; event_ids: string }> {
    const db = getEmbeddingsDb(embeddingsDbPath);
    try {
      initEmbeddingsDb(db);
      return db
        .prepare(
          `SELECT d.source_key, GROUP_CONCAT(ede.event_id) AS event_ids FROM embedding_documents d
           JOIN embedding_vectors v ON v.document_id = d.id
           JOIN embedding_document_events ede ON ede.document_id = d.id
           WHERE d.source_kind = 'attachment' GROUP BY d.id ORDER BY d.source_key`
        )
        .all() as Array<{ source_key: string; event_ids: string }>;
    } finally {
      db.close();
    }
  }

  function run(settings: Record<string, unknown> = { index_images: true }) {
    const config: SyncConfig = { sources: { embeddings: settings } } as unknown as SyncConfig;
    return embeddingsSyncSource.sync({ verbose: false, config });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "emb-photos-"));
    timelineDbPath = join(dir, "timeline.db");
    embeddingsDbPath = join(dir, "embeddings.db");
    const seed = new Database(timelineDbPath);
    seed.exec(`
      CREATE TABLE events (id INTEGER PRIMARY KEY, source TEXT, type TEXT, timestamp TEXT, end_timestamp TEXT, title TEXT, content TEXT, location_name TEXT);
      CREATE TABLE attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER, source TEXT, source_id TEXT, content_hash TEXT, mime_type TEXT, storage_path TEXT, status TEXT);
    `);
    seed.close();
    mediaStore = new LocalMediaStore(join(dir, "media"));
    setMediaStoreOverride(mediaStore);
    vision = true;
    propsRequests = 0;
    imageInputs = 0;
    imageDelayMs = 0;
    nextId = 0;
    server = Bun.serve({
      port: 0,
      fetch: async request => {
        if (new URL(request.url).pathname === "/props") {
          propsRequests++;
          return Response.json({ media_marker: MARKER, modalities: { vision } });
        }
        const { input } = (await request.json()) as { input: unknown[] };
        for (const item of input) {
          if (typeof item === "string") continue;
          const { prompt_string, multimodal_data } = item as { prompt_string: string; multimodal_data: string[] };
          if (prompt_string !== MARKER || multimodal_data.length !== 1) return new Response("bad image input", { status: 400 });
          // The image arrives prepared as a JPEG.
          const { format } = await sharp(Buffer.from(multimodal_data[0] ?? "", "base64")).metadata();
          if (format !== "jpeg") return new Response("not a jpeg", { status: 400 });
          imageInputs++;
          await Bun.sleep(imageDelayMs);
        }
        return Response.json({ data: input.map((_item, index) => ({ index, embedding: [0, 1, index] })) });
      },
    });
    const configPath = join(dir, "config.toml");
    writeFileSync(configPath, `[embeddings]\nbase_url = "${server.url}v1"\nmodel = "fake"\ndimensions = 3\n`);
    process.env.TIMELINE_DB_PATH = timelineDbPath;
    process.env.TIMELINE_EMBEDDINGS_DB_PATH = embeddingsDbPath;
    process.env.TIMELINE_CONFIG = configPath;
  });

  afterEach(() => {
    server.stop(true);
    setMediaStoreOverride(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("prepares photos as JPEGs no larger than the model's input size", async () => {
    const wide = await sharp({ create: { width: 2000, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    expect(await sharp(await prepareImageForEmbedding(wide)).metadata()).toMatchObject({
      format: "jpeg",
      width: IMAGE_MAX_SIDE,
      height: IMAGE_MAX_SIDE / 2,
    });
    const small = await sharp({ create: { width: 100, height: 50, channels: 3, background: "#123456" } }).webp().toBuffer();
    expect(await sharp(await prepareImageForEmbedding(small)).metadata()).toMatchObject({ format: "jpeg", width: 100, height: 50 });
  });

  vecIt("embeds each distinct photo once and links every event that carries it", async () => {
    const shared = await addPhoto({ source: "discord", events: 2 });
    const single = await addPhoto({ source: "facebook", events: 1 });
    await addPhoto({ source: "recall", events: 1 });
    await addPhoto({ source: "discord", events: 1, mimeType: "image/svg+xml" });

    const first = await run();
    expect(first.success).toBe(true);
    expect(first.metadata).toMatchObject({ images: { embedded: 2, failed: 0, remaining: 0 }, remainingQueueDepth: 0 });
    expect(imageInputs).toBe(2);
    expect(photoDocuments()).toEqual(
      [
        { source_key: shared.hash, event_ids: shared.eventIds.join(",") },
        { source_key: single.hash, event_ids: single.eventIds.join(",") },
      ].sort((a, b) => a.source_key.localeCompare(b.source_key))
    );

    // Photos are ranked apart from event text, so text search does not see them.
    const db = getEmbeddingsDb(embeddingsDbPath);
    try {
      initEmbeddingsDb(db);
      const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count("vec_model_1_attachment")).toBe(2);
      expect(count("vec_model_1")).toBe(0);
    } finally {
      db.close();
    }

    const second = await run();
    expect(second.metadata).toMatchObject({ images: { embedded: 0, failed: 0, remaining: 0 } });
    expect(imageInputs).toBe(2);
  });

  vecIt("stops starting photos at the time budget and resumes on the next run", async () => {
    for (let photo = 0; photo < 8; photo++) await addPhoto({ source: "discord", events: 1 });
    // Each photo takes 150 ms, so a 400 ms budget runs out partway through.
    imageDelayMs = 150;
    const partial = await run({ index_images: true, time_budget_ms: 400, concurrency: 1 });
    const images = (partial.metadata as { images: { embedded: number; remaining: number } }).images;
    expect(images.embedded).toBeLessThan(8);
    expect(images.remaining).toBe(8 - images.embedded);

    imageDelayMs = 0;
    const rest = await run();
    expect(rest.metadata).toMatchObject({ images: { embedded: images.remaining, remaining: 0 } });
  });

  vecIt("records a photo missing from media storage once and skips it afterwards", async () => {
    await addPhoto({ source: "discord", events: 1, onDisk: false });
    const first = await run();
    expect(first.success).toBe(false);
    expect(first.error).toContain("1 images failed to embed");
    expect(first.metadata).toMatchObject({ images: { embedded: 0, failed: 1 } });

    const second = await run();
    expect(second.success).toBe(true);
    expect(second.metadata).toMatchObject({ images: { embedded: 0, failed: 0, remaining: 0 } });
  });

  vecIt("fails the run when the embeddings server cannot embed images", async () => {
    vision = false;
    await addPhoto({ source: "discord", events: 1 });
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.error).toContain("--mmproj");
    expect(photoDocuments()).toEqual([]);
  });

  vecIt("leaves photos alone unless index_images is on", async () => {
    await addPhoto({ source: "discord", events: 1 });
    const result = await run({});
    expect(result.success).toBe(true);
    expect(result.metadata).not.toHaveProperty("images");
    expect(propsRequests).toBe(0);
    expect(photoDocuments()).toEqual([]);
  });
});
