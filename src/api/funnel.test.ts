import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { app } from "./index";

const FUNNEL = { "Tailscale-Funnel-Request": "?1" };
const MCP = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const initialize = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
});

let previous: string | undefined;
beforeEach(() => {
  previous = process.env.MCP_TOKENS;
  process.env.MCP_TOKENS = "example-token";
});
afterEach(() => {
  if (previous === undefined) delete process.env.MCP_TOKENS;
  else process.env.MCP_TOKENS = previous;
});

test("Funnel serves only MCP and locks a source out after repeated wrong tokens", async () => {
  const headers = { ...FUNNEL, "mcp-session-id": "unknown-session" };
  for (const path of ["/", "/api/health", "/api/memory/import", "/status", "/mcp/a/b"]) {
    const denied = await app.request(path, { headers });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe("Forbidden");
  }
  expect((await app.request("/mcp", { headers, method: "OPTIONS" })).status).toBe(204);
  const initialized = await app.request("/mcp", {
    method: "POST",
    headers: { ...FUNNEL, ...MCP, Authorization: "Bearer example-token" },
    body: initialize,
  });
  expect(initialized.status).toBe(200);
  expect(initialized.headers.get("mcp-session-id")).toBeTruthy();
  for (let i = 0; i < 9; i++) {
    expect((await app.request("/mcp", { headers: { ...headers, Authorization: "Bearer wrong-token" } })).status).toBe(401);
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
});

test("requests without credentials get a Bearer challenge and never lock a source out", async () => {
  const headers = { ...FUNNEL, "X-Forwarded-For": "192.0.2.20" };
  for (let i = 0; i < 15; i++) {
    const probe = await app.request("/mcp", { method: "POST", headers: { ...headers, ...MCP }, body: initialize });
    expect(probe.status).toBe(401);
    expect(probe.headers.get("WWW-Authenticate")).toBe("Bearer");
  }
  const connected = await app.request("/mcp", {
    method: "POST",
    headers: { ...headers, ...MCP, Authorization: "Bearer example-token" },
    body: initialize,
  });
  expect(connected.status).toBe(200);
});

test("OAuth discovery probes over Funnel get a 404", async () => {
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
  ]) {
    const res = await app.request(path, { headers: FUNNEL });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  }
});

test("refused MCP requests are logged without the token, header values or source", async () => {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
  try {
    await app.request("/mcp", {
      method: "POST",
      headers: {
        ...FUNNEL, ...MCP, "X-Forwarded-For": "192.0.2.30", Authorization: "Bearer wrong-secret-value",
        "User-Agent": `Example-Client/1.0 ${"x".repeat(200)}`, "MCP-Protocol-Version": "2025-06-18",
      },
      body: initialize,
    });
    await app.request("/mcp/wrong-path-secret", { headers: { ...FUNNEL, "X-Forwarded-For": "192.0.2.30" } });
    await app.request("/.well-known/oauth-protected-resource", { headers: FUNNEL });
  } finally {
    spy.mockRestore();
  }
  const refused = lines.filter(line => line.includes('"mcp.refused"')).map(line => JSON.parse(line));
  expect(refused).toHaveLength(3);
  expect(refused[0]).toMatchObject({
    method: "POST", path: "mcp", status: 401, funnel: true, authorization: "bearer",
    userAgent: `Example-Client/1.0 ${"x".repeat(80)}`.slice(0, 80), mcpProtocolVersion: "2025-06-18",
  });
  expect(refused[0].source).toMatch(/^[0-9a-f]{8}$/);
  expect(refused[1]).toMatchObject({ method: "GET", path: "mcp-path-token", status: 401, authorization: "none" });
  expect(refused[1].source).toBe(refused[0].source);
  expect(refused[2]).toMatchObject({ path: "well-known", status: 404, source: null });
  const text = lines.join("\n");
  for (const secret of ["wrong-secret-value", "wrong-path-secret", "192.0.2.30"]) expect(text).not.toContain(secret);
});
