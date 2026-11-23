import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config";
import { app } from "./index";
import { setServiceComponents } from "./status";

const login = "phone@example.com";
const dir = mkdtempSync(join(tmpdir(), "upload-token-"));
const configPath = join(dir, "config.toml");
const config = await loadConfig();
let secret: string;
const previousPassword = process.env.AUTH_PASSWORD;

function cli(...args: string[]) {
  return Bun.spawnSync([process.execPath, "src/service.ts", "upload-token", ...args], {
    env: { ...process.env, TIMELINE_CONFIG: configPath },
  });
}

beforeAll(async () => {
  mkdirSync(join(dir, "calls"));
  writeFileSync(configPath, `[inbox]
archive_path=${JSON.stringify(join(dir, "archive"))}
[inbox.sources.calls]
type="local"
local=${JSON.stringify(join(dir, "calls"))}
account="test-phone"
parser="sms-backup-restore"
patterns=["*.xml"]
`);
  const sourceConfig = await loadConfigFromFixture();
  config.inbox = sourceConfig.inbox;
  setServiceComponents({ config, watcherEnabled: true });
  const issued = cli("create", "--label", "test-phone", "--source", "calls", "--tailnet-login", login);
  expect(issued.exitCode).toBe(0);
  secret = issued.stdout.toString().trim();
  expect(/^tlu_[A-Za-z0-9_-]{43}$/.test(secret)).toBe(true);
  process.env.AUTH_PASSWORD = crypto.randomUUID();
});

async function loadConfigFromFixture() {
  const previous = process.env.TIMELINE_CONFIG;
  process.env.TIMELINE_CONFIG = configPath;
  try { return await loadConfig(); }
  finally { process.env.TIMELINE_CONFIG = previous; }
}

afterAll(() => {
  if (previousPassword === undefined) delete process.env.AUTH_PASSWORD;
  else process.env.AUTH_PASSWORD = previousPassword;
  setServiceComponents({ watcherEnabled: false });
});

function request(path: string, init: RequestInit = {}, peerAddress = "127.0.0.1") {
  return app.request(path, { ...init, headers: {
    Authorization: `Bearer ${secret}`, "Tailscale-User-Login": login, ...init.headers,
  } }, { peerAddress });
}

function upload(source: string, filename = "calls.xml", contents = "<calls/>") {
  const body = new FormData();
  body.append("source", source);
  body.append("file", new File([contents], filename));
  return request("/api/inbox/upload", { method: "POST", body });
}

test("only the named source accepts the file", async () => {
  const response = await upload("calls");
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await Bun.file(join(dir, "calls", "calls.xml")).text()).toBe("<calls/>");
  expect((await upload("other")).status).toBe(403);
});

test("identical retries succeed in the inbox and archive without rewriting", async () => {
  const name = "retry.xml";
  const inbox = join(dir, "calls", name);
  const archive = join(dir, "archive", "calls", name);
  expect((await upload("calls", name)).status).toBe(200);
  for (const path of [inbox, archive]) {
    if (path === archive) {
      mkdirSync(join(dir, "archive", "calls"), { recursive: true });
      renameSync(inbox, archive);
    }
    const before = statSync(path, { bigint: true });
    const retry = await upload("calls", name);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ success: true, filename: name, jobId: expect.any(Number) });
    const conflict = await upload("calls", name, "<other/>");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "filename_in_use" });
    expect(await Bun.file(path).text()).toBe("<calls/>");
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    expect(existsSync(inbox)).toBe(path === inbox);
  }
});

test("simultaneous same-name token uploads preserve the winner", async () => {
  const directory = join(dir, "calls");
  for (const [name, second] of [["equal.xml", "<calls/>"], ["different.xml", "<other/>"]] as const) {
    const before = readdirSync(directory);
    const contents = ["<calls/>", second];
    const responses = await Promise.all(contents.map(bytes => upload("calls", name, bytes)));
    const statuses = responses.map(response => response.status);
    expect([...statuses].sort()).toEqual(second === contents[0] ? [200, 200] : [200, 409]);
    expect(await Bun.file(join(directory, name)).text()).toBe(contents[statuses.indexOf(200)]);
    expect(readdirSync(directory).sort()).toEqual([...before, name].sort());
  }
});

