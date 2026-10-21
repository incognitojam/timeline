/**
 * MCP call recording for app-state.db.
 *
 * Recording is observability: callers on the live tool path must catch and log
 * failures from this module so a broken recorder never breaks MCP tools.
 *
 * Future work: structured tool results, named MCP tokens, and links from MCP
 * sessions to conversation rows.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import { getAppStateDb } from "../db/app-state";

export const MCP_RECORD_BODY_CAP = 64 * 1024;

export type McpTransport = "http" | "stdio";

export interface McpSessionInit {
  id: string;
  transport: McpTransport;
  clientName?: string | null;
  clientVersion?: string | null;
  tokenHash?: string | null;
}

export interface McpSessionRow {
  id: string;
  transport: McpTransport;
  client_name: string | null;
  client_version: string | null;
  token_hash: string | null;
  created_at: string;
  last_activity_at: string;
}

export interface McpSessionSummary extends McpSessionRow {
  call_count: number;
  error_count: number;
  last_call_at: string | null;
}

export interface McpSessionStats {
  call_count: number;
  error_count: number;
  avg_duration_ms: number | null;
}

export interface McpToolCallRow {
  id: number;
  session_id: string;
  tool_name: string;
  args_json: string | null;
  args_chars: number;
  result_text: string | null;
  result_chars: number;
  is_error: number;
  truncated: number;
  duration_ms: number;
  created_at: string;
}

export interface SearchMcpToolCallsOpts {
  sessionId?: string;
  toolName?: string;
  isError?: boolean;
  since?: string;
  limit: number;
  offset: number;
}

export interface RecordToolCallInput {
  sessionId: string;
  toolName: string;
  args: unknown;
  resultText: string | null;
  isError: boolean;
  durationMs: number;
}

export const MCP_TOOL_CALL_SINCE_ERROR =
  "since must be an ISO timestamp with timezone parseable by SQLite datetime(), e.g. 2026-07-03T10:30:00Z.";

const ISO_TIMESTAMP_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function normalizeMcpToolCallSince(
  value: string,
  db: Database = getAppStateDb(),
): string | null {
  if (!ISO_TIMESTAMP_WITH_ZONE_RE.test(value) && !SQLITE_DATETIME_RE.test(value)) {
    return null;
  }

  const row = db
    .prepare("SELECT datetime(?) AS value")
    .get(value) as { value: string | null };
  return row.value;
}

function truncateBody(value: string | null): {
  text: string | null;
  chars: number;
  truncated: boolean;
} {
  if (value == null) {
    return { text: null, chars: 0, truncated: false };
  }
  const chars = value.length;
  return {
    text: chars > MCP_RECORD_BODY_CAP ? value.slice(0, MCP_RECORD_BODY_CAP) : value,
    chars,
    truncated: chars > MCP_RECORD_BODY_CAP,
  };
}

function stringifyArgs(args: unknown): string | null {
  try {
    return JSON.stringify(args) ?? null;
  } catch {
    return JSON.stringify("<unserializable>");
  }
}

export function hashMcpToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function upsertMcpSession(
  init: McpSessionInit,
  db: Database = getAppStateDb(),
): void {
  db.prepare(`
    INSERT INTO mcp_sessions (
      id, transport, client_name, client_version, token_hash, last_activity_at
    )
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      last_activity_at = datetime('now'),
      client_name = COALESCE(mcp_sessions.client_name, excluded.client_name),
      client_version = COALESCE(mcp_sessions.client_version, excluded.client_version),
      token_hash = COALESCE(mcp_sessions.token_hash, excluded.token_hash)
  `).run(
    init.id,
    init.transport,
    init.clientName ?? null,
    init.clientVersion ?? null,
    init.tokenHash ?? null,
  );
}

export function recordMcpToolCall(
  input: RecordToolCallInput,
  db: Database = getAppStateDb(),
): void {
  const args = truncateBody(stringifyArgs(input.args));
  const result = truncateBody(input.resultText);
  const truncated = args.truncated || result.truncated;

  db.prepare(`
    INSERT INTO mcp_tool_calls (
      session_id, tool_name, args_json, args_chars, result_text, result_chars,
      is_error, truncated, duration_ms
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.sessionId,
    input.toolName,
    args.text,
    args.chars,
    result.text,
    result.chars,
    input.isError ? 1 : 0,
    truncated ? 1 : 0,
    input.durationMs,
  );

}

export function listMcpSessions(
  opts: { limit: number; offset: number },
  db: Database = getAppStateDb(),
): McpSessionSummary[] {
  return db.prepare(`
    SELECT
      s.id,
      s.transport,
      s.client_name,
      s.client_version,
      s.token_hash,
      s.created_at,
      s.last_activity_at,
      COUNT(c.id) AS call_count,
      COALESCE(SUM(c.is_error), 0) AS error_count,
      MAX(c.created_at) AS last_call_at
    FROM mcp_sessions s
    LEFT JOIN mcp_tool_calls c ON c.session_id = s.id
    GROUP BY s.id
    ORDER BY s.last_activity_at DESC
    LIMIT ? OFFSET ?
  `).all(opts.limit, opts.offset) as McpSessionSummary[];
}

export function getMcpSession(
  id: string,
  db: Database = getAppStateDb(),
): McpSessionRow | null {
  return db
    .prepare(`
      SELECT id, transport, client_name, client_version, token_hash, created_at, last_activity_at
      FROM mcp_sessions
      WHERE id = ?
    `)
    .get(id) as McpSessionRow | null;
}

export function getMcpSessionStats(
  sessionId: string,
  db: Database = getAppStateDb(),
): McpSessionStats {
  return db.prepare(`
    SELECT
      COUNT(*) AS call_count,
      COALESCE(SUM(is_error), 0) AS error_count,
      AVG(duration_ms) AS avg_duration_ms
    FROM mcp_tool_calls
    WHERE session_id = ?
  `).get(sessionId) as McpSessionStats;
}

export function listMcpToolCalls(
  sessionId: string,
  opts: { limit: number; offset: number },
  db: Database = getAppStateDb(),
): McpToolCallRow[] {
  return db.prepare(`
    SELECT
      id, session_id, tool_name, args_json, args_chars, result_text, result_chars,
      is_error, truncated, duration_ms, created_at
    FROM mcp_tool_calls
    WHERE session_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(sessionId, opts.limit, opts.offset) as McpToolCallRow[];
}

export function searchMcpToolCalls(
  opts: SearchMcpToolCallsOpts,
  db: Database = getAppStateDb(),
): McpToolCallRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (opts.sessionId !== undefined) {
    where.push("session_id = ?");
    params.push(opts.sessionId);
  }
  if (opts.toolName !== undefined) {
    where.push("tool_name = ?");
    params.push(opts.toolName);
  }
  if (opts.isError) {
    where.push("is_error = 1");
  }
  if (opts.since !== undefined) {
    const normalizedSince = normalizeMcpToolCallSince(opts.since, db);
    if (!normalizedSince) {
      throw new Error(MCP_TOOL_CALL_SINCE_ERROR);
    }
    where.push("created_at >= ?");
    params.push(normalizedSince);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return db.prepare(`
    SELECT
      id, session_id, tool_name, args_json, args_chars, result_text, result_chars,
      is_error, truncated, duration_ms, created_at
    FROM mcp_tool_calls
    ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(...params, opts.limit, opts.offset) as McpToolCallRow[];
}

export function pruneMcpRecords(
  retentionDays = 30,
  db: Database = getAppStateDb(),
): { calls: number; sessions: number } {
  const days = Math.max(1, Math.floor(retentionDays));
  const modifier = `-${days} days`;
  const callResult = db
    .prepare("DELETE FROM mcp_tool_calls WHERE created_at < datetime('now', ?)")
    .run(modifier);
  const sessionResult = db
    .prepare(`
      DELETE FROM mcp_sessions
      WHERE last_activity_at < datetime('now', ?)
        AND NOT EXISTS (
          SELECT 1 FROM mcp_tool_calls c WHERE c.session_id = mcp_sessions.id
        )
    `)
    .run(modifier);

  return {
    calls: callResult.changes,
    sessions: sessionResult.changes,
  };
}

export interface InvalidToolCallRecorderOptions {
  sessionId: () => string | undefined;
  recordToolCall: (rec: RecordToolCallInput) => void;
  now?: () => number;
  maxPending?: number;
}

export interface InvalidToolCallRecorder {
  markHandled: (requestId: RequestId) => void;
}

interface PendingToolCall {
  toolName: string;
  args: unknown;
  sessionId: string | undefined;
  startedAt: number;
}

function requestKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function extractToolCall(message: JSONRPCMessage): { id: RequestId; toolName: string; args: unknown } | null {
  if (!isJSONRPCRequest(message) || message.method !== "tools/call") return null;
  const params = message.params;
  if (!params || typeof params !== "object" || !("name" in params) || typeof params.name !== "string") {
    return null;
  }
  return {
    id: message.id,
    toolName: params.name,
    args: "arguments" in params ? params.arguments : undefined,
  };
}

function resultErrorText(message: JSONRPCMessage): string | null {
  if (!isJSONRPCResultResponse(message)) return null;
  const result = message.result;
  if (!result || typeof result !== "object" || !("isError" in result) || result.isError !== true) {
    return null;
  }
  if (!("content" in result) || !Array.isArray(result.content)) return null;
  return result.content
    .filter((content): content is { type: "text"; text: string } =>
      !!content &&
      typeof content === "object" &&
      "type" in content &&
      content.type === "text" &&
      "text" in content &&
      typeof content.text === "string"
    )
    .map((content) => content.text)
    .join("\n");
}

/**
 * Records tools/call requests that the MCP SDK rejects before the registered
 * tool handler runs, such as schema-invalid arguments. The installed SDK turns
 * input validation failures into CallToolResult.isError responses instead of
 * JSON-RPC errors, so handler-level recording marks requests it has handled and
 * this wrapper records only unhandled error responses.
 */
