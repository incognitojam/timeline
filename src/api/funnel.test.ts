import { expect, test } from "bun:test";
import { app } from "./index";

test("Funnel serves only MCP and locks public requests after repeated authentication failures", async () => {
  const previous = process.env.MCP_TOKENS;
  process.env.MCP_TOKENS = "example-token";
  const headers = { "Tailscale-Funnel-Request": "?1", "mcp-session-id": "unknown-session" };
  try {
    for (const path of ["/", "/api/health", "/status", "/mcp/a/b"]) {
      const denied = await app.request(path, { headers });
      expect(denied.status).toBe(403);
      expect(await denied.text()).toBe("Forbidden");
    }
    expect((await app.request("/mcp", { headers, method: "OPTIONS" })).status).toBe(204);
    const initialized = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Tailscale-Funnel-Request": "?1",
        Authorization: "Bearer example-token",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.get("mcp-session-id")).toBeTruthy();
    for (let i = 0; i < 9; i++) {
      expect((await app.request("/mcp", { headers })).status).toBe(401);
    }
    const locked = await app.request("/mcp/invalid", { headers });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("Retry-After")).toBe("900");
    expect((await app.request("/mcp/invalid", {
      headers: { ...headers, "X-Forwarded-For": "192.0.2.1" },
    })).status).toBe(401);
    expect((await app.request("/mcp/example-token", { headers })).status).toBe(429);
    expect((await app.request("/mcp/example-token", {
      headers: { "mcp-session-id": "unknown-session" },
    })).status).toBe(404);
  } finally {
    if (previous === undefined) delete process.env.MCP_TOKENS;
    else process.env.MCP_TOKENS = previous;
  }
});
