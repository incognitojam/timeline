process.env.NODE_ENV = "test";

import { expect, test } from "bun:test";
import { getAppStateDb } from "../db/app-state";
import { app } from "./index";

const FUNNEL = { "Tailscale-Funnel-Request": "?1", "X-Forwarded-For": "198.51.100.7" };
const SAME_ORIGIN = { "Sec-Fetch-Site": "same-origin" };

function addCheckpoint(name: string) {
  getAppStateDb().query("INSERT INTO mcp_checkpoints (name, position, moves, used_at) VALUES (?, 0, '[]', ?)").run(name, new Date().toISOString());
}

test("checkpoints are listed and one is deleted by name, from the page only", async () => {
  addCheckpoint("route-keep");
  addCheckpoint("route-drop");
  const names = async () => ((await (await app.request("/api/mcp/checkpoints")).json()).checkpoints as { name: string }[]).map((c) => c.name);
  expect(await names()).toEqual(expect.arrayContaining(["route-keep", "route-drop"]));

  expect((await app.request("/api/mcp/checkpoints/route-drop", { method: "DELETE", headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
  expect((await app.request("/api/mcp/checkpoints/route-drop", { method: "DELETE", headers: SAME_ORIGIN })).status).toBe(200);
  expect((await app.request("/api/mcp/checkpoints/route-drop", { method: "DELETE", headers: SAME_ORIGIN })).status).toBe(404);
  expect((await app.request(`/api/mcp/checkpoints/${encodeURIComponent("route-%")}`, { method: "DELETE", headers: SAME_ORIGIN })).status).toBe(404);
  const left = await names();
  expect(left).toContain("route-keep");
  expect(left).not.toContain("route-drop");
});

test("checkpoint routes are refused over Funnel and need the web password", async () => {
  addCheckpoint("route-public");
  expect((await app.request("/api/mcp/checkpoints", { headers: FUNNEL })).status).toBe(403);
  expect((await app.request("/api/mcp/checkpoints/route-public", { method: "DELETE", headers: { ...SAME_ORIGIN, ...FUNNEL } })).status).toBe(403);
  const previous = process.env.AUTH_PASSWORD;
  process.env.AUTH_PASSWORD = "example-password";
  try {
    expect((await app.request("/api/mcp/checkpoints")).status).toBe(401);
    expect((await app.request("/api/mcp/checkpoints/route-public", { method: "DELETE", headers: SAME_ORIGIN })).status).toBe(401);
  } finally {
    if (previous === undefined) delete process.env.AUTH_PASSWORD;
    else process.env.AUTH_PASSWORD = previous;
  }
  expect(getAppStateDb().query("SELECT name FROM mcp_checkpoints WHERE name = 'route-public'").get()).toEqual({ name: "route-public" });
});
