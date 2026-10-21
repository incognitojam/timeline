import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initAppStateDb } from "../db/app-state";
import {
  getMcpSession,
  getMcpSessionStats,
  hashMcpToken,
  listMcpToolCalls,
  MCP_RECORD_BODY_CAP,
  pruneMcpRecords,
  recordMcpToolCall,
  searchMcpToolCalls,
  upsertMcpSession,
} from "./recording";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initAppStateDb(db);
});

afterEach(() => {
  db.close();
});

describe("MCP recording", () => {
  test("hashMcpToken returns a stable 16-character hex prefix", () => {
    const hash = hashMcpToken("test-token");
    expect(hash).toBe(hashMcpToken("test-token"));
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("truncates stored bodies while preserving true character counts", () => {
    upsertMcpSession({ id: "session-1", transport: "http", tokenHash: "abc123" }, db);
    const resultText = "x".repeat(MCP_RECORD_BODY_CAP + 7);

    recordMcpToolCall({
      sessionId: "session-1",
      toolName: "query_events",
      args: { query: "test" },
      resultText,
      isError: false,
      durationMs: 12,
    }, db);

    const calls = listMcpToolCalls("session-1", { limit: 10, offset: 0 }, db);
    expect(calls).toHaveLength(1);
    expect(calls[0].result_text).toHaveLength(MCP_RECORD_BODY_CAP);
    expect(calls[0].result_chars).toBe(resultText.length);
    expect(calls[0].truncated).toBe(1);
  });

  test("upsert backfills client info without clobbering existing values", () => {
    upsertMcpSession({ id: "session-2", transport: "http", tokenHash: null }, db);
    upsertMcpSession({
      id: "session-2",
      transport: "http",
      clientName: "Claude",
      clientVersion: "1.2.3",
      tokenHash: "hash-one",
    }, db);
    upsertMcpSession({
      id: "session-2",
      transport: "http",
      clientName: "Other",
      clientVersion: "9.9.9",
      tokenHash: "hash-two",
    }, db);

    const session = getMcpSession("session-2", db);
    expect(session?.client_name).toBe("Claude");
    expect(session?.client_version).toBe("1.2.3");
    expect(session?.token_hash).toBe("hash-one");
  });

  test("prune removes old calls and empty old sessions but keeps sessions with retained calls", () => {
    upsertMcpSession({ id: "old-session", transport: "http", tokenHash: "old" }, db);
    recordMcpToolCall({
      sessionId: "old-session",
      toolName: "run_sql",
      args: { sql: "SELECT 1" },
      resultText: "1",
      isError: false,
      durationMs: 3,
    }, db);
    db.exec(`
      UPDATE mcp_sessions SET last_activity_at = datetime('now', '-40 days') WHERE id = 'old-session';
      UPDATE mcp_tool_calls SET created_at = datetime('now', '-40 days') WHERE session_id = 'old-session';
    `);

    upsertMcpSession({ id: "kept-session", transport: "stdio" }, db);
    recordMcpToolCall({
      sessionId: "kept-session",
      toolName: "get_summary",
      args: {},
      resultText: "summary",
      isError: false,
      durationMs: 4,
    }, db);
    db.prepare(`
      UPDATE mcp_sessions
      SET last_activity_at = datetime('now', '-40 days')
      WHERE id = ?
    `).run("kept-session");

    const result = pruneMcpRecords(30, db);

    expect(result.calls).toBe(1);
    expect(result.sessions).toBe(1);
    expect(getMcpSession("old-session", db)).toBeNull();
    expect(getMcpSession("kept-session", db)).not.toBeNull();
  });

  test("unserializable args do not throw", () => {
    upsertMcpSession({ id: "session-3", transport: "stdio" }, db);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => recordMcpToolCall({
      sessionId: "session-3",
      toolName: "query_events",
      args: circular,
      resultText: "ok",
      isError: false,
      durationMs: 1,
    }, db)).not.toThrow();

    const calls = listMcpToolCalls("session-3", { limit: 10, offset: 0 }, db);
    expect(JSON.parse(calls[0].args_json ?? "null")).toBe("<unserializable>");
  });

  test("undefined args and results do not throw", () => {
    upsertMcpSession({ id: "session-4", transport: "stdio" }, db);

    expect(() => recordMcpToolCall({
      sessionId: "session-4",
      toolName: "run_sql",
      args: undefined,
      resultText: null,
      isError: true,
      durationMs: 1,
    }, db)).not.toThrow();

    const calls = listMcpToolCalls("session-4", { limit: 10, offset: 0 }, db);
    expect(calls[0].args_json).toBeNull();
    expect(calls[0].args_chars).toBe(0);
    expect(calls[0].result_text).toBeNull();
    expect(calls[0].result_chars).toBe(0);
  });

  test("computes true per-session stats across all calls", () => {
    upsertMcpSession({ id: "session-5", transport: "http" }, db);
    for (let i = 0; i < 3; i++) {
      recordMcpToolCall({
        sessionId: "session-5",
        toolName: "get_summary",
        args: {},
        resultText: "ok",
        isError: i === 0,
        durationMs: 10 + i * 10,
      }, db);
    }

    expect(getMcpSessionStats("session-5", db)).toEqual({
      call_count: 3,
      error_count: 1,
      avg_duration_ms: 20,
    });
  });

  test("searches MCP tool calls across sessions with composable filters", () => {
    upsertMcpSession({ id: "search-session-1", transport: "http", clientName: "Alice" }, db);
    upsertMcpSession({ id: "search-session-2", transport: "stdio", clientName: "Bob" }, db);

    const insertCall = db.prepare(`
      INSERT INTO mcp_tool_calls (
        session_id, tool_name, args_json, args_chars, result_text, result_chars,
        is_error, truncated, duration_ms, created_at
      )
      VALUES (?, ?, '{}', 2, ?, ?, ?, 0, ?, ?)
    `);
    insertCall.run("search-session-1", "query_events", "ok", 2, 0, 10, "2026-07-01 10:00:00");
    insertCall.run("search-session-1", "run_sql", "Error: bad SQL", 14, 1, 20, "2026-07-01 10:05:00");
    insertCall.run("search-session-2", "query_events", "Error: bad args", 15, 1, 30, "2026-07-02 09:00:00");
    insertCall.run("search-session-2", "get_summary", "summary", 7, 0, 40, "2026-06-30 08:00:00");

    const all = searchMcpToolCalls({ limit: 10, offset: 0 }, db);
    expect(all.map((call) => `${call.session_id}:${call.tool_name}`)).toEqual([
      "search-session-2:query_events",
      "search-session-1:run_sql",
      "search-session-1:query_events",
      "search-session-2:get_summary",
    ]);
    expect(all[0].session_id).toBe("search-session-2");

    expect(searchMcpToolCalls({ toolName: "query_events", limit: 10, offset: 0 }, db)
      .map((call) => call.session_id)).toEqual(["search-session-2", "search-session-1"]);
    expect(searchMcpToolCalls({ isError: true, limit: 10, offset: 0 }, db)
      .map((call) => call.tool_name)).toEqual(["query_events", "run_sql"]);
    expect(searchMcpToolCalls({
      sessionId: "search-session-1",
      isError: true,
      limit: 10,
      offset: 0,
    }, db).map((call) => call.tool_name)).toEqual(["run_sql"]);
    expect(searchMcpToolCalls({ since: "2026-07-01T10:01:00Z", limit: 10, offset: 0 }, db)
      .map((call) => call.tool_name)).toEqual(["query_events", "run_sql"]);
    expect(searchMcpToolCalls({ sessionId: "", limit: 10, offset: 0 }, db)).toEqual([]);
    expect(searchMcpToolCalls({ toolName: "", limit: 10, offset: 0 }, db)).toEqual([]);
    expect(searchMcpToolCalls({ limit: 1, offset: 1 }, db)
      .map((call) => call.tool_name)).toEqual(["run_sql"]);
  });
});
