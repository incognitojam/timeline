import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { RetryError } from "ai";
import sharp from "sharp";
import { initDb } from "../db/schema";
import {
  ATTACHMENT_DESCRIPTION_FAILURE_SAMPLE_LIMIT,
  attachmentDescriptionEligibilityFilters,
  countNeedingDescriptions,
  describeAttachments,
  prepareAttachmentImageForDescription,
} from "../media/describe-attachments";
import { NOISY_MACHINE_SOURCES } from "../shared/noisy-sources";
import {
  generateAttachmentDescription,
  HELP,
  parseArgs,
  selectAttachmentsToDescribe,
} from "./describe-attachments";

const TEST_IMAGE = await sharp({
  create: { width: 1, height: 1, channels: 3, background: "white" },
}).png().toBuffer();

async function captureDescriptionRequest(
  reasoningEffort?: string,
  image = TEST_IMAGE,
  maxImageDimension?: number,
): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl: typeof fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const body = init?.body;
      if (typeof body !== "string") throw new Error("Expected JSON request body");
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          created: 0,
          model: "vision-model",
          choices: [
            {
              message: { role: "assistant", content: "A small image." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    { preconnect: (() => {}) as typeof fetch.preconnect },
  );
  const provider = createOpenAICompatible({
    name: "lmstudio",
    baseURL: "http://example.test/v1",
    fetch: fetchImpl,
  });

  await generateAttachmentDescription({
    model: provider("vision-model"),
    image,
    mediaType: "image/png",
    reasoningEffort,
    maxImageDimension,
  });

  const body = bodies[0];
  if (!body) throw new Error("No request was captured");
  return body;
}

describe("prepareAttachmentImageForDescription", () => {
  it("resizes images below the default cap when a smaller limit is selected", async () => {
    const image = await sharp({
      create: { width: 1472, height: 1994, channels: 3, background: "white" },
    }).png().toBuffer();
    const original = Buffer.from(image);

    expect((await prepareAttachmentImageForDescription(image, "image/png")).image.equals(image)).toBe(true);
    const prepared = await prepareAttachmentImageForDescription(image, "image/png", 1024);
    expect(await sharp(prepared.image).metadata()).toMatchObject({ format: "png", width: 756, height: 1024 });
    expect(image.equals(original)).toBe(true);
  });

  it("does not enlarge images below a custom limit", async () => {
    const prepared = await prepareAttachmentImageForDescription(TEST_IMAGE, "image/png", 1024);
    expect(prepared.image.equals(TEST_IMAGE)).toBe(true);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2049])("rejects invalid image dimension %s", async (dimension) => {
    await expect(prepareAttachmentImageForDescription(TEST_IMAGE, "image/png", dimension))
      .rejects.toThrow("maxImageDimension must be an integer between 1 and 2048");
  });

  it("downscales oversized PNGs and preserves their media type", async () => {
    const image = await sharp({
      create: { width: 3000, height: 2000, channels: 4, background: "transparent" },
    }).png().toBuffer();

    const prepared = await prepareAttachmentImageForDescription(image, "image/png");

    expect(prepared.mediaType).toBe("image/png");
    const metadata = await sharp(prepared.image).metadata();
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBe(2048);
    expect(prepared.image.equals(image)).toBe(false);
  });

  it("keeps small images byte-identical", async () => {
    const image = await sharp({
      create: { width: 200, height: 100, channels: 3, background: "white" },
    }).jpeg().toBuffer();

    const prepared = await prepareAttachmentImageForDescription(image, "image/jpeg");

    expect(prepared.mediaType).toBe("image/jpeg");
    expect(prepared.image.equals(image)).toBe(true);
  });

  it("downscales oversized JPEGs without changing their media type", async () => {
    const image = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: "white" },
    }).jpeg().toBuffer();

    const prepared = await prepareAttachmentImageForDescription(image, "image/jpeg");

    expect(prepared.mediaType).toBe("image/jpeg");
    const metadata = await sharp(prepared.image).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBe(2048);
  });

  it("physically rotates EXIF-oriented oversized JPEGs before downscaling", async () => {
    const image = await sharp({
      create: { width: 4032, height: 2268, channels: 3, background: "white" },
    }).withMetadata({ orientation: 6 }).jpeg().toBuffer();

    const prepared = await prepareAttachmentImageForDescription(image, "image/jpeg");
    const metadata = await sharp(prepared.image).metadata();

    expect(metadata).toMatchObject({ format: "jpeg", width: 1152, height: 2048 });
  });

  it("re-encodes small non-PNG and non-JPEG images as PNG", async () => {
    const image = await sharp({
      create: { width: 200, height: 100, channels: 3, background: "white" },
    }).webp().toBuffer();

    const prepared = await prepareAttachmentImageForDescription(image, "image/webp");

    expect(prepared.mediaType).toBe("image/png");
    const metadata = await sharp(prepared.image).metadata();
    expect(metadata).toMatchObject({ format: "png", width: 200, height: 100 });
  });

  it("re-encodes oversized non-PNG and non-JPEG images as PNG", async () => {
    const image = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: "white" },
    }).webp().toBuffer();

    const prepared = await prepareAttachmentImageForDescription(image, "image/webp");

    expect(prepared.mediaType).toBe("image/png");
    const metadata = await sharp(prepared.image).metadata();
    expect(metadata.format).toBe("png");
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBe(2048);
  });
});

