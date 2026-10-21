/**
 * MCP HTTP Transport Tests
 *
 * Smoke tests for the MCP Streamable HTTP endpoint.
 * Run with: bun test src/api/mcp.test.ts
 */

process.env.NODE_ENV = "test";
process.env.MCP_TOKENS = "test-token";

import { describe, expect, test } from "bun:test";
import { getAppStateDb } from "../db/app-state";
import { app } from "./index";

/** Parse the first JSON-RPC message from an SSE response body */
function parseSSE(body: string): unknown {
  const match = body.match(/^data: (.+)$/m);
  if (!match) throw new Error(`No SSE data line found in: ${body}`);
  return JSON.parse(match[1]);
}

const MCP_URL = "/mcp";
const LEGACY_MCP_URL = "/mcp/test-token";
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
const BEARER_HEADERS = {
  ...HEADERS,
  Authorization: "Bearer test-token",
};

function jsonrpc(id: number, method: string, params: unknown = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

describe("MCP HTTP Transport", () => {
  test("missing MCP_TOKENS disables MCP HTTP", async () => {
    const previousTokens = process.env.MCP_TOKENS;

    try {
      delete process.env.MCP_TOKENS;

      const res = await app.request(MCP_URL, {
        method: "POST",
        headers: BEARER_HEADERS,
        body: jsonrpc(1, "initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0.1.0" },
        }),
      });

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error.message).toContain("MCP not enabled");
    } finally {
      if (previousTokens === undefined) {
        delete process.env.MCP_TOKENS;
      } else {
        process.env.MCP_TOKENS = previousTokens;
      }
    }
  });

  test("initialize and call a tool with bearer token", async () => {
    // Initialize session
    const init = await app.request(MCP_URL, {
      method: "POST",
      headers: BEARER_HEADERS,
      body: jsonrpc(1, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      }),
    });

    expect(init.status).toBe(200);
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const initData = parseSSE(await init.text()) as any;
    expect(initData.result.serverInfo.name).toBe("timeline");

    // Call get_summary tool (no params → global stats)
    const call = await app.request(MCP_URL, {
      method: "POST",
      headers: { ...BEARER_HEADERS, "mcp-session-id": sessionId! },
      body: jsonrpc(2, "tools/call", {
        name: "get_summary",
        arguments: {},
      }),
    });

    expect(call.status).toBe(200);
    const callData = parseSSE(await call.text()) as any;
    expect(callData.result.content).toBeArray();
    expect(callData.result.content[0].type).toBe("text");
    expect(callData.result.content[0].text).toContain("Total events:");
  });

  test("records handler-level tool errors", async () => {
    const init = await app.request(MCP_URL, {
      method: "POST",
      headers: BEARER_HEADERS,
      body: jsonrpc(101, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      }),
    });
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    try {
      const call = await app.request(MCP_URL, {
        method: "POST",
        headers: { ...BEARER_HEADERS, "mcp-session-id": sessionId! },
        body: jsonrpc(102, "tools/call", {
          name: "get_contact_info",
          arguments: { contact: "definitely-not-a-contact" },
        }),
      });

      expect(call.status).toBe(200);
      const callData = parseSSE(await call.text()) as any;
      expect(callData.result.isError).toBe(true);

      const row = getAppStateDb()
        .prepare("SELECT tool_name, is_error, result_text FROM mcp_tool_calls WHERE session_id = ? ORDER BY id DESC LIMIT 1")
        .get(sessionId) as { tool_name: string; is_error: number; result_text: string } | null;
      expect(row?.tool_name).toBe("get_contact_info");
      expect(row?.is_error).toBe(1);
      expect(row?.result_text).toContain("not found");
    } finally {
      getAppStateDb().prepare("DELETE FROM mcp_sessions WHERE id = ?").run(sessionId);
    }
  });

  test("records schema-invalid tool calls rejected before the tool handler", async () => {
    const init = await app.request(MCP_URL, {
      method: "POST",
      headers: BEARER_HEADERS,
      body: jsonrpc(201, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      }),
    });
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    try {
      const call = await app.request(MCP_URL, {
        method: "POST",
        headers: { ...BEARER_HEADERS, "mcp-session-id": sessionId! },
        body: jsonrpc(202, "tools/call", {
          name: "run_sql",
          arguments: {},
        }),
      });

      expect(call.status).toBe(200);
      const callData = parseSSE(await call.text()) as any;
      expect(callData.result.isError).toBe(true);

      const rows = getAppStateDb()
        .prepare("SELECT tool_name, is_error, result_text FROM mcp_tool_calls WHERE session_id = ? ORDER BY id")
        .all(sessionId) as { tool_name: string; is_error: number; result_text: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_name).toBe("run_sql");
      expect(rows[0].is_error).toBe(1);
      expect(rows[0].result_text).toContain("Input validation error");
    } finally {
      getAppStateDb().prepare("DELETE FROM mcp_sessions WHERE id = ?").run(sessionId);
    }
  });

  test("legacy token-in-url initializes", async () => {
    const init = await app.request(LEGACY_MCP_URL, {
      method: "POST",
      headers: HEADERS,
      body: jsonrpc(1, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      }),
    });

    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeTruthy();
  });

  test("expired session returns 404", async () => {
    const res = await app.request(MCP_URL, {
      method: "POST",
      headers: {
        ...BEARER_HEADERS,
        "mcp-session-id": "nonexistent-session-id",
      },
      body: jsonrpc(1, "tools/call", {
        name: "get_summary",
        arguments: {},
      }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe(-32001);
    expect(json.error.message).toContain("Session not found");
  });

  test("invalid bearer token returns 401", async () => {
    const res = await app.request(MCP_URL, {
      method: "POST",
      headers: { ...HEADERS, Authorization: "Bearer wrong-token" },
      body: jsonrpc(1, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      }),
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.message).toContain("Unauthorized");
  });

  test("missing bearer token returns 401", async () => {
    const res = await app.request(MCP_URL, {
      method: "POST",
      headers: HEADERS,
      body: jsonrpc(1, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      }),
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.message).toContain("Unauthorized");
  });

  test("invalid legacy token returns 401", async () => {
    const res = await app.request("/mcp/wrong-token", {
      method: "POST",
      headers: HEADERS,
      body: jsonrpc(1, "initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      }),
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.message).toContain("Unauthorized");
  });
});
