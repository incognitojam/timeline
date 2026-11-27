process.env.NODE_ENV = "test";

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "../db/sqlite";
import { getAppStateDb, initAppStateDb } from "../db/app-state";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb } from "../db/schema";
import { app } from "./index";
import { readPublicAccess } from "./mcp";

const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const FUNNEL = { "Tailscale-Funnel-Request": "?1", "X-Forwarded-For": "198.51.100.7" };

function cli(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "src/service.ts", "mcp-token", ...args], { env: process.env });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function rpc(path: string, token: string | null, id: number, method: string, params: unknown, extra: Record<string, string> = {}) {
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return app.request(path, {
    method: "POST",
    headers: { ...HEADERS, ...auth, ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

function data(body: string) {
  const match = body.match(/^data: (.+)$/m);
  if (!match) throw new Error(`No SSE data in: ${body}`);
  return JSON.parse(match[1]);
}

async function open(token: string, path = "/mcp", extra: Record<string, string> = {}) {
  const res = await rpc(path, path === "/mcp" ? token : null, 1, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "example-client", version: "1" },
  }, extra);
  expect(res.status).toBe(200);
  const session = res.headers.get("mcp-session-id") ?? "";
  const init = data(await res.text());
  const sessionHeaders = { ...extra, "mcp-session-id": session };
  const initialized = await app.request(path, {
    method: "POST",
    headers: { ...HEADERS, ...(path === "/mcp" ? { Authorization: `Bearer ${token}` } : {}), ...sessionHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  expect(initialized.status).toBe(202);
  let id = 2;
  return {
    id: session,
    instructions: init.result.instructions as string,
    call: (method: string, params: unknown = {}) => rpc(path, path === "/mcp" ? token : null, id++, method, params, sessionHeaders),
  };
}

// Everything the process logs while these tests run, to check no token leaks.
const logged: string[] = [];
const spies = (["log", "warn", "error", "info"] as const).map(level =>
  spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); }));
const issued: string[] = [];
const previousEnv = process.env.MCP_TOKENS;

beforeAll(() => {
  process.env.MCP_TOKENS = "";
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  if (previousEnv === undefined) delete process.env.MCP_TOKENS;
  else process.env.MCP_TOKENS = previousEnv;
  getAppStateDb().exec("DELETE FROM mcp_tokens; DELETE FROM mcp_sessions; DELETE FROM memory_notes; DELETE FROM mcp_checkpoints");
});

function create(label: string, ...flags: string[]) {
  const token = cli("create", "--label", label, ...flags);
  expect(token).toMatch(/^tlm_[A-Za-z0-9_-]{43}$/);
  issued.push(token);
  return token;
}

describe("managed MCP tokens", () => {
  test("a created token works by header and by path, and is recorded by label", async () => {
    const token = create("laptop");
    const header = await open(token);
    const summary = await header.call("tools/call", { name: "get_schema", arguments: {} });
    expect(data(await summary.text()).result.content[0].text).toContain("Sources (event count, latest date):");

    const path = await open(token, `/mcp/${token}`);
    expect((await path.call("tools/list")).status).toBe(200);

    const [row] = JSON.parse(cli("list"));
    expect(row).toMatchObject({ label: "laptop", read_only: false, tailnet_only: false, last_client: "example-client", revoked_at: null });
    expect(row.last_used_at).toBeTruthy();
    // Both sessions are recorded at connect, though only one called a tool.
    for (const id of [header.id, path.id]) {
      expect(getAppStateDb().query("SELECT token_label, client_name FROM mcp_sessions WHERE id = ?").get(id))
        .toEqual({ token_label: "laptop", client_name: "example-client" });
    }

    const sessionsPage = await app.request("/api/mcp/sessions");
    expect(await sessionsPage.text()).toContain('"token_label":"laptop"');
  });

  test("a revoked token stops working at once, on an open session too", async () => {
    const token = create("phone");
    const session = await open(token);
    expect((await session.call("tools/list")).status).toBe(200);

    cli("revoke", "phone");
    const refused = await session.call("tools/list");
    expect(refused.status).toBe(401);
    expect(refused.headers.get("WWW-Authenticate")).toBe('Bearer error="invalid_token"');
    expect((await rpc("/mcp", token, 1, "initialize", {})).status).toBe(401);
    expect(() => cli("revoke", "phone")).toThrow("No live MCP token");
  });

  test("a revoked token stays refused when the same value is also in MCP_TOKENS", async () => {
    const token = create("overlap", "--read-only");
    process.env.MCP_TOKENS = token;
    try {
      cli("revoke", "overlap");
      expect((await rpc("/mcp", token, 1, "initialize", {})).status).toBe(401);
    } finally {
      process.env.MCP_TOKENS = "";
    }
  });

  test("a label cannot be only digits, so revoke by id is never ambiguous", () => {
    expect(() => cli("create", "--label", "7")).toThrow("A label cannot be only digits");
  });

  test("a read-only token is not offered the writing tools and cannot call one", async () => {
    const token = create("reader", "--read-only");
    const session = await open(token);
    expect(session.instructions).toContain("This connection is read-only");
    expect(session.instructions).not.toContain("save them with save_memory_note");

    const tools: { name: string; annotations: { readOnlyHint: boolean } }[] =
      data(await (await session.call("tools/list")).text()).result.tools;
    const names = tools.map(t => t.name);
    expect(names).toContain("list_memory");
    expect(names).toContain("run_sql");
    for (const name of ["save_memory_note", "delete_memory_note"]) {
      expect(names).not.toContain(name);
    }
    expect(tools.every(t => t.annotations.readOnlyHint)).toBe(true);

    const save = data(await (await session.call("tools/call", {
      name: "save_memory_note", arguments: { name: "probe", title: "Probe", summary: "x", details: "x", kind: "topic" },
    })).text());
    expect(save.result.isError).toBe(true);
    expect(save.result.content[0].text).toContain("save_memory_note disabled");
    expect(getAppStateDb().query("SELECT COUNT(*) AS n FROM memory_notes").get()).toEqual({ n: 0 });
  });

  test("a read-only token creates and moves a checkpoint, the one thing it writes", async () => {
    const session = await open(create("bookmarker", "--read-only"));
    const catchUp = async () => data(await (await session.call("tools/call", { name: "get_updates", arguments: { checkpoint: "reader" } })).text()).result.content[0].text as string;
    const position = () => (getAppStateDb().query("SELECT position FROM mcp_checkpoints WHERE name = 'reader'").get() as { position: number } | null)?.position;
    expect(await catchUp()).toContain('Next check: checkpoint="reader"');
    const first = position();
    expect(first).toBeDefined();
    const added = Number(getDb().prepare(`
      INSERT INTO events (source, source_id, type, timestamp, content, people, raw_data, conversation_id)
      VALUES ('discord', 'bookmark-1', 'message:dm', ?, 'are we still on?', '["discord:alice"]', '{}', 'dm-alice')
    `).run(new Date().toISOString()).lastInsertRowid);
    expect(await catchUp()).toContain(`Checkpoint "reader" is now at id:${added}.`);
    expect(position()).toBe(added);
  });

  test("every tool declares whether it writes, and a full token is offered the writing ones", async () => {
    const session = await open(create("writer"));
    const tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] =
      data(await (await session.call("tools/list")).text()).result.tools;
    expect(tools.filter(t => typeof t.annotations?.readOnlyHint !== "boolean")).toEqual([]);
    expect(tools.filter(t => !t.annotations?.readOnlyHint).map(t => t.name).sort())
      .toEqual(["delete_memory_note", "save_memory_note"]);
  });

  test("a session belongs to the token that opened it", async () => {
    const writer = create("owner");
    const reader = create("borrower", "--read-only");
    const session = await open(writer);
    const borrowed = await rpc("/mcp", reader, 9, "tools/list", {}, { "mcp-session-id": session.id });
    expect(borrowed.status).toBe(404);
    expect((await session.call("tools/list")).status).toBe(200);
  });

  test("a tailnet-only token is refused over Funnel like an unknown token and works without it", async () => {
    const token = create("home", "--tailnet-only");
    await open(token);
    const overFunnel = await rpc("/mcp", token, 1, "initialize", {}, FUNNEL);
    const unknown = await rpc("/mcp", "tlm_unknown", 1, "initialize", {}, FUNNEL);
    expect(overFunnel.status).toBe(401);
    expect(await overFunnel.text()).toBe(await unknown.text());
    expect(overFunnel.headers.get("WWW-Authenticate")).toBe(unknown.headers.get("WWW-Authenticate"));
    expect((await app.request(`/mcp/${token}`, { method: "POST", headers: { ...HEADERS, ...FUNNEL } })).status).toBe(401);

    // Like any wrong token, it counts toward the lockout: the tenth attempt from a source locks it out.
    const source = { ...FUNNEL, "X-Forwarded-For": "198.51.100.8" };
    for (let i = 0; i < 9; i++) expect((await rpc("/mcp", token, 1, "initialize", {}, source)).status).toBe(401);
    expect((await rpc("/mcp", token, 1, "initialize", {}, source)).status).toBe(429);
  });

  test("the token never appears in responses after creation, the recorded calls or the logs", async () => {
    const recorded = getAppStateDb().query<{ text: string }, []>(`
      SELECT COALESCE(args_json, '') || COALESCE(result_text, '') AS text FROM mcp_tool_calls
      UNION ALL SELECT id || COALESCE(token_hash, '') || COALESCE(token_label, '') FROM mcp_sessions
      UNION ALL SELECT label || token_sha256 FROM mcp_tokens
    `).all().map(r => r.text).join("\n");
    const listed = cli("list") + await (await app.request("/api/mcp/sessions")).text();
    for (const token of issued) {
      for (const text of [recorded, listed, logged.join("\n")]) expect(text).not.toContain(token);
    }
  });
});

describe("token routes", () => {
  const json = { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" };
  const body = (label: string, read_only = false) => JSON.stringify({ label, read_only, tailnet_only: false });

  test("create returns the token once; it works and the list never shows it", async () => {
    const created = await app.request("/api/mcp/tokens", { method: "POST", headers: json, body: body("web-made", true) });
    expect(created.status).toBe(201);
    expect(created.headers.get("Cache-Control")).toBe("no-store");
    const { id, token } = await created.json();
    expect(token).toMatch(/^tlm_/);
    issued.push(token);
    expect((await open(token)).instructions).toContain("read-only");

    process.env.MCP_TOKENS = "env-one,env-two";
    try {
      const listed = await app.request("/api/mcp/tokens");
      const text = await listed.text();
      expect(text).not.toContain(token);
      expect(text).not.toContain("env-one");
      const data = JSON.parse(text);
      expect(data.env_token_count).toBe(2);
      expect(data.tokens.find((t: { id: number }) => t.id === id)).toMatchObject({ label: "web-made", read_only: true, revoked_at: null });
    } finally {
      process.env.MCP_TOKENS = "";
    }

    expect((await app.request(`/api/mcp/tokens/${id}`, { method: "DELETE", headers: { "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
    expect((await rpc("/mcp", token, 1, "initialize", {})).status).toBe(401);
    expect((await app.request(`/api/mcp/tokens/${id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("cross-site and form requests cannot create or revoke, and bad input is refused", async () => {
    for (const headers of [{ ...json, "Sec-Fetch-Site": "cross-site" }, { ...json, "Sec-Fetch-Site": "same-site" }, { "Content-Type": "text/plain" }]) {
      expect((await app.request("/api/mcp/tokens", { method: "POST", headers, body: body("forged") })).status).toBe(403);
    }
    const [live] = JSON.parse(cli("list")).filter((t: { revoked_at: string | null }) => !t.revoked_at);
    expect((await app.request(`/api/mcp/tokens/${live.id}`, { method: "DELETE", headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await app.request("/api/mcp/tokens", { method: "POST", headers: json, body: JSON.stringify({ label: "x" }) })).status).toBe(400);
    const duplicate = await app.request("/api/mcp/tokens", { method: "POST", headers: json, body: body(live.label) });
    expect(duplicate.status).toBe(400);
    expect(JSON.parse(cli("list")).map((t: { label: string }) => t.label)).not.toContain("forged");
  });

  test("token routes are refused over Funnel and need the web password", async () => {
    for (const method of ["GET", "POST"]) {
      expect((await app.request("/api/mcp/tokens", { method, headers: { ...json, ...FUNNEL }, body: method === "POST" ? body("public") : undefined })).status).toBe(403);
    }
    expect((await app.request("/api/mcp/tokens/1", { method: "DELETE", headers: { ...json, ...FUNNEL } })).status).toBe(403);
    const previous = process.env.AUTH_PASSWORD;
    process.env.AUTH_PASSWORD = "example-password";
    try {
      expect((await app.request("/api/mcp/tokens")).status).toBe(401);
      expect((await app.request("/api/mcp/tokens", { method: "POST", headers: json, body: body("anon") })).status).toBe(401);
      expect((await app.request("/api/mcp/tokens/1", { method: "DELETE", headers: json })).status).toBe(401);
    } finally {
      if (previous === undefined) delete process.env.AUTH_PASSWORD;
      else process.env.AUTH_PASSWORD = previous;
    }
  });
});

test("an existing app-state database gains mcp_tokens and keeps its sessions", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE mcp_sessions (id TEXT PRIMARY KEY, transport TEXT NOT NULL, client_name TEXT, client_version TEXT,
    token_hash TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_activity_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO mcp_sessions (id, transport, client_name, token_hash) VALUES ('old', 'http', 'Old Client', 'abc');`);
  initAppStateDb(db);
  initAppStateDb(db);
  expect(db.query("SELECT id, client_name, token_hash, token_label FROM mcp_sessions").all())
    .toEqual([{ id: "old", client_name: "Old Client", token_hash: "abc", token_label: null }]);
  expect(db.query("SELECT COUNT(*) AS n FROM mcp_tokens").get()).toEqual({ n: 0 });
});

describe("connect details", () => {
  const dir = join(homedir(), ".local", "share", "timeline");
  const connect = async (headers: Record<string, string> = {}) => app.request("/api/mcp/connect", { headers });

  test("public access follows the menu bar app's record", async () => {
    rmSync(join(dir, "tailscale"), { recursive: true, force: true });
    expect(await (await connect()).json()).toEqual({ public_url: null, public_access: { state: "unavailable" } });

    mkdirSync(join(dir, "tailscale"), { recursive: true });
    const record = join(dir, "tailscale-public-access");
    try {
      expect(readPublicAccess()).toEqual({ state: "off" });
      const now = Math.floor(Date.now() / 1000);
      writeFileSync(record, `${now - 60} ${now + 3600}`);
      expect(readPublicAccess()).toEqual({ state: "on", until: new Date((now + 3600) * 1000).toISOString() });
      // Read as the menu bar app reads it: extra spaces are fine, a newline is not.
      writeFileSync(record, `${now - 60}  ${now + 3600}`);
      expect(readPublicAccess().state).toBe("on");
      for (const stale of [`${now - 7200} ${now - 60}`, `${now + 60} ${now + 3600}`, `${now} ${now + 2 * 86400}`, `${now - 60} ${now + 3600}\n`, "garbage"]) {
        writeFileSync(record, stale);
        expect(readPublicAccess()).toEqual({ state: "off" });
      }
      writeFileSync(record, `${now - 60} ${now + 3600}`);
      writeFileSync(join(dir, "tailscale.disabled"), "");
      expect(readPublicAccess()).toEqual({ state: "unavailable" });
    } finally {
      rmSync(join(dir, "tailscale"), { recursive: true, force: true });
      rmSync(record, { force: true });
      rmSync(join(dir, "tailscale.disabled"), { force: true });
    }
  });

  test("is refused over Funnel", async () => {
    expect((await connect(FUNNEL)).status).toBe(403);
  });
});