export function recordInvalidToolCallsFromTransport(
  transport: Transport,
  options: InvalidToolCallRecorderOptions,
): InvalidToolCallRecorder {
  const pending = new Map<string, PendingToolCall>();
  const now = options.now ?? (() => performance.now());
  const maxPending = options.maxPending ?? 100;

  const originalOnMessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    const toolCall = extractToolCall(message);
    if (toolCall) {
      if (pending.size >= maxPending) {
        const oldestKey = pending.keys().next().value;
        if (oldestKey !== undefined) pending.delete(oldestKey);
      }
      pending.set(requestKey(toolCall.id), {
        toolName: toolCall.toolName,
        args: toolCall.args,
        sessionId: options.sessionId(),
        startedAt: now(),
      });
    }
    originalOnMessage?.(message, extra);
  };

  const originalSend = transport.send.bind(transport);
  transport.send = async (message, sendOptions) => {
    if (isJSONRPCErrorResponse(message) && message.id !== undefined) {
      const pendingCall = pending.get(requestKey(message.id));
      if (pendingCall?.sessionId) {
        try {
          options.recordToolCall({
            sessionId: pendingCall.sessionId,
            toolName: pendingCall.toolName,
            args: pendingCall.args,
            resultText: message.error.message,
            isError: true,
            durationMs: Math.round(now() - pendingCall.startedAt),
          });
        } catch (error) {
          console.error("[MCP] record invalid tool call failed:", error);
        }
      }
      pending.delete(requestKey(message.id));
    } else if (isJSONRPCResultResponse(message)) {
      const key = requestKey(message.id);
      const pendingCall = pending.get(key);
      const text = resultErrorText(message);
      if (pendingCall?.sessionId && text !== null) {
        try {
          options.recordToolCall({
            sessionId: pendingCall.sessionId,
            toolName: pendingCall.toolName,
            args: pendingCall.args,
            resultText: text,
            isError: true,
            durationMs: Math.round(now() - pendingCall.startedAt),
          });
        } catch (error) {
          console.error("[MCP] record invalid tool call failed:", error);
        }
      }
      pending.delete(key);
    }
    await originalSend(message, sendOptions);
  };

  return {
    markHandled: (requestId: RequestId) => {
      pending.delete(requestKey(requestId));
    },
  };
}
