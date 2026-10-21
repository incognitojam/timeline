import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import sharp from "sharp";
import { loadConfig } from "../../config";
import { getAppStateDb } from "../../db/app-state";
import { Scheduler } from "../../scheduler";
import * as schema from "../../db/schema";
import * as llm from "../../llm";
import * as storage from "../../media/storage";
import { LocalWorkGate } from "../../jobs/local-work";
import { initDb } from "../../db/schema";
import { countNeedingDescriptions } from "../../media/describe-attachments";
import {
  type AttachmentDescriptionsSettings,
  attachmentDescriptionAllUnavailableFailure,
  attachmentDescriptionNotVisionResult,
  attachmentDescriptionSyncResult,
  attachmentDescriptionsSyncSource,
  DEFAULT_ATTACHMENT_DESCRIPTION_SELECTION_LIMIT,
  DEFAULT_ATTACHMENT_DESCRIPTION_TIME_BUDGET_MS,
  getConfiguredAttachmentDescriptionModels,
  parseAttachmentDescriptionsSettings,
  selectAttachmentDescriptionModel,
  selectAttachmentsForDescriptionRun,
} from "./attachment-descriptions";

describe("attachmentDescriptionsSyncSource", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initDb(db);
  });

  afterEach(() => db.close());

  function seedCandidates(count: number): void {
    const event = db.prepare(`
      INSERT INTO events (
        source, source_id, source_account, type, timestamp,
        title, content, raw_data, conversation_id
      ) VALUES ('test', 'event-1', 'account', 'message:dm', '2026-01-01T00:00:00Z', 'chat', '', '{}', 'conversation-1')
    `).run();
    const insert = db.prepare(`
      INSERT INTO attachments (
        event_id, source, source_id, content_hash, filename,
        mime_type, storage_path, status
      ) VALUES (?, 'test', ?, ?, ?, 'image/png', ?, 'stored')
    `);
    for (let index = 0; index < count; index++) {
      insert.run(
        event.lastInsertRowid,
        `attachment-${index}`,
        `hash-${index}`,
        `image-${index}.png`,
        `test/image-${index}.png`,
      );
    }
  }

  const settings: AttachmentDescriptionsSettings = {
    models: ["local/model"],
    timeBudgetMs: 300_000,
  };

  for (const scenario of ["normal", "initial-wait", "cancel-after-progress"] as const) {
    it(`guards source phases and preserves progress: ${scenario}`, async () => {
      seedCandidates(3);
      const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
      const gate = new LocalWorkGate();
      const controller = new AbortController();
      const releaseInitial = Promise.withResolvers<void>();
      const initialWork = scenario === "initial-wait" ? gate.run(() => releaseInitial.promise) : Promise.resolve();
      const startedAt = Date.now();
      const clock = scenario === "initial-wait" ? spyOn(Date, "now").mockReturnValue(startedAt) : undefined;
      const run = gate.run.bind(gate);
      let ownsLocalWork = false;
      const workSpy = spyOn(gate, "run").mockImplementation((work, signal) => run(async () => {
        ownsLocalWork = true;
        try { return await work(); }
        finally { ownsLocalWork = false; }
      }, signal));
      const prepare = db.prepare.bind(db);
      const query = db.query.bind(db);
      const prepareSpy = spyOn(db, "prepare").mockImplementation((...args) => {
        expect(ownsLocalWork).toBe(true);
        return prepare(...args);
      });
      const querySpy = spyOn(db, "query").mockImplementation((...args) => {
        expect(ownsLocalWork).toBe(true);
        return query(...args);
      });
      // Keep the fixture connection open for the test's normal afterEach cleanup.
      const closeSpy = spyOn(db, "close").mockImplementation(() => {});
      const getDbSpy = spyOn(schema, "getDb").mockImplementation(() => {
        expect(ownsLocalWork).toBe(true);
        return db;
      });
      const availability = spyOn(llm, "getVisionAvailability").mockResolvedValue("available");
      const providers = spyOn(llm, "initProviders").mockResolvedValue();
      const ordinaryProgress: number[] = [];
      let generated = 0;
      const model = new MockLanguageModelV3({
        doGenerate: async () => {
          expect(ownsLocalWork).toBe(false);
          generated++;
          await gate.run(() => { ordinaryProgress.push(generated); });
          if (scenario === "cancel-after-progress" && generated === 2) controller.abort(new Error("Stopped"));
          return {
            content: [{ type: "text", text: "A white square." }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          };
        },
      });
      const resolveModel = spyOn(llm, "resolveLanguageModel").mockReturnValue(model);
      const media = spyOn(storage, "getMediaStore").mockResolvedValue({
        readFile: async () => {
          expect(ownsLocalWork).toBe(true);
          return { content: image };
        },
        restoreFromRemote: async () => null,
      } as unknown as Awaited<ReturnType<typeof storage.getMediaStore>>);
      const logSource = "scheduler-test-description-progress";
      try {
        const syncOptions = {
          verbose: false,
          config: { sources: { "attachment-descriptions": { models: ["vision"], limit: 3 } } },
          localWork: gate,
          signal: controller.signal,
        };
        let scheduler: Scheduler | undefined;
        if (scenario === "cancel-after-progress") {
          getAppStateDb().prepare("INSERT INTO sync_sources (source, enabled, interval, settings) VALUES (?, 1, '1h', '{}')").run(logSource);
          scheduler = new Scheduler(await loadConfig(), {
            syncSources: [{
              ...attachmentDescriptionsSyncSource,
              name: logSource,
              canSync: async () => null,
              sync: async (options) => ({ ...await attachmentDescriptionsSyncSource.sync({ ...syncOptions, signal: options.signal }), source: logSource }),
            }],
          });
        }
        const running = scheduler
          ? scheduler.runNow(logSource, undefined, controller.signal, "manual", gate)
          : attachmentDescriptionsSyncSource.sync(syncOptions);
        clock?.mockReturnValue(startedAt + DEFAULT_ATTACHMENT_DESCRIPTION_TIME_BUDGET_MS + 1);
        releaseInitial.resolve();
        const result = await running;
        if (scenario === "cancel-after-progress") {
          expect(result).toMatchObject({ success: false, eventsAdded: 1, error: "Stopped", metadata: { described: 1, failed: 0, model: "vision" } });
          expect(result.metadata).not.toHaveProperty("remainingQueueDepth");
          expect(ordinaryProgress).toEqual([1, 2]);
          const log = getAppStateDb().prepare("SELECT finished_at, events_added, metadata FROM sync_log WHERE source = ?").get(logSource) as { finished_at: string | null; events_added: number; metadata: string };
          expect(log.finished_at).not.toBeNull();
          expect(log.events_added).toBe(1);
          expect(JSON.parse(log.metadata)).toMatchObject({ described: 1, failed: 0 });
        } else {
          expect(result).toMatchObject({ success: true, eventsAdded: 3, metadata: { described: 3, remainingQueueDepth: 0, describedHashes: 3 } });
          expect(ordinaryProgress).toEqual([1, 2, 3]);
        }
        if (scenario === "initial-wait") expect(result.durationMs).toBeGreaterThan(DEFAULT_ATTACHMENT_DESCRIPTION_TIME_BUDGET_MS);
        expect(prepare("SELECT COUNT(*) AS count FROM attachment_descriptions").get()).toEqual({ count: result.eventsAdded });
        expect(getDbSpy).toHaveBeenCalledTimes(1);
        expect(prepareSpy).toHaveBeenCalled();
        expect(closeSpy).toHaveBeenCalledTimes(1);
      } finally {
        releaseInitial.resolve();
        await initialWork;
        clock?.mockRestore();
        for (const table of ["sync_log", "scheduler_state", "sync_sources"]) {
          getAppStateDb().prepare(`DELETE FROM ${table} WHERE source = ?`).run(logSource);
        }
        for (const spy of [workSpy, prepareSpy, querySpy, closeSpy, getDbSpy, availability, providers, resolveModel, media]) spy.mockRestore();
      }
    });
  }

  it("reports missing models without running", async () => {
    expect(await attachmentDescriptionsSyncSource.canSync({})).toBe("not configured: models is required");
  });

  it("exposes a required preference-ordered model list setting", () => {
    expect(attachmentDescriptionsSyncSource.configSchema).toContainEqual({
      key: "models",
      type: "string-list",
      label: "Models",
      description: "Language models in preference order; later entries are fallbacks",
      required: true,
    });
    expect(attachmentDescriptionsSyncSource.configSchema?.some((field) => field.key === "model")).toBe(false);
    expect(attachmentDescriptionsSyncSource.configSchema).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "time_budget_ms",
          default: DEFAULT_ATTACHMENT_DESCRIPTION_TIME_BUDGET_MS,
        }),
        expect.objectContaining({
          key: "limit",
          default: DEFAULT_ATTACHMENT_DESCRIPTION_SELECTION_LIMIT,
        }),
      ])
    );
  });

  it("accepts preferred models and falls back to the legacy model setting", () => {
    expect(parseAttachmentDescriptionsSettings({ models: ["preferred/model", "fallback/model"] })).toEqual({
      models: ["preferred/model", "fallback/model"],
      reasoningEffort: undefined,
      maxImageDimension: undefined,
      timeBudgetMs: 300_000,
      limit: undefined,
    });
    expect(parseAttachmentDescriptionsSettings({ model: "local/model" })).toMatchObject({
      models: ["local/model"],
    });
    expect(parseAttachmentDescriptionsSettings({ models: ["preferred/model"], model: "legacy/model" })).toMatchObject({
      models: ["preferred/model"],
    });
    expect(parseAttachmentDescriptionsSettings({ models: [], model: "legacy/model" })).toBe("invalid models setting");
    expect(parseAttachmentDescriptionsSettings({ models: [" "] })).toBe("invalid models setting");
    expect(parseAttachmentDescriptionsSettings({ model: "x", limit: 0 })).toBe("invalid limit setting");
  });

  it("accepts a smaller image limit and rejects invalid settings before syncing", async () => {
    expect(parseAttachmentDescriptionsSettings({ models: ["vision-model"], max_image_dimension: 1024 }))
      .toMatchObject({ maxImageDimension: 1024 });
    expect(attachmentDescriptionsSyncSource.configSchema).toContainEqual(expect.objectContaining({
      key: "max_image_dimension", type: "number", integer: true, min: 1, max: 2048, default: 2048,
    }));
    for (const value of [0, -1, 1.5, 2049, NaN, Infinity, "1024", null]) {
      expect(await attachmentDescriptionsSyncSource.canSync({ models: ["vision-model"], max_image_dimension: value }))
        .toBe("max_image_dimension must be an integer between 1 and 2048");
    }
  });

  it("reads the ordered model preference from sync source settings", () => {
    db.exec("CREATE TABLE sync_sources (source TEXT PRIMARY KEY, settings TEXT NOT NULL)");
    db.prepare(`
      INSERT INTO sync_sources (source, settings)
      VALUES ('attachment-descriptions', ?)
    `).run(JSON.stringify({ models: ["preferred/model", "fallback/model"] }));

    expect(getConfiguredAttachmentDescriptionModels(db)).toEqual(["preferred/model", "fallback/model"]);
  });

  it("chooses the first available or unknown model after unavailable and invalid candidates", async () => {
    const probed: string[] = [];
    const selection = await selectAttachmentDescriptionModel(
      { providers: {} },
      ["offline/model", "not-vision/model", "fallback/model", "later/model"],
      async (_config, model) => {
        probed.push(model);
        return {
          "offline/model": "unavailable",
          "not-vision/model": "not-vision",
          "fallback/model": "unknown",
          "later/model": "available",
        }[model] as "unavailable" | "not-vision" | "unknown" | "available";
      },
    );

    expect(probed).toEqual(["offline/model", "not-vision/model", "fallback/model"]);
    expect(selection).toEqual({
      status: "selected",
      model: "fallback/model",
      warnings: [
        {
          model: "not-vision/model",
          availability: "not-vision",
          message: "Configured model not-vision/model is not vision-capable",
        },
      ],
    });

    expect(await selectAttachmentDescriptionModel(
      { providers: {} },
      ["available/model"],
      async () => "available",
    )).toEqual({ status: "selected", model: "available/model", warnings: [] });
  });

  it("reports all-unavailable models as a failure and distinguishes invalid candidates", async () => {
    const unavailable = await selectAttachmentDescriptionModel(
      { providers: {} },
      ["offline/one", "offline/two"],
      async () => "unavailable",
    );
    expect(unavailable).toEqual({ status: "unavailable", warnings: [] });

    const notVision = await selectAttachmentDescriptionModel(
      { providers: {} },
      ["invalid/model", "offline/model"],
      async (_config, model) => model === "invalid/model" ? "not-vision" : "unavailable",
    );
    expect(notVision).toMatchObject({
      status: "not-vision",
      warnings: [{ model: "invalid/model", availability: "not-vision" }],
    });

    expect(attachmentDescriptionAllUnavailableFailure(["offline/one", "offline/two"], Date.now())).toMatchObject({
      success: false,
      error: "Configured attachment description models are unavailable: offline/one, offline/two",
    });
    expect(attachmentDescriptionNotVisionResult(
      notVision.warnings,
      Date.now(),
    )).toMatchObject({
      success: false,
      error: "No configured attachment description model is vision-capable: invalid/model",
      metadata: { modelWarnings: [{ model: "invalid/model", availability: "not-vision" }] },
    });
  });

  it("caps an unlimited selection while retaining the full queue depth in metadata", () => {
    seedCandidates(DEFAULT_ATTACHMENT_DESCRIPTION_SELECTION_LIMIT + 1);

    expect(selectAttachmentsForDescriptionRun(db, settings)).toHaveLength(
      DEFAULT_ATTACHMENT_DESCRIPTION_SELECTION_LIMIT,
    );
    expect(countNeedingDescriptions(db)).toBe(
      DEFAULT_ATTACHMENT_DESCRIPTION_SELECTION_LIMIT + 1,
    );

    const result = attachmentDescriptionSyncResult(
      db,
      settings,
      { described: 0, skipped: 0, failed: 0, remaining: 0 },
      Date.now(),
      "local/model",
      [],
    );
    expect(result.metadata).toMatchObject({
      remainingQueueDepth: DEFAULT_ATTACHMENT_DESCRIPTION_SELECTION_LIMIT + 1,
      descriptionEligibleHashes: DEFAULT_ATTACHMENT_DESCRIPTION_SELECTION_LIMIT + 1,
      describedHashes: 0,
    });
  });

  it("reports all failed attempts as a failed sync but keeps mixed results successful", () => {
    const allFailed = attachmentDescriptionSyncResult(
      db,
      settings,
      {
        described: 0,
        skipped: 0,
        failed: 1,
        remaining: 0,
        firstFailure: "model endpoint rejected the request",
      },
      Date.now(),
      "local/model",
      [],
    );
    expect(allFailed).toMatchObject({
      success: false,
      error: "All attachment description attempts failed: model endpoint rejected the request",
    });

    const mixed = attachmentDescriptionSyncResult(
      db,
      settings,
      {
        described: 1,
        skipped: 0,
        failed: 2,
        remaining: 0,
        firstFailure: "one request failed",
        failureSamples: [
          {
            contentHash: "hash-1",
            source: "test",
            filename: "image.png",
            durationMs: 250,
            error: { name: "Error", message: "one request failed" },
          },
        ],
      },
      Date.now(),
      "fallback/model",
      [
        {
          model: "preferred/model",
          availability: "not-vision",
          message: "Configured model preferred/model is not vision-capable",
        },
      ],
    );
    expect(mixed).toMatchObject({ success: true, eventsAdded: 1 });
    expect(mixed.metadata).toMatchObject({
      failed: 2,
      failureSamples: [
        {
          contentHash: "hash-1",
          error: { name: "Error", message: "one request failed" },
        },
      ],
      omittedFailureSamples: 1,
      model: "fallback/model",
      modelWarnings: [
        { model: "preferred/model", availability: "not-vision" },
      ],
    });
  });

  it("records a time-budget stop without reporting a failure", () => {
    const result = attachmentDescriptionSyncResult(
      db,
      settings,
      {
        described: 2,
        skipped: 0,
        failed: 0,
        remaining: 3,
        stoppedReason: "time-budget",
      },
      Date.now(),
      "local/model",
      [],
    );

    expect(result).toMatchObject({
      success: true,
      eventsAdded: 2,
      metadata: {
        failed: 0,
        model: "local/model",
        stoppedReason: "time-budget",
      },
    });
  });

  it("reports an unavailable model stop as a failed sync", () => {
    const result = attachmentDescriptionSyncResult(
      db,
      settings,
      {
        described: 2,
        skipped: 0,
        failed: 1,
        remaining: 3,
        firstFailure: "No models are currently loaded",
        stoppedReason: "model-unavailable",
      },
      Date.now(),
      "local/model",
      [],
    );

    expect(result).toMatchObject({
      success: false,
      eventsAdded: 2,
      error: "Attachment description model became unavailable: No models are currently loaded",
      metadata: { stoppedReason: "model-unavailable", remainingQueueDepth: 0 },
    });
  });

  it("reports a consecutive-failures stop as a failed sync after successes", () => {
    const result = attachmentDescriptionSyncResult(
      db,
      settings,
      {
        described: 2,
        skipped: 0,
        failed: 5,
        remaining: 3,
        firstFailure: "image request rejected",
        stoppedReason: "consecutive-failures",
      },
      Date.now(),
      "local/model",
      [],
    );

    expect(result).toMatchObject({
      success: false,
      eventsAdded: 2,
      error: "Attachment description stopped after consecutive failures: image request rejected",
      metadata: { stoppedReason: "consecutive-failures" },
    });
  });

  it("does not select a hash already described by another model", () => {
    seedCandidates(2);
    db.prepare(
      `INSERT INTO attachment_descriptions (content_hash, model, description) VALUES (?, ?, ?)`,
    ).run("hash-1", "other/model", "Already covered.");

    expect(selectAttachmentsForDescriptionRun(db, settings).map((candidate) => candidate.content_hash)).toEqual([
      "hash-0",
    ]);
  });
});
