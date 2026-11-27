/**
 * MCP HTTP Transport Handler
 *
 * Handles MCP over Streamable HTTP transport for Claude.ai integration.
 * Each session (Claude.ai chat) gets its own transport + server instance.
 */

import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { SemanticSearch } from "../embeddings/search";
import { getAppStateDb } from "../db/app-state";
import type { QueryExecutor } from "../db/pool";
import {
  type InvalidToolCallRecorder,
  pruneMcpRecords,
  recordInvalidToolCallsFromTransport,
  recordMcpToolCall,
  upsertMcpSession,
  type RecordToolCallInput,
} from "../mcp/recording";
import { hiddenContactIds } from "../mcp/hidden-contacts";
import { mcpInstructions, registerTools } from "../mcp-tools";
import { PRODUCT_VERSION } from "../product-version";
import { getMcpBearerToken, isMcpEnabled, type McpAccess, mcpAccess, mcpAccessForHash, touchMcpToken } from "./mcp-tokens";

interface McpSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  createdAt: number;
  /** SHA-256 of the token that opened the session; only that token may use it. */
  tokenHash: string;
}

// Session timeout: 1 hour of inactivity
export const FUNNEL_HEADER = "Tailscale-Funnel-Request";

const SESSION_TIMEOUT_MS = 60 * 60 * 1000;

const sourceSalt = randomBytes(16);
const REFUSED_LOG_PER_MINUTE = 60;
let refusedLogMinute = 0;
let refusedLogged = 0;
let refusedSuppressed = 0;

/**
 * Log an MCP request refused before it reached a session, to diagnose clients
 * that cannot connect. Never the token, the Authorization value, the full
 * source or the body. At most 60 lines a minute, so the internet cannot fill
 * the disk; the next minute's first refusal reports how many were dropped.
 */
export function logRefusedMcpRequest(req: Request, status: number, path: "mcp" | "mcp-path-token" | "well-known" | "other") {
  const minute = Math.floor(Date.now() / 60_000);
  if (minute !== refusedLogMinute) {
    if (refusedSuppressed) {
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: "mcp.refused.suppressed", count: refusedSuppressed }));
    }
    refusedLogMinute = minute;
    refusedLogged = 0;
    refusedSuppressed = 0;
  }
  if (++refusedLogged > REFUSED_LOG_PER_MINUTE) {
    refusedSuppressed++;
    return;
  }
  const authorization = req.headers.get("Authorization");
  const source = req.headers.get("X-Forwarded-For");
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "mcp.refused",
    method: req.method,
    path,
    status,
    funnel: req.headers.has(FUNNEL_HEADER),
    authorization: authorization === null ? "none" : /^Bearer\s/i.test(authorization) ? "bearer" : "other",
    source: source ? createHash("sha256").update(sourceSalt).update(source).digest("hex").slice(0, 8) : null,
    userAgent: req.headers.get("User-Agent")?.slice(0, 80) ?? null,
    mcpProtocolVersion: req.headers.get("MCP-Protocol-Version")?.slice(0, 20) ?? null,
  }));
}

// Cleanup interval: every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Create the MCP HTTP handler with the given database connections.
 *
 * @param readDb - Pool or executor for readonly queries
 * @param options.publicUrl - Public URL of the timeline web app, named in the server instructions so agents can return clickable /event/<id> links.
 * @param options.semanticSearch - Embedding model and index for the semantic_search tool.
 */
