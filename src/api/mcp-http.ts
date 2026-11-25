/**
 * MCP HTTP Transport Handler
 *
 * Handles MCP over Streamable HTTP transport for Claude.ai integration.
 * Each session (Claude.ai chat) gets its own transport + server instance.
 */

import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { SemanticSearch } from "../embeddings/search";
import { getAppStateDb } from "../db/app-state";
import type { QueryExecutor } from "../db/pool";
import { memoryInstructions } from "../mcp/memory";
import {
  hashMcpToken,
  type InvalidToolCallRecorder,
  pruneMcpRecords,
  recordInvalidToolCallsFromTransport,
  recordMcpToolCall,
  upsertMcpSession,
  type RecordToolCallInput,
} from "../mcp/recording";
import { registerTools } from "../mcp-tools";
import { PRODUCT_VERSION } from "../product-version";
import { validateMcpToken, isMcpEnabled, getMcpBearerToken } from "./mcp-tokens";

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  createdAt: number;
}

// Session timeout: 1 hour of inactivity
export const FUNNEL_HEADER = "Tailscale-Funnel-Request";

const SESSION_TIMEOUT_MS = 60 * 60 * 1000;

// Cleanup interval: every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Create the MCP HTTP handler with the given database connections.
 *
 * @param readDb - Pool or executor for readonly queries
 * @param writeDb - Writable database handle for mutation tools (e.g. Trakt correction)
 * @param options.publicUrl - Public URL of the timeline web app, spliced into tool descriptions so agents can return clickable /event/<id> links.
 * @param options.semanticSearch - Embedding model and index for the semantic_search tool.
 */
export function createMcpHandler(
  readDb: QueryExecutor,
  writeDb: Database,
  options: { publicUrl?: string; semanticSearch?: SemanticSearch } = {},
) {
  const sessions = new Map<string, McpSession>();

  const hour = 60 * 60 * 1000;
  const failureWindow = 15 * 60 * 1000;
  const requests = new Map<string, number[]>();
  const failures = new Map<string, number[]>();

  function limited(until: number, now: number) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil((until - now) / 1000)) },
    });
  }

  // Periodically clean up stale sessions
  setInterval(() => {
    const now = Date.now();
    for (const [source, times] of failures) {
      if (times[times.length - 1] + failureWindow <= now) failures.delete(source);
    }
    for (const [sessionId, session] of sessions) {
      if (now - session.createdAt > SESSION_TIMEOUT_MS) {
        console.log(`[MCP] Cleaning up stale session: ${sessionId}`);
        session.transport.close();
        sessions.delete(sessionId);
      }
    }
    try {
      pruneMcpRecords();
    } catch (error) {
      console.error("[MCP] Failed to prune recorded tool calls:", error);
    }
  }, CLEANUP_INTERVAL_MS);

  function createSession(tokenHash: string): {
    transport: WebStandardStreamableHTTPServerTransport;
    server: McpServer;
  } {
    const server = new McpServer(
      { name: "timeline", version: PRODUCT_VERSION },
      { instructions: memoryInstructions(getAppStateDb()) },
    );
    let invalidRecorder: InvalidToolCallRecorder | undefined;

    function persistToolCall(rec: Omit<RecordToolCallInput, "sessionId"> & {
      sessionId?: string;
      requestId?: RequestId;
    }): void {
      try {
        const sessionId = rec.sessionId;
        if (!sessionId) {
          console.warn("[MCP] Skipping HTTP tool call recording without a session id");
          return;
        }
        const client = server.server.getClientVersion();
        upsertMcpSession({
          id: sessionId,
          transport: "http",
          clientName: client?.name ?? null,
          clientVersion: client?.version ?? null,
          tokenHash,
        });
        recordMcpToolCall({
          sessionId,
          toolName: rec.toolName,
          args: rec.args,
          resultText: rec.resultText,
          isError: rec.isError,
          durationMs: rec.durationMs,
        });
      } finally {
        if (rec.requestId !== undefined) invalidRecorder?.markHandled(rec.requestId);
      }
    }

    registerTools(server, readDb, writeDb, {
      publicUrl: options.publicUrl,
      semanticSearch: options.semanticSearch,
      recordToolCall: persistToolCall,
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        console.log(`[MCP] New session initialized: ${sessionId}`);
        sessions.set(sessionId, {
          transport,
          server,
          createdAt: Date.now(),
        });
      },
      onsessionclosed: (sessionId: string | undefined) => {
        if (sessionId) {
          console.log(`[MCP] Session closed: ${sessionId}`);
          sessions.delete(sessionId);
        }
      },
    });

    transport.onerror = (error) => {
      console.error("[MCP] Transport error:", error);
    };

    server.server.onerror = (error) => {
      console.error("[MCP] Server error:", error);
    };

    server.connect(transport);
    invalidRecorder = recordInvalidToolCallsFromTransport(transport, {
      sessionId: () => transport.sessionId,
      recordToolCall: persistToolCall,
    });
    return { transport, server };
  }

  return {
    async handleMcpRequest(req: Request, pathToken?: string): Promise<Response> {
      if (!isMcpEnabled()) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "MCP not enabled. Set MCP_TOKENS env var." },
          id: null,
        }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }

      const token = getMcpBearerToken(req.headers.get("Authorization")) ?? pathToken ?? "";
      const funnel = req.headers.has(FUNNEL_HEADER);
      const now = Date.now();
      const source = req.headers.get("X-Forwarded-For") ?? "";
      const recentFailures = funnel ? failures.get(source) : undefined;
      if (recentFailures && recentFailures.length >= 10) {
        const until = recentFailures[9] + failureWindow;
        if (now < until) return limited(until, now);
      }
      if (!validateMcpToken(token)) {
        if (funnel) {
          const recent = (recentFailures ?? []).filter(time => time > now - failureWindow);
          recent.push(now);
          failures.set(source, recent);
          if (recent.length >= 10) return limited(now + failureWindow, now);
        }
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized: Invalid MCP token" },
          id: null,
        }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (funnel) {
        const key = hashMcpToken(token);
        const recent = (requests.get(key) ?? []).filter(time => time > now - hour);
        if (recent.length >= 600) return limited(recent[0] + hour, now);
        recent.push(now);
        requests.set(key, recent);
      }

      const sessionId = req.headers.get("mcp-session-id");

      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          session.createdAt = Date.now();
          return session.transport.handleRequest(req);
        }

        // Session ID was provided but not found (expired or server restarted).
        // Return 404 so the client knows to re-initialize rather than routing
        // to a new transport which would confusingly return "Server not initialized".
        console.log(`[MCP] Session not found: ${sessionId} (expired or server restarted)`);
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found. Please re-initialize." },
          id: null,
        }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      const { transport } = createSession(hashMcpToken(token));
      return transport.handleRequest(req);
    },

    isMcpHttpEnabled(): boolean {
      return isMcpEnabled();
    },

    getMcpSessionCount(): number {
      return sessions.size;
    },
  };
}
