import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import sharp from "sharp";
import { getAppStateDb } from "../db/app-state";
import { initDb } from "../db/schema";
import { describeAttachments, MAX_PENDING_ATTACHMENT_DESCRIPTIONS } from "../media/describe-attachments";
import type { getMediaStore } from "../media/storage";
import { LocalWorkGate } from "./local-work";
import { JobRunner } from "./runner";
import { enqueueJob, getJob } from "./store";

const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
const candidates = ["one", "two"].map((hash) => ({
  content_hash: hash, source: "test", filename: null, storage_path: `${hash}.png`, mime_type: "image/png",
}));
const mediaStore = {
  readUncached: async () => image,
} as unknown as Awaited<ReturnType<typeof getMediaStore>>;

function pendingModel() {
  const started = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<void>();
  let calls = 0;
  const fetchImpl: typeof fetch = Object.assign(async () => {
    calls++;
    started.resolve();
    // Deliberately ignores abort, to exercise the post-generation abort check.
    await answer.promise;
    return new Response(JSON.stringify({
      id: "test", created: 0, model: "vision",
      choices: [{ message: { role: "assistant", content: "A white square." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { headers: { "content-type": "application/json" } });
  }, { preconnect: (() => {}) as typeof fetch.preconnect });
  return {
    started, answer, calls: () => calls,
    model: createOpenAICompatible({ name: "test", baseURL: "http://example.test/v1", fetch: fetchImpl })("vision"),
  };
}

// Every job transition commits to disk, so progress takes as long as the
// machine's fsyncs do. The test timeout bounds a stall instead of a poll budget,
// and a poll left behind by a timed-out test stops when the test ends.
let testGeneration = 0;
async function waitFor(predicate: () => boolean): Promise<void> {
  const generation = testGeneration;
  for (;;) {
    // Checked before the predicate, which may already see the next test's rows.
    if (testGeneration !== generation) throw new Error("Test ended while waiting for progress");
    if (predicate()) return;
    await Bun.sleep(2);
  }
}

describe("scheduled inference overlap", () => {
  let directory: string;
  let descriptionDb: Database;
  let importDb: Database;

  beforeEach(() => {
    getAppStateDb().exec("DELETE FROM jobs");
    directory = mkdtempSync(join(tmpdir(), "inference-overlap-"));
    const path = join(directory, "timeline.db");
    descriptionDb = new Database(path);
    descriptionDb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 25");
    initDb(descriptionDb);
    importDb = new Database(path);
    importDb.exec("PRAGMA busy_timeout = 25");
  });

  afterEach(() => {
    testGeneration++;
    importDb.close();
    descriptionDb.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("stored duration excludes the wait to write", async () => {
    const model = pendingModel();
    const gate = new LocalWorkGate();
    const finishImport = Promise.withResolvers<void>();
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const read = spyOn(mediaStore, "readUncached").mockImplementation(async () => {
      now += 20;
      return image;
    });
    const running = describeAttachments({
      db: descriptionDb, mediaStore, languageModel: model.model, modelRef: "vision",
      candidates: candidates.slice(0, 1), localWork: gate,
    });
    let importer: Promise<void> | undefined;
    try {
      await model.started.promise;
      importer = gate.run(() => finishImport.promise);
      now += 80;
      const writeQueued = spyOn(gate, "run");
      model.answer.resolve();
      await waitFor(() => writeQueued.mock.calls.length > 0);
      writeQueued.mockRestore();
      expect(descriptionDb.prepare("SELECT * FROM attachment_descriptions").all()).toEqual([]);
      now += 180_000;
      finishImport.resolve();
      expect(await running).toMatchObject({ described: 1, failed: 0 });
      expect(descriptionDb.prepare("SELECT duration_ms FROM attachment_descriptions").get()).toEqual({ duration_ms: 100 });
    } finally {
      finishImport.resolve();
      model.answer.resolve();
      await Promise.all([importer, running]);
      for (const spy of [clock, read]) spy.mockRestore();
    }
  });

  test("images are read and described while an importer owns local work, then written together", async () => {
    const model = pendingModel();
    const gate = new LocalWorkGate();
    const finishImport = Promise.withResolvers<void>();
    const many = Array.from({ length: MAX_PENDING_ATTACHMENT_DESCRIPTIONS + 1 }, (_, index) => ({
      ...candidates[0], content_hash: `hash-${index}`,
    }));
    const running = describeAttachments({
      db: descriptionDb, mediaStore, languageModel: model.model, modelRef: "vision", candidates: many, localWork: gate,
    });
    let importer: Promise<void> | undefined;
    try {
      await model.started.promise;
      importer = gate.run(() => finishImport.promise);
      model.answer.resolve();
      // The queue is full: the next image waits for the write.
      await waitFor(() => model.calls() === MAX_PENDING_ATTACHMENT_DESCRIPTIONS);
      await Bun.sleep(20);
      expect(model.calls()).toBe(MAX_PENDING_ATTACHMENT_DESCRIPTIONS);
      expect(descriptionDb.prepare("SELECT * FROM attachment_descriptions").all()).toEqual([]);
      finishImport.resolve();
      expect(await running).toMatchObject({ described: many.length, failed: 0, remaining: 0 });
      expect(descriptionDb.prepare("SELECT COUNT(*) AS n FROM attachment_descriptions").get()).toEqual({ n: many.length });
    } finally {
      model.answer.resolve();
      finishImport.resolve();
      await Promise.all([importer, running]);
    }
  });

  test("a failed write fails every queued description and trips the failure breaker", async () => {
    const model = pendingModel();
    const gate = new LocalWorkGate();
    const finishImport = Promise.withResolvers<void>();
    const five = Array.from({ length: 5 }, (_, index) => ({ ...candidates[0], content_hash: `hash-${index}` }));
    descriptionDb.exec(`
      CREATE TRIGGER reject_descriptions BEFORE INSERT ON attachment_descriptions
      BEGIN SELECT RAISE(ABORT, 'disk is full'); END
    `);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const running = describeAttachments({
      db: descriptionDb, mediaStore, languageModel: model.model, modelRef: "vision", candidates: five, localWork: gate,
    });
    let importer: Promise<void> | undefined;
    try {
      await model.started.promise;
      importer = gate.run(() => finishImport.promise);
      model.answer.resolve();
      await waitFor(() => model.calls() === five.length);
      finishImport.resolve();
      const stats = await running;
      // All five were described before the one write that failed them.
      expect(stats).toMatchObject({ described: 0, failed: 5, firstFailure: "disk is full", stoppedReason: "consecutive-failures" });
      expect(stats.failureSamples?.map((sample) => sample.contentHash)).toEqual(five.map((candidate) => candidate.content_hash));
    } finally {
      errors.mockRestore();
      model.answer.resolve();
      finishImport.resolve();
      await Promise.all([importer, running]);
    }
  });

  test("a description waiting to be written still separates the failures around it", async () => {
    const gate = new LocalWorkGate();
    const finishImport = Promise.withResolvers<void>();
    let requests = 0;
    const fetchImpl: typeof fetch = Object.assign(async () => {
      requests++;
      return requests === 5
        ? new Response(JSON.stringify({
          id: "test", created: 0, model: "vision",
          choices: [{ message: { role: "assistant", content: "A white square." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { message: "image request rejected" } }), { status: 400, headers: { "content-type": "application/json" } });
    }, { preconnect: (() => {}) as typeof fetch.preconnect });
    const nine = Array.from({ length: 9 }, (_, index) => ({ ...candidates[0], content_hash: `hash-${index}` }));
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const prepared = spyOn(descriptionDb, "prepare");
    const running = describeAttachments({
      db: descriptionDb, mediaStore, modelRef: "vision", candidates: nine, localWork: gate,
      languageModel: createOpenAICompatible({ name: "test", baseURL: "http://example.test/v1", fetch: fetchImpl })("vision"),
    });
    let importer: Promise<void> | undefined;
    try {
      // Take local work once the run has prepared its statement, before any write.
      await waitFor(() => prepared.mock.calls.length > 0);
      importer = gate.run(() => finishImport.promise);
      await waitFor(() => requests === nine.length);
      expect(descriptionDb.query("SELECT COUNT(*) AS n FROM attachment_descriptions").get()).toEqual({ n: 0 });
      finishImport.resolve();
      const stats = await running;
      expect(stats).toMatchObject({ described: 1, failed: 8, remaining: 0 });
      expect(stats.stoppedReason).toBeUndefined();
    } finally {
      for (const spy of [errors, prepared]) spy.mockRestore();
      finishImport.resolve();
      await Promise.all([importer, running]);
    }
  });

  for (const expireBudget of [false, true]) {
    test(`an import commits before description persistence without starving it (expired budget: ${expireBudget})`, async () => {
      const model = pendingModel();
      const importStarted = Promise.withResolvers<void>();
      const finishImport = Promise.withResolvers<void>();
      let localWork: LocalWorkGate | undefined;
      const deadline = Date.now() + 60_000;
      const observedDescriptions: number[] = [];
      const runner = new JobRunner({
        overlapSyncSource: "vision", pollIdleMs: 1, pollActiveMs: 1,
        handlers: {
          sync: async (job, signal, gate) => {
            if (job.source === "vision") {
              localWork = gate;
              const stats = await describeAttachments({
                db: descriptionDb, mediaStore, languageModel: model.model, modelRef: "vision",
                candidates: expireBudget ? candidates : candidates.slice(0, 1), deadline, signal, localWork: gate,
              });
              return { ...stats };
            }
            if (job.source === "import") {
              // A prepared description statement must not hold a read cursor
              // across inference and prevent ordinary backup operations.
              expect(importDb.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 });
              importDb.prepare("VACUUM INTO ?").run(join(directory, "backup.db"));
              importDb.exec("BEGIN IMMEDIATE");
              try {
                importDb.prepare("INSERT INTO attachment_descriptions (content_hash, model, description) VALUES ('imported', 'text', 'Imported text')").run();
                importStarted.resolve();
                await finishImport.promise;
                importDb.exec("COMMIT");
              } catch (error) {
                importDb.exec("ROLLBACK");
                throw error;
              }
            } else {
              const row = importDb.prepare("SELECT COUNT(*) AS n FROM attachment_descriptions WHERE model = 'vision'").get() as { n: number };
              observedDescriptions.push(row.n);
            }
          },
        },
      });
      const description = enqueueJob({ kind: "sync", source: "vision", dedupeKey: "sync:vision" });
      runner.start();
      let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;
      let requests: ReturnType<typeof spyOn<LocalWorkGate, "run">> | undefined;
      try {
        await model.started.promise;
        const importer = enqueueJob({ kind: "sync", source: "import" });
        await importStarted.promise;
        // The next ordinary job has high priority, but cannot jump an already
        // waiting description's local-work request after the import commits.
        const next = enqueueJob({ kind: "sync", source: "next", priority: 100 });
        if (!localWork) throw new Error("No local-work guard received");
        requests = spyOn(localWork, "run");
        // The budget ends once the first image is described and queued.
        if (expireBudget) clock = spyOn(Date, "now").mockReturnValue(deadline + 1);
        model.answer.resolve();
        await waitFor(() => (requests?.mock.calls.length ?? 0) > 0);
        expect(getJob(description.jobId)?.status).toBe("running");
        expect(getJob(importer.jobId)?.status).toBe("running");
        expect(descriptionDb.prepare("SELECT * FROM attachment_descriptions WHERE content_hash = 'one'").get()).toBeNull();
        finishImport.resolve();
        await waitFor(() => getJob(next.jobId)?.status === "succeeded" && getJob(description.jobId)?.status === "succeeded");
        expect(getJob(importer.jobId)?.status).toBe("succeeded");
        expect(getJob(description.jobId)?.result).toMatchObject({ described: 1, failed: 0 });
        expect(observedDescriptions).toEqual([1]);
        expect(model.calls()).toBe(1);
        if (expireBudget) expect(getJob(description.jobId)?.result).toMatchObject({ remaining: 1, stoppedReason: "time-budget" });
      } finally {
        clock?.mockRestore();
        requests?.mockRestore();
        model.answer.resolve();
        finishImport.resolve();
        await runner.stop(1000);
      }
    });
  }

  test("cancellation during inference writes nothing and is not a model failure", async () => {
    const model = pendingModel();
    const controller = new AbortController();
    const describing = describeAttachments({
      db: descriptionDb, mediaStore, languageModel: model.model, modelRef: "vision",
      candidates, signal: controller.signal, localWork: new LocalWorkGate(),
    });
    try {
      await model.started.promise;
      controller.abort();
      model.answer.resolve();
      expect(await describing).toMatchObject({ described: 0, failed: 0, remaining: 2, failureSamples: [] });
      expect(descriptionDb.prepare("SELECT * FROM attachment_descriptions").all()).toEqual([]);
      expect(model.calls()).toBe(1);
    } finally {
      model.answer.resolve();
      await describing;
    }
  });

  test("cancellation while a description waits to be written still writes it", async () => {
    const model = pendingModel();
    const localWork = new LocalWorkGate();
    const controller = new AbortController();
    const finishImport = Promise.withResolvers<void>();
    const describing = describeAttachments({
      db: descriptionDb, mediaStore, languageModel: model.model, modelRef: "vision",
      candidates: candidates.slice(0, 1), signal: controller.signal, localWork,
    });
    let importer: Promise<void> | undefined;
    try {
      await model.started.promise;
      importer = localWork.run(() => finishImport.promise);
      const writeQueued = spyOn(localWork, "run");
      model.answer.resolve();
      await waitFor(() => writeQueued.mock.calls.length > 0);
      writeQueued.mockRestore();
      controller.abort();
      // The importer still owns local work, so nothing is written under it.
      await Bun.sleep(10);
      expect(descriptionDb.prepare("SELECT * FROM attachment_descriptions").all()).toEqual([]);
      finishImport.resolve();
      expect(await describing).toMatchObject({ described: 1, failed: 0, failureSamples: [] });
      expect(descriptionDb.prepare("SELECT content_hash FROM attachment_descriptions").all()).toEqual([{ content_hash: "one" }]);
    } finally {
      model.answer.resolve();
      finishImport.resolve();
      await Promise.all([importer, describing]);
    }
  });

  test("stop preserves both active jobs and their follow-ups without admitting extra work", async () => {
    let restarted = false;
    const started: number[] = [];
    const completed: number[] = [];
    const runner = new JobRunner({
      overlapSyncSource: "vision", pollIdleMs: 1, pollActiveMs: 1,
      handlers: {
        sync: async (job, signal) => {
          if (restarted) { completed.push(job.id); return; }
          started.push(job.id);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          signal.throwIfAborted();
        },
      },
    });
    const vision = { kind: "sync" as const, source: "vision", dedupeKey: "sync:vision" };
    const ordinary = { kind: "sync" as const, source: "ordinary", dedupeKey: "sync:ordinary" };
    const originals = [enqueueJob(vision).jobId, enqueueJob(ordinary).jobId];
    runner.start();
    try {
      await waitFor(() => started.length === 2);
      const followups = [enqueueJob(vision).jobId, enqueueJob(ordinary).jobId];
      await Bun.sleep(10);
      expect(started.sort()).toEqual(originals.sort());
      expect(followups.map((id) => getJob(id)?.status)).toEqual(["queued", "queued"]);
      await runner.stop(1000);
      const all = [...originals, ...followups];
      expect(all.map((id) => getJob(id)?.status)).toEqual(all.map(() => "queued"));
      expect(all.map((id) => getJob(id)?.attempt)).toEqual(all.map(() => 0));
      restarted = true;
      runner.start();
      await waitFor(() => all.every((id) => getJob(id)?.status === "succeeded"));
      expect(completed.sort()).toEqual(all.sort());
    } finally {
      await runner.stop(1000);
    }
  });

  test("ordinary work proceeds during a remote media read", async () => {
    const model = pendingModel();
    const restoreStarted = Promise.withResolvers<void>();
    const finishRestore = Promise.withResolvers<void>();
    const runner = new JobRunner({
      overlapSyncSource: "vision", pollIdleMs: 1, pollActiveMs: 1,
      handlers: {
        sync: async (job, signal, localWork) => {
          if (job.source !== "vision") return;
          const stats = await describeAttachments({
            db: descriptionDb, languageModel: model.model, modelRef: "vision", candidates: candidates.slice(0, 1), signal, localWork,
            mediaStore: {
              readUncached: async () => {
                restoreStarted.resolve();
                await finishRestore.promise;
                return image;
              },
            } as unknown as Awaited<ReturnType<typeof getMediaStore>>,
          });
          return { ...stats };
        },
      },
    });
    const vision = enqueueJob({ kind: "sync", source: "vision" });
    runner.start();
    try {
      await restoreStarted.promise;
      const ordinary = enqueueJob({ kind: "sync", source: "ordinary" });
      await waitFor(() => getJob(ordinary.jobId)?.status === "succeeded");
      expect(model.calls()).toBe(0);
      finishRestore.resolve();
      model.answer.resolve();
      await waitFor(() => getJob(vision.jobId)?.status === "succeeded");
      expect(getJob(vision.jobId)?.result).toMatchObject({ described: 1 });
    } finally {
      finishRestore.resolve();
      model.answer.resolve();
      await runner.stop(1000);
    }
  });

  test("a serial runner does not pass its already-held guard into description phases", async () => {
    const model = pendingModel();
    model.answer.resolve();
    const runner = new JobRunner({
      pollIdleMs: 1, pollActiveMs: 1,
      handlers: {
        sync: async (_job, signal, localWork) => {
          expect(localWork).toBeUndefined();
          return { ...await describeAttachments({
            db: descriptionDb, mediaStore, languageModel: model.model, modelRef: "vision",
            candidates: candidates.slice(0, 1), signal, localWork,
          }) };
        },
      },
    });
    const job = enqueueJob({ kind: "sync", source: "vision" });
    runner.start();
    try {
      await waitFor(() => getJob(job.jobId)?.status === "succeeded");
      expect(getJob(job.jobId)?.result).toMatchObject({ described: 1 });
    } finally {
      await runner.stop(1000);
    }
  });

  test("stopping during a stalled remote media read requeues the job and describes nothing", async () => {
    const model = pendingModel();
    const restoring = Promise.withResolvers<void>();
    const finishRestore = Promise.withResolvers<void>();
    const handlerFinished = Promise.withResolvers<void>();
    const runner = new JobRunner({
      overlapSyncSource: "vision", pollIdleMs: 1, pollActiveMs: 1,
      handlers: {
        sync: async (_job, signal, localWork) => {
          try {
            return { ...await describeAttachments({
              db: descriptionDb, languageModel: model.model, modelRef: "vision", candidates, signal, localWork,
              mediaStore: {
                readUncached: async () => {
                  restoring.resolve();
                  await finishRestore.promise;
                  return image;
                },
              } as unknown as Awaited<ReturnType<typeof getMediaStore>>,
            }) };
          } finally { handlerFinished.resolve(); }
        },
      },
    });
    const vision = enqueueJob({ kind: "sync", source: "vision" });
    runner.start();
    try {
      await restoring.promise;
      await runner.stop(1000);
      expect(getJob(vision.jobId)?.status).toBe("queued");
      finishRestore.resolve();
      await handlerFinished.promise;
      expect(model.calls()).toBe(0);
      expect(descriptionDb.prepare("SELECT * FROM attachment_descriptions").all()).toEqual([]);
    } finally {
      finishRestore.resolve();
      model.answer.resolve();
      await runner.stop(1000);
      await handlerFinished.promise;
    }
  });

  for (const source of ["vision", "ordinary"]) {
    test(`stop/restart does not release an abort-ignoring ${source} callback's ownership`, async () => {
      const finish = Promise.withResolvers<void>();
      let calls = 0;
      const runner = new JobRunner({
        overlapSyncSource: "vision", pollIdleMs: 1, pollActiveMs: 1,
        handlers: {
          sync: async () => {
            calls++;
            if (calls === 1) await finish.promise;
          },
        },
      });
      const job = enqueueJob({ kind: "sync", source });
      runner.start();
      try {
        await waitFor(() => calls === 1);
        await runner.stop(1000);
        expect(getJob(job.jobId)?.status).toBe("queued");
        runner.start();
        await waitFor(() => getJob(job.jobId)?.status === "running");
        expect(calls).toBe(1);
        finish.resolve();
        await waitFor(() => getJob(job.jobId)?.status === "succeeded");
        expect(calls).toBe(2);
      } finally {
        finish.resolve();
        await runner.stop(1000);
      }
    });
  }
});