export function createMcpHandler(
  readDb: QueryExecutor,
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
    try {
      // Close sessions that timed out or whose token was revoked.
      for (const [sessionId, session] of sessions) {
        if (now - session.createdAt > SESSION_TIMEOUT_MS || !mcpAccessForHash(session.tokenHash)) {
          console.log(`[MCP] Cleaning up stale session: ${sessionId}`);
          session.transport.close();
          sessions.delete(sessionId);
        }
      }
      pruneMcpRecords();
    } catch (error) {
      console.error("[MCP] Failed to clean up sessions or recorded tool calls:", error);
    }
  }, CLEANUP_INTERVAL_MS);

  function createSession(access: McpAccess, hiddenContacts: ReadonlySet<number>): {
    transport: WebStandardStreamableHTTPServerTransport;
    server: McpServer;
  } {
    const server = new McpServer(
      { name: "timeline", version: PRODUCT_VERSION },
      {
        instructions: mcpInstructions(getAppStateDb(), {
          publicUrl: options.publicUrl,
          readOnly: access.readOnly,
          hiddenContactIds: hiddenContacts,
        }),
      },
    );
    function recordSession(sessionId: string): void {
      const client = server.server.getClientVersion();
      upsertMcpSession({
        id: sessionId,
        transport: "http",
        clientName: client?.name.slice(0, 100) ?? null,
        clientVersion: client?.version.slice(0, 100) ?? null,
        tokenHash: access.hash.slice(0, 16),
        tokenLabel: access.label,
      });
    }
    // Once per session, when the client has named itself: record the session
    // and, for a managed token, its use and the client's name.
    let initialized = false;
    server.server.oninitialized = () => {
      if (initialized) return;
      initialized = true;
      try {
        if (transport.sessionId) recordSession(transport.sessionId);
        if (access.id !== null) touchMcpToken(access.id, server.server.getClientVersion()?.name.slice(0, 100) ?? null);
      } catch (error) {
        console.error("[MCP] Failed to record session or token use:", error);
      }
    };
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
        recordSession(sessionId);
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

    registerTools(server, readDb, {
      semanticSearch: options.semanticSearch,
      recordToolCall: persistToolCall,
      readOnly: access.readOnly,
    });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        console.log(`[MCP] New session initialized: ${sessionId}`);
        sessions.set(sessionId, {
          transport,
          server,
          createdAt: Date.now(),
          tokenHash: access.hash,
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
          error: { code: -32000, message: "MCP not enabled. Create a token with timeline-service mcp-token create." },
          id: null,
        }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }

      const refuse = (res: Response) => {
        logRefusedMcpRequest(req, res.status, pathToken === undefined ? "mcp" : "mcp-path-token");
        return res;
      };
      const token = getMcpBearerToken(req.headers.get("Authorization")) ?? pathToken ?? "";
      const funnel = req.headers.has(FUNNEL_HEADER);
      const now = Date.now();
      const source = req.headers.get("X-Forwarded-For") ?? "";
      const recentFailures = funnel ? failures.get(source) : undefined;
      if (recentFailures && recentFailures.length >= 10) {
        const until = recentFailures[9] + failureWindow;
        if (now < until) return refuse(limited(until, now));
      }
      // Unknown, revoked, and tailnet-only over Funnel are one answer.
      let access = mcpAccess(token);
      if (access?.tailnetOnly && funnel) access = null;
      if (!access) {
        // Hosted clients probe without credentials before connecting, from
        // shared addresses, so only a presented and wrong token counts.
        if (funnel && token) {
          const recent = (recentFailures ?? []).filter(time => time > now - failureWindow);
          recent.push(now);
          failures.set(source, recent);
          if (recent.length >= 10) return refuse(limited(now + failureWindow, now));
        }
        return refuse(new Response(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized: Invalid MCP token" },
          id: null,
        }), {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": token ? 'Bearer error="invalid_token"' : "Bearer",
          },
        }));
      }

      if (funnel) {
        const recent = (requests.get(access.hash) ?? []).filter(time => time > now - hour);
        if (recent.length >= 600) return refuse(limited(recent[0] + hour, now));
        recent.push(now);
        requests.set(access.hash, recent);
      }
      if (access.id !== null) {
        try {
          touchMcpToken(access.id);
        } catch (error) {
          console.error("[MCP] Failed to record token use:", error);
        }
      }

      const sessionId = req.headers.get("mcp-session-id");

      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session && session.tokenHash === access.hash) {
          session.createdAt = Date.now();
          return session.transport.handleRequest(req);
        }

        // Session ID was provided but not found (expired, server restarted, or
        // opened with another token). Return 404 so the client knows to
        // re-initialize rather than routing to a new transport which would
        // confusingly return "Server not initialized".
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

      const { transport } = createSession(access, await hiddenContactIds(readDb));
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