test("uploads require an archive and a fixed-account parser", async () => {
  const archive = config.inbox.archive_path;
  delete config.inbox.archive_path;
  try {
    const res = await upload("calls");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "source_not_token_eligible" });
  } finally { config.inbox.archive_path = archive; }
  const source = config.inbox.sources.calls;
  const previous = source.parser;
  source.parser = "google-takeout";
  try {
    const res = await upload("calls");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "source_not_token_eligible" });
  } finally { source.parser = previous; }
});

test("a shared source directory refuses token uploads", async () => {
  config.inbox.sources.shared = { ...config.inbox.sources.calls };
  try { expect((await upload("calls")).status).toBe(403); }
  finally { delete config.inbox.sources.shared; }
});

test("other paths refuse a token", async () => {
  for (const path of ["/api/events", "/api/events/1", "/api/media/file", "/api/day", "/status.md", "/mcp", "/api/sync/sources"]) {
    expect((await request(path)).status).toBe(403);
  }
});

const whoami = "/api/upload/whoami";
test("identity requires a loopback peer and matching login", async () => {
  const missing = await app.request(whoami, { headers: { Authorization: `Bearer ${secret}` } }, { peerAddress: "127.0.0.1" });
  expect(missing.status).toBe(403);
  expect(await missing.json()).toEqual({ error: "tailnet_only" });
  expect((await request(whoami, { headers: { "Tailscale-Funnel-Request": "?1" } })).status).toBe(403);
  expect((await request(whoami, {}, "192.0.2.1")).status).toBe(403);
  expect((await request(whoami, { headers: { "Tailscale-User-Login": "other@example.com" } })).status).toBe(403);
  expect(await (await request(whoami)).json()).toEqual({ label: "test-phone", sources: ["calls"], tailnet_login: login });
});

test("the upload body limit precedes multipart parsing", async () => {
  const res = await request("/api/inbox/upload", { method: "POST", body: new Uint8Array(5 * 1024 * 1024 + 1) });
  expect(res.status).toBe(413);
});

test("password login issues a usable cookie", async () => {
  const res = await app.request("/api/auth/status", { headers: { Authorization: "Basic " + btoa(":" + process.env.AUTH_PASSWORD) } });
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Login did not issue a cookie");
  expect((await (await app.request("/api/auth/status", { headers: { Cookie: cookie } })).json()).authenticated).toBe(true);
});

test("a fresh token gets 120 requests, then Retry-After", async () => {
  const issued = cli("create", "--label", "rate-test", "--source", "calls", "--tailnet-login", login);
  expect(issued.exitCode).toBe(0);
  const headers = { Authorization: "Bearer " + issued.stdout.toString().trim() };
  for (let i = 0; i < 120; i++) expect((await request(whoami, { headers })).status).toBe(200);
  const limited = await request(whoami, { headers });
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
});

test("list records usage without secrets and revocation is immediate", async () => {
  expect(cli("list").stdout.toString().includes(secret)).toBe(false);
  expect(JSON.parse(cli("list").stdout.toString()).find((row: { label: string }) => row.label === "test-phone").last_used_at).toBeTruthy();
  const create = () => cli("create", "--label", "test-phone", "--source", "calls", "--tailnet-login", login);
  expect(create().stderr.toString()).toContain("An active upload token already has label: test-phone");
  expect(cli("revoke", "test-phone").exitCode).toBe(0);
  expect(create().exitCode).toBe(0);
  expect((await request(whoami)).status).toBe(401);
  expect((await request(whoami, { headers: { Authorization: "Bearer tlu_" + crypto.randomUUID() } })).status).toBe(401);
});
