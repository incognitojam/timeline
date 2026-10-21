/**
 * Worker thread for DbPool.
 * Opens a readonly SQLite connection and executes queries dispatched from the main thread.
 */

import type { Database, SQLQueryBindings } from "bun:sqlite";
import { openVectorSearchDb } from "../embeddings/db";
import { openReadonlyDbAtPath } from "./readonly";

declare var self: Worker;

interface InitMessage {
  type: "init";
  dbPath: string;
  vectorSearch: boolean;
}

interface QueryMessage {
  type: "query";
  id: number;
  sql: string;
  params: unknown[];
  method: "all" | "get" | "run";
}

type WorkerMessage = InitMessage | QueryMessage;

let db: Database | null = null;

// LRU-ish statement cache (just use Map with size limit)
const stmtCache = new Map<string, ReturnType<Database["prepare"]>>();
const MAX_CACHED_STMTS = 100;

function getStatement(sql: string): ReturnType<Database["prepare"]> {
  let stmt = stmtCache.get(sql);
  if (stmt) return stmt;

  if (!db) throw new Error("Database not initialized");
  stmt = db.prepare(sql);
  if (stmtCache.size >= MAX_CACHED_STMTS) {
    // Evict oldest entry
    const firstKey = stmtCache.keys().next().value;
    if (!firstKey) throw new Error("expected cache entry");
    stmtCache.delete(firstKey);
  }
  stmtCache.set(sql, stmt);
  return stmt;
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  if (msg.type === "init") {
    try {
      db = msg.vectorSearch ? openVectorSearchDb(msg.dbPath) : openReadonlyDbAtPath(msg.dbPath);
      // WAL mode is set by the writer; readonly connections inherit it automatically
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (msg.type === "query") {
    if (!db) {
      self.postMessage({ type: "result", id: msg.id, error: "Worker not initialized" });
      return;
    }

    try {
      const stmt = getStatement(msg.sql);
      let data: unknown;

      const params = msg.params as SQLQueryBindings[];
      switch (msg.method) {
        case "all":
          data = stmt.all(...params);
          break;
        case "get":
          data = stmt.get(...params) ?? null;
          break;
        case "run":
          data = stmt.run(...params);
          break;
      }

      self.postMessage({ type: "result", id: msg.id, data });
    } catch (err) {
      self.postMessage({
        type: "result",
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
