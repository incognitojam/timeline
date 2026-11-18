import { Database } from "./sqlite";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { type BoundedWriterLimits, createBoundedWriter, DEFAULT_BOUNDED_WRITER_LIMITS } from "./bounded-writes";

const FAST: BoundedWriterLimits = { ...DEFAULT_BOUNDED_WRITER_LIMITS, pauseMs: 0, maxBusyMs: 0 };

describe("createBoundedWriter", () => {
  let dir: string;
  let db: Database;
  let other: Database;

  const rows = () => (db.prepare("SELECT n FROM t ORDER BY n").all() as { n: number }[]).map((row) => row.n);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bounded-writes-"));
    db = new Database(join(dir, "test.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 30000");
    db.exec("CREATE TABLE t (n INTEGER)");
    other = new Database(join(dir, "test.db"));
    other.exec("PRAGMA busy_timeout = 0");
  });

  afterEach(() => {
    db.close();
    other.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const insert = (n: number) => () => void db.prepare("INSERT INTO t VALUES (?)").run(n);

  it("flushes when the queue is full and commits every write", async () => {
    const writer = createBoundedWriter(db, { ...FAST, maxQueuedWrites: 2 });
    await writer.add(insert(1));
    expect(rows()).toEqual([]);
    await writer.add(insert(2));
    expect(rows()).toEqual([1, 2]);
    await writer.add(insert(3));
    await writer.flush();
    expect(rows()).toEqual([1, 2, 3]);
    expect(writer.stats).toMatchObject({ writes: 3, transactions: 2 });
  });

  it("flushes when queued writes carry too many bytes", async () => {
    const writer = createBoundedWriter(db, { ...FAST, maxQueuedBytes: 10 });
    await writer.add(insert(1), 10);
    expect(rows()).toEqual([1]);
  });

  it("commits at the hold limit, leaving a gap another writer can use", async () => {
    const writer = createBoundedWriter(db, { ...FAST, maxHoldMs: 0 });
    let otherWrites = 0;
    const writes = [1, 2, 3].map((n) => () => {
      insert(n)();
      expect(() => other.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
    });
    for (const write of writes) await writer.add(write);
    const flushed = writer.flush();
    const poll = setInterval(() => {
      other.exec("BEGIN IMMEDIATE");
      other.exec("ROLLBACK");
      otherWrites++;
    }, 0);
    await flushed;
    clearInterval(poll);
    expect(writer.stats.transactions).toBe(3);
    expect(otherWrites).toBeGreaterThan(0);
    expect(rows()).toEqual([1, 2, 3]);
  });

  describe("pauses", () => {
    const PAUSE_MS = 110;
    // Fake timers stand in for the pause, so nothing here waits on the clock.
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    /**
     * Runs a flush to completion, releasing one pause at a time, and returns
     * what happened in order. Each pause must last the full `PAUSE_MS`.
     */
    async function drive(writer: ReturnType<typeof createBoundedWriter>, log: string[]): Promise<string[]> {
      let done = false;
      const flushed = writer.flush().then(() => {
        done = true;
      });
      await settle();
      while (!done) {
        expect(jest.getTimerCount()).toBe(1);
        const commits = log.length;
        jest.advanceTimersByTime(PAUSE_MS - 1);
        await settle();
        expect(log.length).toBe(commits);
        log.push("pause");
        jest.advanceTimersByTime(1);
        await settle();
      }
      await flushed;
      expect(jest.getTimerCount()).toBe(0);
      return log;
    }

    async function writerWith(batches: number, log: string[]) {
      // A zero hold limit commits each write in its own transaction.
      const writer = createBoundedWriter(db, { ...FAST, pauseMs: PAUSE_MS, maxHoldMs: 0 }, {
        afterCommit: () => log.push("commit"),
      });
      for (let n = 1; n <= batches; n++) await writer.add(insert(n));
      return writer;
    }

    it("leaves a pause between consecutive commits and none after the last", async () => {
      const log: string[] = [];
      const writer = await writerWith(3, log);
      expect(await drive(writer, log)).toEqual(["commit", "pause", "commit", "pause", "commit"]);
      expect(rows()).toEqual([1, 2, 3]);
    });

    it("returns from a single commit without pausing", async () => {
      const log: string[] = [];
      const writer = await writerWith(1, log);
      expect(await drive(writer, log)).toEqual(["commit"]);
    });

    it("pauses before a later flush's first commit", async () => {
      const log: string[] = [];
      const writer = await writerWith(1, log);
      await drive(writer, log);
      await writer.add(insert(2));
      expect(await drive(writer, log)).toEqual(["commit", "pause", "commit"]);
    });
  });

  it("waits for a transaction open on the same thread without blocking it", async () => {
    other.exec("BEGIN IMMEDIATE");
    const writer = createBoundedWriter(db, FAST);
    await writer.add(insert(1));
    const flushed = writer.flush();
    // This timer can only fire if the wait above leaves the event loop free.
    setTimeout(() => other.exec("COMMIT"), 20);
    await flushed;
    expect(rows()).toEqual([1]);
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 30000 });
  });

  it("lets no other work on the thread run while it holds the lock", async () => {
    const writer = createBoundedWriter(db, FAST);
    await writer.add(insert(1));
    const flushed = writer.flush();
    // Any await between begin and commit would let this run with the lock held.
    await Promise.resolve();
    other.exec("BEGIN IMMEDIATE");
    other.exec("ROLLBACK");
    await flushed;
    expect(rows()).toEqual([1]);
  });

  it("reports commits only after they land", async () => {
    const committed: number[] = [];
    const writer = createBoundedWriter(db, { ...FAST, maxQueuedWrites: 1 }, {
      afterCommit: () => committed.push(rows().length),
    });
    await writer.add(insert(1));
    await expect(writer.add(() => {
      insert(2)();
      throw new Error("write failed");
    })).rejects.toThrow("write failed");
    expect(committed).toEqual([1]);
    expect(writer.stats).toMatchObject({ writes: 1, transactions: 1 });
  });

  it("fails loudly when the lock never comes free", async () => {
    other.exec("BEGIN IMMEDIATE");
    const writer = createBoundedWriter(db, { ...FAST, acquireTimeoutMs: 0 });
    await writer.add(insert(1));
    await expect(writer.flush()).rejects.toThrow(/write lock/);
    other.exec("ROLLBACK");
    expect(rows()).toEqual([]);
  });

  it("rolls back only the failing transaction", async () => {
    const writer = createBoundedWriter(db, { ...FAST, maxQueuedWrites: 1 });
    await writer.add(insert(1));
    const failing = writer.add(() => {
      insert(2)();
      throw new Error("write failed");
    });
    await expect(failing).rejects.toThrow("write failed");
    expect(rows()).toEqual([1]);
    expect(db.inTransaction).toBe(false);
  });
});
