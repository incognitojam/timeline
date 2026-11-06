import type { Database } from "bun:sqlite";

export interface BoundedWriterLimits {
  /** Commit once a transaction has been open this long, checked between writes. */
  maxHoldMs: number;
  /**
   * Gap left after each commit. SQLite's busy handler sleeps up to 100 ms
   * between retries, so a shorter gap can pass without a waiting writer
   * noticing the lock was free.
   */
  pauseMs: number;
  /** Flush once this many writes are queued. */
  maxQueuedWrites: number;
  /** Flush once queued writes carry this many bytes. */
  maxQueuedBytes: number;
  /** Give up waiting for the write lock after this long. */
  acquireTimeoutMs: number;
  /** Let the event loop run after this long without a pause. */
  maxBusyMs: number;
}

export const DEFAULT_BOUNDED_WRITER_LIMITS: BoundedWriterLimits = {
  maxHoldMs: 250,
  pauseMs: 110,
  maxQueuedWrites: 200,
  maxQueuedBytes: 8 * 1024 * 1024,
  acquireTimeoutMs: 5 * 60 * 1000,
  maxBusyMs: 50,
};

const LOCK_RETRY_MS = 50;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isBusyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_BUSY")
  );
}

/**
 * Applies queued writes in short transactions, so a long import leaves room for
 * other writers and for the rest of the event loop.
 *
 * The lock is only ever held synchronously: nothing awaits inside a
 * transaction, and waiting for the lock never blocks the thread. That matters
 * on the sync worker, where blocking in SQLite's busy handler would stop
 * another source on the same thread from finishing the transaction being
 * waited on.
 *
 * Commits are not atomic across a whole import. Callers must be able to re-run
 * from where they started and skip what already landed.
 */
export function createBoundedWriter(
  db: Database,
  limits: BoundedWriterLimits = DEFAULT_BOUNDED_WRITER_LIMITS,
  hooks: {
    /** Runs inside each transaction, for work that must commit with its writes. */
    beforeCommit?: () => void;
    /** Runs once a transaction has committed. */
    afterCommit?: () => void;
  } = {},
) {
  let queue: (() => void)[] = [];
  let queuedBytes = 0;
  let lastPause = performance.now();
  const stats = { writes: 0, transactions: 0, longestHoldMs: 0 };

  const tryBegin = (): boolean => {
    const { timeout } = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    db.exec("PRAGMA busy_timeout = 0");
    try {
      db.exec("BEGIN IMMEDIATE");
      return true;
    } catch (error) {
      if (isBusyError(error)) return false;
      throw error;
    } finally {
      db.exec(`PRAGMA busy_timeout = ${timeout}`);
    }
  };

  const flush = async (): Promise<void> => {
    const writes = queue;
    queue = [];
    queuedBytes = 0;
    let next = 0;
    while (next < writes.length) {
      // No await between a successful begin and the commit: other work on this
      // thread must never run while the lock is held.
      const deadline = performance.now() + limits.acquireTimeoutMs;
      while (!tryBegin()) {
        if (performance.now() >= deadline) {
          throw new Error(`Timed out after ${limits.acquireTimeoutMs} ms waiting for the database write lock`);
        }
        await sleep(LOCK_RETRY_MS);
      }
      const start = performance.now();
      const first = next;
      try {
        do {
          writes[next++]();
        } while (next < writes.length && performance.now() - start < limits.maxHoldMs);
        hooks.beforeCommit?.();
        db.exec("COMMIT");
      } catch (error) {
        if (db.inTransaction) db.exec("ROLLBACK");
        throw error;
      }
      stats.writes += next - first;
      stats.transactions++;
      stats.longestHoldMs = Math.max(stats.longestHoldMs, performance.now() - start);
      hooks.afterCommit?.();
      await sleep(limits.pauseMs);
      lastPause = performance.now();
    }
  };

  return {
    stats,
    get queuedWrites(): number {
      return queue.length;
    },
    /** Queue a write to run inside a transaction; it must not await. */
    async add(write: () => void, bytes = 0): Promise<void> {
      queue.push(write);
      queuedBytes += bytes;
      if (queue.length >= limits.maxQueuedWrites || queuedBytes >= limits.maxQueuedBytes) await flush();
    },
    flush,
    /** Call between reads so a long read doesn't starve the event loop. */
    async breathe(): Promise<void> {
      if (performance.now() - lastPause < limits.maxBusyMs) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
      lastPause = performance.now();
    },
  };
}