describe("parseArgs", () => {
  it("parses and validates a custom image dimension", () => {
    expect(parseArgs(["--model=x", "--max-image-dimension", "1024"]).maxImageDimension).toBe(1024);
    expect(parseArgs(["--model=x", "--max-image-dimension=512"]).maxImageDimension).toBe(512);
    for (const value of ["0", "-1", "1.5", "2049", "NaN", "Infinity"]) {
      expect(() => parseArgs(["--model=x", `--max-image-dimension=${value}`])).toThrow("must be an integer between");
    }
    expect(() => parseArgs(["--model=x", "--max-image-dimension"])).toThrow("requires a value");
  });

  it("parses reasoning effort", () => {
    expect(parseArgs(["--model", "vision-model", "--reasoning-effort", "none"])).toMatchObject({
      model: "vision-model",
      reasoningEffort: "none",
    });
    expect(parseArgs(["--model=vision-model", "--reasoning-effort=low"])).toMatchObject({
      model: "vision-model",
      reasoningEffort: "low",
    });
  });

  it("documents reasoning effort values in help text", () => {
    expect(HELP).toContain("--reasoning-effort <value>");
    expect(HELP).toContain("none|low|medium|high");
  });

  it("preserves empty equals-value flag behavior", () => {
    expect(() => parseArgs(["--model=x", "--limit="])).toThrow(
      "--limit must be a positive integer, got ",
    );
    expect(() => parseArgs(["--model="])).toThrow("--model is required");
    expect(parseArgs(["--model=x", "--source="])).toMatchObject({
      model: "x",
      source: "",
    });
  });
});

