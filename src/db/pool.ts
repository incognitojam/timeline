/**
 * DbPool — Worker pool for concurrent readonly SQLite queries.
 *
 * Moves synchronous bun:sqlite reads off the main thread so the event loop stays free.
 * Each worker opens its own readonly connection; queries wait in a shared FIFO
 * until a worker is idle.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { cpus } from "os";
import { getDbPoolWorkerPath } from "../runtime-paths";

export interface QueryExecutor {
  query<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  get<T>(sql: string, ...params: unknown[]): Promise<T | null>;
}

export interface DbPoolStats {
  size: number;
  pending: number;
  queued: number;
  workers: number[];
}

const queryAbortContext = new AsyncLocalStorage<AbortSignal | undefined>();

/** Run database work with the abort signal for its originating request. */
export function withQueryAbortSignal<T>(signal: AbortSignal, operation: () => T): T {
  return queryAbortContext.run(signal, operation);
}

/** Detach shared work whose lifetime must not belong to its first caller. */
export function withoutQueryAbortSignal<T>(operation: () => T): T {
  return queryAbortContext.run(undefined, operation);
}

function abortReason(signal: AbortSignal): Error {
  return new DOMException(
    signal.reason instanceof Error ? signal.reason.message : "Database query aborted",
    "AbortError",
  );
}

function throwIfQueryAborted(): void {
  const signal = queryAbortContext.getStore();
  if (signal?.aborted) throw abortReason(signal);
}

/** Stop awaiting shared work when the current request is aborted. */
export function waitForQueryAbort<T>(promise: Promise<T>): Promise<T> {
  const signal = queryAbortContext.getStore();
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Wrap a synchronous bun:sqlite Database as a QueryExecutor.
 * Use this for callers outside the API (MCP stdio, export CLI, day summary).
 */
export function wrapDatabase(db: Database): QueryExecutor {
  return {
    async query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      throwIfQueryAborted();
      return db.prepare(sql).all(...(params as SQLQueryBindings[])) as T[];
    },
    async get<T>(sql: string, ...params: unknown[]): Promise<T | null> {
      throwIfQueryAborted();
      return (db.prepare(sql).get(...(params as SQLQueryBindings[])) as T) ?? null;
    },
  };
}

interface PendingQuery {
  id: number;
  sql: string;
  params: unknown[];
  method: "all" | "get" | "run";
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
  state: "queued" | "running" | "completed";
  settled: boolean;
}

interface WorkerEntry {
  worker: Worker;
  available: boolean;
  pending: Map<number, PendingQuery>;
  failedWorker?: Worker;
  initialization?: {
    resolve: () => void;
    reject: (error: Error) => void;
  };
}

