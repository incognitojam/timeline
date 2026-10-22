import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAppStateDb } from "../db/app-state";
import { upsertSyncSourcePatch } from "../sync/config";
import { remoteAgentsPaths } from "../sync/remote-agents";
import { REMOTE_AGENTS_SOURCE } from "../sync/sources/remote-agents";
import { createRemoteAgentsRoutes } from "./remote-agents";

const BASE = "/api/sync/sources/remote-agents/ssh";
const hasSshTools = Bun.which("ssh-keygen") !== null && Bun.which("ssh-keyscan") !== null;

describe("remote-agents SSH routes", () => {
  let dir: string;
  let app: ReturnType<typeof createRemoteAgentsRoutes>;

  const post = (path: string, body?: unknown) =>
    app.request(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeEach(() => {
    dir = join(tmpdir(), `remote-agents-api-${randomUUID()}`);
    const paths = remoteAgentsPaths(dir);
    app = createRemoteAgentsRoutes(() => paths);
    getAppStateDb().prepare("DELETE FROM sync_sources WHERE source = ?").run(REMOTE_AGENTS_SOURCE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    getAppStateDb().prepare("DELETE FROM sync_sources WHERE source = ?").run(REMOTE_AGENTS_SOURCE);
  });

  it("reports no key or host before setup", async () => {
    const res = await app.request(BASE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: null, authorizedKeysLine: null, host: null });
  });

  it.skipIf(!hasSshTools)("generates a key, refuses to overwrite it silently, and rotates on request", async () => {
    const created = await post("/key", {});
    expect(created.status).toBe(200);
    const { publicKey, authorizedKeysLine } = (await created.json()) as { publicKey: string; authorizedKeysLine: string };
    expect(publicKey).toStartWith("ssh-ed25519 ");
    expect(authorizedKeysLine).toBe(`restrict,command="~/.local/bin/timeline-export" ${publicKey}`);

    expect((await post("/key", {})).status).toBe(409);

    const rotated = await post("/key", { replace: true });
    expect(rotated.status).toBe(200);
    expect(((await rotated.json()) as { publicKey: string }).publicKey).not.toBe(publicKey);
  });

  it("requires a key and saved host settings before testing", async () => {
    expect((await post("/test")).status).toBe(400);
    expect((await post("/trust", { fingerprint: "nope" })).status).toBe(400);
  });

  it.skipIf(!hasSshTools)("reports an unreachable host as a failed test, without trusting anything", async () => {
    await post("/key", {});
    // Port 1 on loopback refuses immediately, so the host-key scan fails fast.
    upsertSyncSourcePatch(REMOTE_AGENTS_SOURCE, {
      settings: { ssh_target: "alice@127.0.0.1", ssh_port: 1, account: "alice@agent-host" },
    });

    const state = (await (await app.request(BASE)).json()) as { host: { label: string; trusted: boolean } };
    expect(state.host).toEqual({ label: "alice@127.0.0.1:1", trusted: false });

    const tested = await post("/test");
    expect(tested.status).toBe(200);
    const body = (await tested.json()) as { status: string; error: string };
    expect(body.status).toBe("error");
    expect(body.error).toContain("Could not read an ed25519 host key from alice@127.0.0.1:1");

    const trusted = await post("/trust", { fingerprint: "SHA256:example" });
    expect(((await trusted.json()) as { status: string }).status).toBe("error");
  });
});