describe("describe-attachments CLI", () => {
  it("prints a dry-run summary after listing candidates", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "timeline-describe-attachments-"));
    const dbPath = join(workDir, "timeline.db");
    const db = new Database(dbPath);
    try {
      initDb(db);
      const event = db.prepare(`
        INSERT INTO events (
          source, source_id, source_account, type, timestamp,
          title, content, raw_data, conversation_id
        ) VALUES ('test', 'event-1', 'account', 'message:dm', '2026-01-01T00:00:00Z', 'chat', '', '{}', 'conversation-1')
      `).run();
      db.prepare(`
        INSERT INTO attachments (
          event_id, source, source_id, content_hash, filename,
          mime_type, storage_path, status
        ) VALUES (?, 'test', 'attachment-1', 'candidate-hash', 'image.png', 'image/png', 'test/image.png', 'stored')
      `).run(event.lastInsertRowid);
      db.close();

      const proc = Bun.spawn(
        [process.execPath, "run", "src/scripts/describe-attachments.ts", "--model", "x", "--dry-run"],
        {
          cwd: process.cwd(),
          env: { ...process.env, TIMELINE_DB_PATH: dbPath },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);
      expect(stderr).toBe("");
      expect(stdout.trimEnd()).toEndWith("summary: described=0 skipped=1 failed=0");
    } finally {
      db.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("generateAttachmentDescription", () => {
  it("sends the resized image to the provider for a custom limit", async () => {
    const image = await sharp({
      create: { width: 1472, height: 1994, channels: 3, background: "white" },
    }).png().toBuffer();
    const body = await captureDescriptionRequest(undefined, image, 1024);
    const messages = body.messages as Array<{ content: Array<{ image_url?: { url: string } }> }>;
    const url = messages[0]?.content[1]?.image_url?.url;
    expect(url).toStartWith("data:image/png;base64,");
    const sent = Buffer.from(url!.split(",")[1]!, "base64");
    expect(await sharp(sent).metadata()).toMatchObject({ width: 756, height: 1024 });
  });

  it("sends the image file as an OpenAI-compatible image URL", async () => {
    const body = await captureDescriptionRequest();
    const messages = body.messages;
    if (!Array.isArray(messages)) throw new Error("Expected request messages");
    const [message] = messages;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error("Expected a request message");
    }
    const content = message.content;
    if (!Array.isArray(content)) throw new Error("Expected request message content");

    expect(content[1]).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${TEST_IMAGE.toString("base64")}` },
    });
  });

  it("passes reasoning effort through to the OpenAI-compatible request body", async () => {
    const body = await captureDescriptionRequest("none");
    expect(body.reasoning_effort).toBe("none");
  });

  it("omits reasoning_effort from the request body when unset", async () => {
    const body = await captureDescriptionRequest();
    expect("reasoning_effort" in body).toBe(false);
  });
});

describe("selectAttachmentsToDescribe", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  function seedEvent(sourceId: string): number {
    const result = db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, timestamp,
        title, content, raw_data, conversation_id
      )
      VALUES ('test', ?, 'account', 'message:dm', '2026-01-01T00:00:00Z', 'chat', '', '{}', 'conversation-1')
    `).run(sourceId);
    return Number(result.lastInsertRowid);
  }

  function seedAttachment(values: {
    eventId: number;
    source: string;
    sourceId: string;
    hash: string;
    mimeType: string;
    status?: string;
  }): void {
    db.prepare(`
      INSERT INTO attachments (
        event_id, source, source_id, content_hash, filename,
        mime_type, storage_path, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      values.eventId,
      values.source,
      values.sourceId,
      values.hash,
      `${values.sourceId}.png`,
      values.mimeType,
      `${values.source}/${values.sourceId}.png`,
      values.status ?? "stored",
    );
  }

  it("dedupes by content hash and reselects hashes described only by another model", () => {
    const first = seedEvent("first");
    const second = seedEvent("second");
    const third = seedEvent("third");
    const fourth = seedEvent("fourth");

    seedAttachment({ eventId: first, source: "discord", sourceId: "a1", hash: "hash-shared", mimeType: "image/png" });
    seedAttachment({ eventId: second, source: "discord", sourceId: "a2", hash: "hash-shared", mimeType: "image/png" });
    seedAttachment({ eventId: third, source: "facebook", sourceId: "a3", hash: "hash-facebook", mimeType: "image/jpeg" });
    seedAttachment({ eventId: fourth, source: "discord", sourceId: "a4", hash: "hash-other-model", mimeType: "image/png" });
    seedAttachment({ eventId: fourth, source: "discord", sourceId: "a5", hash: "hash-described", mimeType: "image/png" });
    seedAttachment({ eventId: fourth, source: "discord", sourceId: "a6", hash: "hash-pending", mimeType: "image/png", status: "pending" });
    seedAttachment({ eventId: fourth, source: "discord", sourceId: "a7", hash: "hash-file", mimeType: "application/pdf" });

    db.prepare(
      `INSERT INTO attachment_descriptions (content_hash, model, description)
       VALUES (?, ?, ?)`,
    ).run("hash-described", "model-x", "Already described.");
    db.prepare(
      `INSERT INTO attachment_descriptions (content_hash, model, description)
       VALUES (?, ?, ?)`,
    ).run("hash-other-model", "model-y", "Described by another model.");

    const all = selectAttachmentsToDescribe(db, { model: "model-x" });
    expect(all.map((row) => row.content_hash)).toEqual([
      "hash-shared",
      "hash-facebook",
      "hash-other-model",
    ]);

    const limited = selectAttachmentsToDescribe(db, { model: "model-x", limit: 2 });
    expect(limited.map((row) => row.content_hash)).toEqual(["hash-shared", "hash-facebook"]);

    const facebook = selectAttachmentsToDescribe(db, { model: "model-x", source: "facebook" });
    expect(facebook.map((row) => row.content_hash)).toEqual(["hash-facebook"]);
  });

  it("processes newest attachments first with --newest", () => {
    const first = seedEvent("first");
    const second = seedEvent("second");
    const third = seedEvent("third");
    const fourth = seedEvent("fourth");

    seedAttachment({ eventId: first, source: "discord", sourceId: "a1", hash: "hash-shared", mimeType: "image/png" });
    seedAttachment({ eventId: second, source: "discord", sourceId: "a2", hash: "hash-middle", mimeType: "image/png" });
    seedAttachment({ eventId: third, source: "discord", sourceId: "a3", hash: "hash-newest", mimeType: "image/png" });
    seedAttachment({ eventId: fourth, source: "discord", sourceId: "a4", hash: "hash-shared", mimeType: "image/png" });

    const newest = selectAttachmentsToDescribe(db, { model: "model-x", newest: true });
    expect(newest.map((row) => row.content_hash)).toEqual([
      "hash-shared",
      "hash-newest",
      "hash-middle",
    ]);

    const limited = selectAttachmentsToDescribe(db, { model: "model-x", newest: true, limit: 1 });
    expect(limited.map((row) => row.content_hash)).toEqual(["hash-shared"]);

    expect(parseArgs(["--model", "vision-model", "--newest"])).toMatchObject({
      model: "vision-model",
      newest: true,
    });
  });

  it("excludes noisy machine screenshots by default but permits explicit selection", () => {
    for (const source of NOISY_MACHINE_SOURCES) {
      const eventId = seedEvent(source);
      seedAttachment({
        eventId,
        source,
        sourceId: `${source}-image`,
        hash: `hash-${source}`,
        mimeType: source === "recall" ? "image/webp" : "image/png",
      });
    }
    const discord = seedEvent("discord");

    seedAttachment({ eventId: discord, source: "discord", sourceId: "photo", hash: "hash-discord", mimeType: "image/png" });

    expect(selectAttachmentsToDescribe(db, { model: "model-x" }).map((row) => row.content_hash)).toEqual([
      "hash-discord",
    ]);
    expect(
      selectAttachmentsToDescribe(db, { model: "model-x", source: "t3code" }).map(
        (row) => row.content_hash,
      ),
    ).toEqual(["hash-t3code"]);
    expect(countNeedingDescriptions(db)).toBe(1);

    const manuallyEligible = db.prepare(`
      SELECT content_hash
      FROM attachments a
      WHERE ${attachmentDescriptionEligibilityFilters("a").join(" AND ")}
      ORDER BY id
    `).all() as Array<{ content_hash: string }>;
    expect(manuallyEligible.map((row) => row.content_hash)).toEqual([
      ...NOISY_MACHINE_SOURCES.map((source) => `hash-${source}`),
      "hash-discord",
    ]);
  });
});

describe("describeAttachments", () => {
  it("applies the run's image limit and writes the generation duration", async () => {
    const db = new Database(":memory:");
    initDb(db);
    const image = await sharp({
      create: { width: 1472, height: 1994, channels: 3, background: "white" },
    }).png().toBuffer();
    let sentImage: Buffer | undefined;
    const fetchImpl: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const body = JSON.parse(init?.body as string);
        const url: string = body.messages[0].content[1].image_url.url;
        sentImage = Buffer.from(url.split(",")[1]!, "base64");
        return new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            created: 0,
            model: "vision-model",
            choices: [{ message: { role: "assistant", content: "A small image." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      { preconnect: (() => {}) as typeof fetch.preconnect },
    );
    const provider = createOpenAICompatible({
      name: "test",
      baseURL: "http://example.test/v1",
      fetch: fetchImpl,
    });
    try {
      const stats = await describeAttachments({
        db,
        mediaStore: {
          readFile: async () => ({ content: image }),
          restoreFromRemote: async () => null,
        } as unknown as Awaited<ReturnType<typeof import("../media/storage").getMediaStore>>,
        languageModel: provider("vision-model"),
        modelRef: "model-x",
        maxImageDimension: 1024,
        candidates: [
          { content_hash: "one", source: "test", filename: null, storage_path: "one.png", mime_type: "image/png" },
        ],
      });
      expect(stats.described).toBe(1);
      expect(sentImage).toBeDefined();
      expect(await sharp(sentImage!).metadata()).toMatchObject({ width: 756, height: 1024 });
      const row = db.prepare(`
        SELECT description, duration_ms FROM attachment_descriptions WHERE content_hash = 'one' AND model = 'model-x'
      `).get() as { description: string; duration_ms: number };
      expect(row.description).toBe("A small image.");
      expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
    }
  });

  it("exits cleanly before a passed deadline", async () => {
    const db = new Database(":memory:");
    initDb(db);
    try {
      const stats = await describeAttachments({
        db,
        mediaStore: {} as Awaited<ReturnType<typeof import("../media/storage").getMediaStore>>,
        languageModel: {} as never,
        modelRef: "model-x",
        candidates: [
          { content_hash: "one", source: "test", filename: null, storage_path: "one.png", mime_type: "image/png" },
          { content_hash: "two", source: "test", filename: null, storage_path: "two.png", mime_type: "image/png" },
        ],
        deadline: Date.now() - 1,
      });
      expect(stats).toEqual({
        described: 0,
        skipped: 0,
        failed: 0,
        remaining: 2,
        stoppedReason: "time-budget",
        failureSamples: [],
      });
    } finally {
      db.close();
    }
  });

  it("aborts a hanging generation when the deadline expires", async () => {
    const db = new Database(":memory:");
    initDb(db);
    const fetchImpl: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Expected an abort signal");
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      { preconnect: (() => {}) as typeof fetch.preconnect },
    );
    const provider = createOpenAICompatible({
      name: "test",
      baseURL: "http://example.test/v1",
      fetch: fetchImpl,
    });
    try {
      const started = Date.now();
      const stats = await describeAttachments({
        db,
        mediaStore: {
          readFile: async () => ({ content: TEST_IMAGE }),
          restoreFromRemote: async () => null,
        } as unknown as Awaited<ReturnType<typeof import("../media/storage").getMediaStore>>,
        languageModel: provider("vision-model"),
        modelRef: "model-x",
        candidates: [
          { content_hash: "one", source: "test", filename: null, storage_path: "one.png", mime_type: "image/png" },
          { content_hash: "two", source: "test", filename: null, storage_path: "two.png", mime_type: "image/png" },
        ],
        deadline: Date.now() + 25,
      });
      expect(stats).toMatchObject({
        described: 0,
        skipped: 0,
        failed: 0,
        remaining: 2,
        stoppedReason: "time-budget",
        failureSamples: [],
      });
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      db.close();
    }
  });

  it("treats a deadline during retry backoff as a clean time-budget stop", async () => {
    const db = new Database(":memory:");
    initDb(db);
    const fetchImpl: typeof fetch = Object.assign(
      async () => new Response(
        JSON.stringify({ error: { message: "retry later" } }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
      { preconnect: (() => {}) as typeof fetch.preconnect },
    );
    const provider = createOpenAICompatible({
      name: "test",
      baseURL: "http://example.test/v1",
      fetch: fetchImpl,
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const stats = await describeAttachments({
        db,
        mediaStore: {
          readFile: async () => ({ content: TEST_IMAGE }),
          restoreFromRemote: async () => null,
        } as unknown as Awaited<ReturnType<typeof import("../media/storage").getMediaStore>>,
        languageModel: provider("vision-model"),
        modelRef: "model-x",
        candidates: [
          { content_hash: "one", source: "test", filename: null, storage_path: "one.png", mime_type: "image/png" },
        ],
        deadline: Date.now() + 25,
      });

      expect(stats).toMatchObject({
        described: 0,
        skipped: 0,
        failed: 0,
        remaining: 1,
        stoppedReason: "time-budget",
        failureSamples: [],
      });
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      db.close();
    }
  });

  it("does not count external cancellation as a model failure or a time-budget stop", async () => {
    const db = new Database(":memory:");
    initDb(db);
    const fetchImpl: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Expected an abort signal");
        return await new Promise<Response>((_resolve, reject) => {
          // The external abort can land before fetch is invoked on a loaded
          // runner; addEventListener never fires for an already-aborted signal,
          // so handle that case explicitly or the promise hangs to the timeout.
          const rejectAfterAbort = () => setTimeout(() => reject(signal.reason), 30);
          if (signal.aborted) {
            rejectAfterAbort();
            return;
          }
          signal.addEventListener("abort", rejectAfterAbort, { once: true });
        });
      },
      { preconnect: (() => {}) as typeof fetch.preconnect },
    );
    const provider = createOpenAICompatible({
      name: "test",
      baseURL: "http://example.test/v1",
      fetch: fetchImpl,
    });
    const controller = new AbortController();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      setTimeout(() => controller.abort(new DOMException("External abort", "AbortError")), 5);
      const stats = await describeAttachments({
        db,
        mediaStore: {
          readFile: async () => ({ content: TEST_IMAGE }),
          restoreFromRemote: async () => null,
        } as unknown as Awaited<ReturnType<typeof import("../media/storage").getMediaStore>>,
        languageModel: provider("vision-model"),
        modelRef: "model-x",
        candidates: [
          { content_hash: "one", source: "test", filename: null, storage_path: "one.png", mime_type: "image/png" },
        ],
        signal: controller.signal,
        deadline: Date.now() + 20,
      });

      expect(stats).toMatchObject({
        described: 0,
        skipped: 0,
        failed: 0,
        remaining: 1,
        failureSamples: [],
      });
      expect(stats.stoppedReason).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
      db.close();
    }
  });

  it("keeps bounded failure samples and logs concise errors", async () => {
    const db = new Database(":memory:");
    initDb(db);
    const fetchImpl: typeof fetch = Object.assign(
      async () => new Response(
        JSON.stringify({ error: { message: "image request rejected" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
      { preconnect: (() => {}) as typeof fetch.preconnect },
    );
    const provider = createOpenAICompatible({
      name: "test",
      baseURL: "http://example.test/v1",
      fetch: fetchImpl,
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const candidateCount = ATTACHMENT_DESCRIPTION_FAILURE_SAMPLE_LIMIT + 1;
      const stats = await describeAttachments({
        db,
        mediaStore: {
          readFile: async () => ({ content: TEST_IMAGE }),
          restoreFromRemote: async () => null,
        } as unknown as Awaited<ReturnType<typeof import("../media/storage").getMediaStore>>,
        languageModel: provider("vision-model"),
        modelRef: "model-x",
        candidates: Array.from({ length: candidateCount }, (_, index) => ({
          content_hash: `hash-${index}`,
          source: "test",
          filename: `image-${index}.png`,
          storage_path: `image-${index}.png`,
          mime_type: "image/png",
        })),
      });

      expect(stats).toMatchObject({
        failed: 5,
        remaining: candidateCount - 5,
        stoppedReason: "consecutive-failures",
      });
      expect(stats.failureSamples).toHaveLength(5);
      expect(stats.failureSamples?.[0]).toMatchObject({
        contentHash: "hash-0",
        source: "test",
        filename: "image-0.png",
        error: { message: "image request rejected" },
      });
      expect(errorSpy).toHaveBeenCalledTimes(5);
      expect(errorSpy.mock.calls[0]).toHaveLength(1);
      expect(errorSpy.mock.calls[0]?.[0]).toContain("image request rejected");
    } finally {
      errorSpy.mockRestore();
      db.close();
    }
  });

  it("stops immediately when the model backend is unavailable", async () => {
    const db = new Database(":memory:");
    initDb(db);
    let requests = 0;
    const fetchImpl: typeof fetch = Object.assign(
      async () => {
        requests++;
        return new Response(
          JSON.stringify({ error: { message: "No models are currently loaded" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
      { preconnect: (() => {}) as typeof fetch.preconnect },
    );
    const provider = createOpenAICompatible({
      name: "test",
      baseURL: "http://example.test/v1",
      fetch: fetchImpl,
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const stats = await describeAttachments({
        db,
        mediaStore: {
          readFile: async () => ({ content: TEST_IMAGE }),
          restoreFromRemote: async () => null,
        } as unknown as Awaited<ReturnType<typeof import("../media/storage").getMediaStore>>,
        languageModel: provider("vision-model"),
        modelRef: "model-x",
        candidates: Array.from({ length: 3 }, (_, index) => ({
          content_hash: `hash-${index}`,
          source: "test",
          filename: `image-${index}.png`,
          storage_path: `image-${index}.png`,
          mime_type: "image/png",
        })),
      });

      expect(requests).toBe(1);
      expect(stats).toMatchObject({
        described: 0,
        failed: 1,
        remaining: 2,
        stoppedReason: "model-unavailable",
      });
    } finally {
      errorSpy.mockRestore();
      db.close();
    }
  });

  it("stops immediately when retries wrap a connection refusal", async () => {
    const db = new Database(":memory:");
    initDb(db);
    const connectionError = new TypeError("fetch failed", {
      cause: Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" }),
    });
    const retryError = new RetryError({
      message: "Failed after 3 attempts. Last error: fetch failed",
      reason: "maxRetriesExceeded",
      errors: [connectionError, connectionError, connectionError],
    });
    const fetchImpl: typeof fetch = Object.assign(
      async () => {
        throw retryError;
      },
      { preconnect: (() => {}) as typeof fetch.preconnect },
    );
    const provider = createOpenAICompatible({
      name: "test",
      baseURL: "http://example.test/v1",
      fetch: fetchImpl,
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const stats = await describeAttachments({
        db,
        mediaStore: {
          readFile: async () => ({ content: TEST_IMAGE }),
          restoreFromRemote: async () => null,
        } as unknown as Awaited<ReturnType<typeof import("../media/storage").getMediaStore>>,
        languageModel: provider("vision-model"),
        modelRef: "model-x",
        candidates: Array.from({ length: 3 }, (_, index) => ({
          content_hash: `hash-${index}`,
          source: "test",
          filename: `image-${index}.png`,
          storage_path: `image-${index}.png`,
          mime_type: "image/png",
        })),
      });

      expect(stats).toMatchObject({
        described: 0,
        failed: 1,
        remaining: 2,
        stoppedReason: "model-unavailable",
      });
    } finally {
      errorSpy.mockRestore();
      db.close();
    }
  });

  it("resets the consecutive failure breaker after a success", async () => {
    const db = new Database(":memory:");
    initDb(db);
    let requests = 0;
    const fetchImpl: typeof fetch = Object.assign(
      async () => {
        requests++;
        if (requests === 5) {
          return new Response(
            JSON.stringify({
              id: "chatcmpl-test",
              created: 0,
              model: "vision-model",
              choices: [{ message: { role: "assistant", content: "A recovered image." }, finish_reason: "stop" }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ error: { message: "image request rejected" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
      { preconnect: (() => {}) as typeof fetch.preconnect },
    );
    const provider = createOpenAICompatible({
      name: "test",
      baseURL: "http://example.test/v1",
      fetch: fetchImpl,
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const stats = await describeAttachments({
        db,
        mediaStore: {
          readFile: async () => ({ content: TEST_IMAGE }),
          restoreFromRemote: async () => null,
        } as unknown as Awaited<ReturnType<typeof import("../media/storage").getMediaStore>>,
        languageModel: provider("vision-model"),
        modelRef: "model-x",
        candidates: Array.from({ length: 9 }, (_, index) => ({
          content_hash: `hash-${index}`,
          source: "test",
          filename: `image-${index}.png`,
          storage_path: `image-${index}.png`,
          mime_type: "image/png",
        })),
      });

      expect(requests).toBe(9);
      expect(stats).toMatchObject({ described: 1, failed: 8, remaining: 0 });
      expect(stats.stoppedReason).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
      db.close();
    }
  });
});