function detachAbortListener(pending: PendingQuery): void {
  if (!pending.signal || !pending.abortListener) return;
  pending.signal.removeEventListener("abort", pending.abortListener);
  pending.abortListener = undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isScalarBinding(value: unknown): boolean {
  return value === null
    || typeof value === "string"
    || typeof value === "bigint"
    || typeof value === "number"
    || typeof value === "boolean"
    || ArrayBuffer.isView(value);
}

function isSqlQueryBinding(value: unknown): boolean {
  if (isScalarBinding(value)) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(isScalarBinding);
}

export const QUERY_TIMEOUT_MS = 30_000;

export class QueryTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Database query timeout after ${timeoutMs}ms`);
    this.name = "QueryTimeoutError";
  }
}

export class DbPool implements QueryExecutor {
  private workers: WorkerEntry[];
  private queue = new Map<number, PendingQuery>();
  private nextId = 0;
  private closed = false;
  private initializing = true;
  private closedReason?: Error;

  private constructor(
    private readonly workerUrl: string | URL,
    private readonly dbPath: string,
    private readonly vectorSearch: boolean,
  ) {
    this.workers = [];
  }

  /**
   * Create a pool of worker threads, each with its own readonly SQLite connection.
   * Waits for all workers to confirm DB opened successfully before resolving.
   * `vectorSearch` opens embeddings.db for sqlite-vec nearest-neighbour queries.
   */
  static async create(
    dbPath: string,
    options?: { workers?: number; vectorSearch?: boolean },
  ): Promise<DbPool> {
    const workerCount = options?.workers ?? Math.min(cpus().length, 4);
    if (!Number.isInteger(workerCount) || workerCount < 1) {
      throw new RangeError("DbPool worker count must be a positive integer");
    }
    const workerUrl = getDbPoolWorkerPath();
    const pool = new DbPool(workerUrl, dbPath, options?.vectorSearch ?? false);
    try {
      for (let i = 0; i < workerCount; i++) {
        pool.workers.push(pool.createWorkerEntry());
      }
      await Promise.all(pool.workers.map((entry) => pool.initializeWorker(entry)));
      pool.initializing = false;
      for (const entry of pool.workers) entry.initialization = undefined;
      return pool;
    } catch (error) {
      pool.shutdown(asError(error));
      throw error;
    }
  }

  private createWorkerEntry(): WorkerEntry {
    return {
      worker: new Worker(this.workerUrl),
      available: false,
      pending: new Map(),
    };
  }

  private initializeWorker(entry: WorkerEntry): Promise<void> {
    const worker = entry.worker;
    const initialized = new Promise<void>((resolve, reject) => {
      entry.initialization = { resolve, reject };
    });
    worker.onmessage = (event: MessageEvent) => {
      if (entry.worker !== worker || entry.failedWorker === worker) return;
      const msg = event.data;
      if (msg.type === "ready") {
        entry.available = true;
        entry.initialization?.resolve();
        return;
      }
      if (msg.type === "error" && !entry.available) {
        this.handleWorkerFailure(entry, worker, new Error(msg.error));
        return;
      }
      if (msg.type !== "result" || !entry.available) return;

      const pending = entry.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      detachAbortListener(pending);
      entry.pending.delete(msg.id);
      pending.state = "completed";
      if (!pending.settled) {
        pending.settled = true;
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.data);
        }
      }
      this.dispatchQueuedQueries();
    };
    worker.addEventListener("messageerror", () => {
      this.handleWorkerFailure(entry, worker, new Error("Database worker message could not be decoded"));
    });
    worker.addEventListener("error", (event) => {
      const error = event.error instanceof Error ? event.error : new Error(event.message);
      this.handleWorkerFailure(entry, worker, error);
    });
    worker.addEventListener("close", () => {
      const message = entry.available
        ? "Database worker exited unexpectedly"
        : "Database worker exited during initialization";
      this.handleWorkerFailure(entry, worker, new Error(message));
    });
    try {
      worker.postMessage({ type: "init", dbPath: this.dbPath, vectorSearch: this.vectorSearch });
    } catch (error) {
      this.handleWorkerFailure(entry, worker, asError(error));
    }
    return initialized;
  }

  private handleWorkerFailure(entry: WorkerEntry, worker: Worker, error: Error): void {
    if (this.closed || entry.worker !== worker || entry.failedWorker === worker) return;
    const wasAvailable = entry.available;
    entry.failedWorker = worker;
    entry.available = false;
    entry.initialization?.reject(error);

    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timer);
      detachAbortListener(pending);
      pending.state = "completed";
      this.rejectQuery(pending, error);
    }
    entry.pending.clear();
    worker.terminate();

    if (this.initializing) {
      this.shutdown(error);
      return;
    }
    if (!wasAvailable) return;
    void this.replaceWorker(entry);
  }

  private async replaceWorker(entry: WorkerEntry): Promise<void> {
    try {
      const replacement = this.createWorkerEntry();
      if (this.closed) {
        replacement.worker.terminate();
        return;
      }
      entry.worker = replacement.worker;
      entry.failedWorker = undefined;
      entry.available = false;
      await this.initializeWorker(entry);
      entry.initialization = undefined;
      this.dispatchQueuedQueries();
    } catch (error) {
      this.shutdown(new Error(`Failed to replace database worker: ${asError(error).message}`));
    }
  }

  private rejectQuery(pending: PendingQuery, error: Error): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.reject(error);
  }

  private cancelQuery(pending: PendingQuery, signal: AbortSignal): void {
    clearTimeout(pending.timer);
    detachAbortListener(pending);

    if (pending.state === "queued") {
      this.queue.delete(pending.id);
      pending.state = "completed";
    }

    this.rejectQuery(pending, abortReason(signal));
  }

  private timeoutQuery(pending: PendingQuery): void {
    if (pending.state === "completed") return;
    console.warn(`[DbPool] Query timeout after ${QUERY_TIMEOUT_MS}ms: ${pending.sql.slice(0, 100)}`);
    detachAbortListener(pending);

    if (pending.state === "queued") {
      this.queue.delete(pending.id);
      pending.state = "completed";
    }

    this.rejectQuery(pending, new QueryTimeoutError(QUERY_TIMEOUT_MS));
  }

  private takeQueuedQuery(): PendingQuery | undefined {
    const next = this.queue.values().next();
    if (next.done) return undefined;
    this.queue.delete(next.value.id);
    return next.value;
  }

  private dispatchQueuedQueries(): void {
    if (this.closed) return;

    for (const entry of this.workers) {
      if (!entry.available || entry.pending.size > 0) continue;

      while (entry.pending.size === 0) {
        const pending = this.takeQueuedQuery();
        if (!pending) return;

        if (pending.signal?.aborted) {
          clearTimeout(pending.timer);
          detachAbortListener(pending);
          pending.state = "completed";
          this.rejectQuery(pending, abortReason(pending.signal));
          continue;
        }

        pending.state = "running";
        entry.pending.set(pending.id, pending);
        try {
          entry.worker.postMessage({
            type: "query",
            id: pending.id,
            sql: pending.sql,
            params: pending.params,
            method: pending.method,
          });
        } catch (error) {
          clearTimeout(pending.timer);
          detachAbortListener(pending);
          entry.pending.delete(pending.id);
          pending.state = "completed";
          this.rejectQuery(pending, asError(error));
        }
      }
    }
  }

  private dispatch(
    sql: string,
    params: unknown[],
    method: "all" | "get" | "run"
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(this.closedReason ?? new Error("Pool is closed"));
    }

    const signal = queryAbortContext.getStore();
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }

    if (!params.every(isSqlQueryBinding)) {
      return Promise.reject(new TypeError("Database query parameters must be SQLite bindings"));
    }

    return new Promise((resolve, reject) => {
      let pending: PendingQuery;
      const timer = setTimeout(() => this.timeoutQuery(pending), QUERY_TIMEOUT_MS);

      pending = {
        id: this.nextId++,
        sql,
        params,
        method,
        resolve,
        reject,
        timer,
        signal,
        state: "queued",
        settled: false,
      };
      if (signal) {
        pending.abortListener = () => this.cancelQuery(pending, signal);
        signal.addEventListener("abort", pending.abortListener, { once: true });
      }

      this.queue.set(pending.id, pending);
      this.dispatchQueuedQueries();
    });
  }

  async query<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.dispatch(sql, params, "all") as Promise<T[]>;
  }

  async get<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    return this.dispatch(sql, params, "get") as Promise<T | null>;
  }

  async run(
    sql: string,
    ...params: unknown[]
  ): Promise<{ changes: number }> {
    return this.dispatch(sql, params, "run") as Promise<{ changes: number }>;
  }

  /** Number of worker threads in the pool. */
  get size(): number {
    return this.workers.length;
  }

  /** Current readonly query load across the worker pool. */
  getStats(): DbPoolStats {
    const workers = this.workers.map((entry) => entry.pending.size);
    return {
      size: workers.length,
      pending: this.queue.size + workers.reduce((total, pending) => total + pending, 0),
      queued: this.queue.size,
      workers,
    };
  }

  /** Terminate all workers and reject pending queries. */
  close(): void {
    this.shutdown(new Error("Pool is closed"));
  }

  /** Terminate all workers and wait until their runtimes have closed. */
  async closeAndWait(): Promise<void> {
    if (this.closed) return;
    const closedWorkers = this.workers.map((entry) => new Promise<void>((resolve) => {
      entry.worker.addEventListener("close", () => resolve(), { once: true });
    }));
    this.shutdown(new Error("Pool is closed"));
    await Promise.all(closedWorkers);
  }

  private shutdown(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closedReason = error;

    for (const pending of this.queue.values()) {
      clearTimeout(pending.timer);
      detachAbortListener(pending);
      pending.state = "completed";
      this.rejectQuery(pending, error);
    }
    this.queue.clear();

    for (const entry of this.workers) {
      entry.initialization?.reject(error);
      entry.initialization = undefined;
      // Reject all pending queries
      for (const [, pending] of entry.pending) {
        clearTimeout(pending.timer);
        detachAbortListener(pending);
        pending.state = "completed";
        this.rejectQuery(pending, error);
      }
      entry.pending.clear();
      entry.worker.terminate();
    }
  }
}
