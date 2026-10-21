import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import sharp from "sharp";
import { getAppStateDb } from "../db/app-state";
import { initDb } from "../db/schema";
import { describeAttachments } from "../media/describe-attachments";
import type { getMediaStore } from "../media/storage";
import { LocalWorkGate } from "./local-work";
import { JobRunner } from "./runner";
import { enqueueJob, getJob } from "./store";

const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).png().toBuffer();
const candidates = ["one", "two"].map((hash) => ({
  content_hash: hash, source: "test", filename: null, storage_path: `${hash}.png`, mime_type: "image/png",
}));
const mediaStore = {
  readFile: async () => ({ content: image }),
  restoreFromRemote: async () => null,
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let tries = 0; tries < 1000; tries++) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("Timed out waiting for test progress");
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
    importDb.close();
    descriptionDb.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("stored duration excludes media and persistence ownership waits", async () => {
    const model = pendingModel();
    const gate = new LocalWorkGate();
    const run = gate.run.bind(gate);
    const releaseMedia = Promise.withResolvers<void>();
    const releasePersistence = Promise.withResolvers<void>();
    const mediaQueued = Promise.withResolvers<void>();
    const persistenceQueued = Promise.withResolvers<void>();
    let mediaOwner = Promise.resolve();
    let persistenceOwner = Promise.resolve();
    let requests = 0;
    let now = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const guard = spyOn(gate, "run").mockImplementation((work, signal) => {
      requests++;
      if (requests === 2) {
        mediaOwner = run(() => releaseMedia.promise);
        mediaQueued.resolve();
      }
      if (requests === 3) persistenceQueued.resolve();
      return run(work, signal);
    });
    const read = spyOn(mediaStore, "readFile").mockImplementation(async () => {
      now += 20;
      return { content: Uint8Array.from(image).buffer, absolutePath: join(directory, "one.png"), fileSize: image.byteLength };
    });
    const running = describeAttachments({
      db: descriptionDb, mediaStore, languageModel: model.model, modelRef: "vision",
      candidates: candidates.slice(0, 1), localWork: gate,
    });
    try {
      await mediaQueued.promise;
      now += 120_000;
      releaseMedia.resolve();
      await model.started.promise;
      persistenceOwner = run(() => releasePersistence.promise);
      now += 80;
      model.answer.resolve();
      await persistenceQueued.promise;
      expect(descriptionDb.prepare("SELECT * FROM attachment_descriptions").all()).toEqual([]);
      now += 180_000;
      releasePersistence.resolve();
      expect(await running).toMatchObject({ described: 1, failed: 0 });
      expect(descriptionDb.prepare("SELECT duration_ms FROM attachment_descriptions").get()).toEqual({ duration_ms: 100 });
    } finally {
      releaseMedia.resolve();
      releasePersistence.resolve();
      model.answer.resolve();
      await Promise.all([mediaOwner, persistenceOwner, running]);
      for (const spy of [clock, guard, read]) spy.mockRestore();
    }
  });

  for (const expiry of ["while-waiting", "at-acquisition"] as const) {
    test(`expired media work does not read or restore: ${expiry}`, async () => {
      const model = pendingModel();
      const gate = new LocalWorkGate();
      const run = gate.run.bind(gate);
      const finishImport = Promise.withResolvers<void>();
      const mediaQueued = Promise.withResolvers<void>();
      let importer = Promise.resolve();
      let requests = 0;
      const guard = spyOn(gate, "run").mockImplementation((work, signal) => {
        requests++;
        if (requests === 2) {
          importer = run(() => finishImport.promise);
          mediaQueued.resolve();
        }
        return run(work, signal);
      });
      const read = spyOn(mediaStore, "readFile");
      const restore = spyOn(mediaStore, "restoreFromRemote");
      const deadline = Date.now() + (expiry === "while-waiting" ? 50 : 60_000);
      let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;
      const running = describeAttachments({
        db: descriptionDb, mediaStore, languageModel: model.model, modelRef: "vision",
        candidates, deadline, localWork: gate,
      });
      try {
        await mediaQueued.promise;
        if (expiry === "at-acquisition") {
          clock = spyOn(Date, "now").mockReturnValue(deadline + 1);
          finishImport.resolve();
        }
        const stats = await running;
        expect(stats).toMatchObject({ described: 0, failed: 0, skipped: 0, remaining: 2, stoppedReason: "time-budget" });
        expect(read).not.toHaveBeenCalled();
        expect(restore).not.toHaveBeenCalled();
        expect(model.calls()).toBe(0);
      } finally {
        finishImport.resolve();
        model.answer.resolve();
        await importer;
        await running;
        clock?.mockRestore();
        for (const spy of [guard, read, restore]) spy.mockRestore();
      }
    });
  }

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
        model.answer.resolve();
        await waitFor(() => (requests?.mock.calls.length ?? 0) > 0);
        expect(getJob(description.jobId)?.status).toBe("running");
        expect(getJob(importer.jobId)?.status).toBe("running");
        expect(descriptionDb.prepare("SELECT * FROM attachment_descriptions WHERE content_hash = 'one'").get()).toBeNull();
        if (expireBudget) clock = spyOn(Date, "now").mockReturnValue(deadline + 1);
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

  for (const abortPhase of ["inference", "persistence"] as const) {
    test(`cancellation during ${abortPhase} causes no late write or model failure`, async () => {
      const model = pendingModel();
      const localWork = new LocalWorkGate();
      const controller = new AbortController();
      const finishLocal = Promise.withResolvers<void>();
      let local: Promise<void> | undefined;
      let requests: ReturnType<typeof spyOn<LocalWorkGate, "run">> | undefined;
      const describing = describeAttachments({
        db: descriptionDb, mediaStore, languageModel: model.model, modelRef: "vision",
        candidates, signal: controller.signal, localWork,
      });
      try {
        await model.started.promise;
        if (abortPhase === "persistence") {
          const localStarted = Promise.withResolvers<void>();
          local = localWork.run(async () => { localStarted.resolve(); await finishLocal.promise; });
          await localStarted.promise;
          requests = spyOn(localWork, "run");
          model.answer.resolve();
          await waitFor(() => (requests?.mock.calls.length ?? 0) > 0);
        }
        controller.abort();
        model.answer.resolve();
        const stats = await describing;
        expect(stats).toMatchObject({ described: 0, failed: 0, remaining: 2, failureSamples: [] });
        finishLocal.resolve();
        await local;
        await localWork.run(() => {});
        expect(descriptionDb.prepare("SELECT * FROM attachment_descriptions").all()).toEqual([]);
        expect(model.calls()).toBe(1);
      } finally {
        requests?.mockRestore();
        model.answer.resolve();
        finishLocal.resolve();
        await local;
        await describing;
      }
    });
  }

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

  test("media restore retains local ownership, then ordinary work proceeds during inference", async () => {
    const model = pendingModel();
    const restoreStarted = Promise.withResolvers<void>();
    const finishRestore = Promise.withResolvers<void>();
    let ordinaryEntered = false;
    const runner = new JobRunner({
      overlapSyncSource: "vision", pollIdleMs: 1, pollActiveMs: 1,
      handlers: {
        sync: async (job, signal, localWork) => {
          if (job.source !== "vision") { ordinaryEntered = true; return; }
          const stats = await describeAttachments({
            db: descriptionDb, languageModel: model.model, modelRef: "vision", candidates: candidates.slice(0, 1), signal, localWork,
            mediaStore: {
              readFile: async () => null,
              restoreFromRemote: async () => {
                restoreStarted.resolve();
                await finishRestore.promise;
                return { content: image };
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
      await waitFor(() => getJob(ordinary.jobId)?.status === "running");
      expect(ordinaryEntered).toBe(false);
      finishRestore.resolve();
      await model.started.promise;
      await waitFor(() => getJob(ordinary.jobId)?.status === "succeeded");
      expect(getJob(vision.jobId)?.status).toBe("running");
      model.answer.resolve();
      await waitFor(() => getJob(vision.jobId)?.status === "succeeded");
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

  test("stopping a stalled restore requeues both jobs without releasing active local work", async () => {
    const model = pendingModel();
    const restoring = Promise.withResolvers<void>();
    const finishRestore = Promise.withResolvers<void>();
    const handlerFinished = Promise.withResolvers<void>();
    let ordinaryEntered = false;
    const runner = new JobRunner({
      overlapSyncSource: "vision", pollIdleMs: 1, pollActiveMs: 1,
      handlers: {
        sync: async (job, signal, localWork) => {
          if (job.source !== "vision") { ordinaryEntered = true; return; }
          try {
            return { ...await describeAttachments({
              db: descriptionDb, languageModel: model.model, modelRef: "vision", candidates, signal, localWork,
              mediaStore: {
                readFile: async () => null,
                restoreFromRemote: async () => {
                  restoring.resolve();
                  await finishRestore.promise;
                  return { content: image };
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
      const ordinary = enqueueJob({ kind: "sync", source: "ordinary" });
      await waitFor(() => getJob(ordinary.jobId)?.status === "running");
      await runner.stop(1000);
      expect(getJob(vision.jobId)?.status).toBe("queued");
      expect(getJob(ordinary.jobId)?.status).toBe("queued");
      expect(ordinaryEntered).toBe(false);
      finishRestore.resolve();
      await handlerFinished.promise;
      expect(ordinaryEntered).toBe(false);
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
