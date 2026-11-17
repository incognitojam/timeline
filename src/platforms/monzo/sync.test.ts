import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createTokenManager } from "../../lib/oauth-tokens";
import { getDb, initDb } from "../../db/schema";
import { sync } from "./parser";
import { monzoSyncSource } from "./sync";

const configPath = join(homedir(), ".config/timeline/monzo.json");
const tokens = createTokenManager("monzo");
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  tokens.clear();
  rmSync(configPath, { force: true });
});

function configure() {
  mkdirSync(join(homedir(), ".config/timeline"), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    credentials: { client_id: "test-client", client_secret: "test-secret" },
  }));
}
function saveToken() {
  tokens.save({ access_token: "test-access", refresh_token: "test-refresh", expires_at: Date.now() + 3600000 });
}

test("headless CLI reports missing token through the real subprocess", async () => {
  configure();
  tokens.clear();
  const result = await monzoSyncSource.sync({ verbose: false, config: { sources: {} } });
  expect(result.success).toBe(false);
  expect(result.error).toContain("Monzo requires interactive OAuth (no valid token)");
  expect(result.error).toContain("monzo/parser.ts auth");
  expect(result.error).not.toContain("Bun v");
});

for (const status of [401, 403]) {
  test(`headless ${status} before and after refresh never schedules approval polling`, async () => {
    configure();
    saveToken();
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      return url.endsWith("/oauth2/token")
        ? Response.json({ access_token: "test-refreshed", refresh_token: "test-refresh", expires_in: 3600 })
        : Response.json({ error: "approval required" }, { status });
    }) as unknown as typeof fetch;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation((() => {
      throw new Error("Permanent auth failures must not schedule a delay");
    }) as unknown as typeof setTimeout);
    try {
      await expect(sync({ headless: true })).rejects.toThrow(`API error ${status}: {"error":"approval required"}`);
      expect(requests.map((url) => new URL(url).pathname)).toEqual(["/accounts", "/oauth2/token", "/accounts"]);
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });
}

test("a rejected refresh is attempted only once", async () => {
  configure();
  tokens.save({ access_token: "test-expired", refresh_token: "test-refresh", expires_at: 0 });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return Response.json({ error: "invalid_grant" }, { status: 401 });
  }) as unknown as typeof fetch;
  await expect(sync({ headless: true })).rejects.toThrow("invalid_grant");
  expect(calls).toBe(1);
});

for (const status of [503]) {
  test(`temporary ${status} is retried without triggering token refresh`, async () => {
    configure();
    saveToken();
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      expect(String(input)).toEndWith("/accounts");
      calls++;
      if (calls === 1) return Response.json({}, { status });
      return Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;
    await expect(sync({ headless: true })).rejects.toThrow("API error 404");
    expect(calls).toBe(2);
  });
}

test("subprocess failure record survives a multiline trace and Bun banner", async () => {
  const spawn = Bun.spawn;
  const reporter = new URL("./subprocess.ts", import.meta.url).pathname;
  const replacement = spyOn(Bun, "spawn").mockImplementation(((_command: unknown, options: object) =>
    spawn([process.execPath, "-e", `
      import { reportMonzoFailure } from ${JSON.stringify(reporter)};
      reportMonzoFailure(new Error("Synthetic login expired"));
      console.error("error: Synthetic login expired\\n    at sync (parser.js:10:1)\\n\\nBun v1.4.4");
      process.exitCode = 1;
    `], options)) as typeof Bun.spawn);
  try {
    const result = await monzoSyncSource.sync({ verbose: false, config: { sources: {} } });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Synthetic login expired");
  } finally {
    replacement.mockRestore();
  }
});

for (const verbose of [false, true]) {
  test(`subprocess success stats survive verbose=${verbose}`, async () => {
    const spawn = Bun.spawn;
    const replacement = spyOn(Bun, "spawn").mockImplementation(((_command: unknown, options: object) =>
      spawn([process.execPath, "-e", 'console.log("Imported: 7, Skipped: 2")'], options)) as typeof Bun.spawn);
    try {
      const result = await monzoSyncSource.sync({ verbose, config: { sources: {} } });
      expect(result.success).toBe(true);
      expect(result.eventsAdded).toBe(7);
    } finally {
      replacement.mockRestore();
    }
  });
}

test("legacy subprocess traces retain the error instead of only the version banner", async () => {
  const spawn = Bun.spawn;
  const replacement = spyOn(Bun, "spawn").mockImplementation(((_command: unknown, options: object) =>
    spawn([process.execPath, "-e", 'throw new Error("Synthetic login expired")'], options)) as typeof Bun.spawn);
  try {
    const result = await monzoSyncSource.sync({ verbose: false, config: { sources: {} } });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Synthetic login expired");
    expect(result.error).not.toMatch(/^Bun v/);
  } finally {
    replacement.mockRestore();
  }
});

for (const status of [503]) {
  test(`temporary refresh ${status} retries before reporting permanent rejection`, async () => {
    configure();
    tokens.save({ access_token: "test-expired", refresh_token: "test-refresh", expires_at: 0 });
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      expect(String(input)).toEndWith("/oauth2/token");
      calls++;
      return Response.json({}, { status: calls === 1 ? status : 401 });
    }) as unknown as typeof fetch;
    await expect(sync({ headless: true })).rejects.toThrow("no valid token");
    expect(calls).toBe(2);
  });
}

for (const expired of [false, true]) {
  test(`rate limiting during ${expired ? "refresh" : "account lookup"} preserves Retry-After without guessing a delay`, async () => {
    configure();
    tokens.save({ access_token: "test-access", refresh_token: "test-refresh", expires_at: expired ? 0 : Date.now() + 3600000 });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": "120" } });
    }) as unknown as typeof fetch;
    await expect(sync({ headless: true })).rejects.toThrow("Retry-After: 120");
    expect(calls).toBe(1);
  });
}

test("interactive sync waits for app approval and proceeds without refreshing", async () => {
  configure();
  saveToken();
  const db = getDb();
  initDb(db);
  db.run("INSERT INTO events (source, source_id, source_account, type, timestamp, raw_data) VALUES ('monzo', 'test-approval-test', 'test', 'transaction', ?, '{}')", [new Date().toISOString()]);
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    expect(String(input)).toEndWith("/accounts");
    calls++;
    return calls === 1 ? Response.json({}, { status: 403 }) : Response.json({ accounts: [] });
  }) as unknown as typeof fetch;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    queueMicrotask(callback);
    return 0;
  }) as unknown as typeof setTimeout);
  try {
    await sync({ headless: false });
    expect(calls).toBe(2);
    expect(timer).toHaveBeenCalledTimes(1);
    expect(timer.mock.calls[0]?.[1]).toBe(1000);
  } finally {
    timer.mockRestore();
    db.run("DELETE FROM events WHERE source = 'monzo' AND source_id = 'test-approval-test'");
    db.close();
  }
});
