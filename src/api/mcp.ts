/**
 * MCP API for the web app: managed tokens, get_updates checkpoints, and read access to recorded MCP
 * sessions and tool calls, which the MCP HTTP and stdio transports write.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Context, Hono } from "hono";
import { getAppStateDb } from "../db/app-state";
import type { QueryExecutor } from "../db/pool";
import { renderMcpSessionMarkdown } from "../mcp/render";
import { deleteCheckpoint, listCheckpoints, NEW_CHECKPOINT_DAYS } from "../mcp/updates";
import { getMcpSession, getMcpSessionStats, listMcpSessions, listMcpToolCalls } from "../mcp/recording";
import { createMcpToken, envTokens, listMcpTokens, revokeMcpToken } from "./mcp-tokens";
import { clampLimit, clampOffset } from "./query-params";

/** Only the web app's own page may change tokens: a cross-site or same-site request is refused. */
function crossSite(c: Context): boolean {
  const site = c.req.header("Sec-Fetch-Site");
  return site !== undefined && site !== "same-origin";
}

function loadMcpSessionDetail(id: string, query: Record<string, string>) {
  const session = getMcpSession(id);
  if (!session) return null;

  const limit = clampLimit(query.limit, 200, 500);
  const offset = clampOffset(query.offset);
  const calls = listMcpToolCalls(id, { limit, offset });
  const stats = getMcpSessionStats(id);
  return { session, calls, stats };
}

/** Longest public access the menu bar app offers, matching `PublicAccess.durations` in tools/timeline-app. */
const LONGEST_PUBLIC_ACCESS_S = 24 * 60 * 60;

export type PublicAccess =
  | { state: "unavailable" }
  | { state: "off" }
  | { state: "on"; until: string };

/**
 * What the menu bar app records about public access (see
 * tools/timeline-app/PublicAccess.swift): Remote Access is set up when its
 * state directory exists and it is not turned off, and public access is on
 * while `tailscale-public-access` holds a current "<start> <end>" record. The
 * app turns Funnel off whenever the record does not allow it, so this is what
 * Funnel is meant to be, not a check that it is reachable.
 */
export function readPublicAccess(now = Date.now()): PublicAccess {
  // The app writes these under the home directory whatever config.toml says.
  const dir = join(homedir(), ".local", "share", "timeline");
  if (!existsSync(join(dir, "tailscale")) || existsSync(join(dir, "tailscale.disabled"))) return { state: "unavailable" };
  let record: string;
  try {
    record = readFileSync(join(dir, "tailscale-public-access"), "utf8");
  } catch {
    return { state: "off" };
  }
  // Parsed as Swift's split(separator: " ") and Int() do.
  const parts = record.split(" ").filter(Boolean);
  const [start, end] = parts.map(part => (/^[+-]?\d+$/.test(part) ? Number(part) : Number.NaN));
  const seconds = now / 1000;
  if (parts.length !== 2 || !Number.isInteger(start) || !Number.isInteger(end)
    || start > seconds || seconds >= end || end - start > LONGEST_PUBLIC_ACCESS_S) return { state: "off" };
  return { state: "on", until: new Date(end * 1000).toISOString() };
}

export const createMcpRoutes = (options: { db: QueryExecutor; publicUrl?: string }) => new Hono()
  // What the page needs to tell a client where to connect; never a token.
  .get("/api/mcp/connect", (c) => c.json({
    public_url: options.publicUrl ?? null,
    public_access: readPublicAccess(),
  }))

  // Managed tokens, without their values; MCP_TOKENS values only as a count.
  .get("/api/mcp/tokens", (c) => {
    const tokens = listMcpTokens().map(row => ({ ...row, read_only: !!row.read_only, tailnet_only: !!row.tailnet_only }));
    return c.json({ tokens, env_token_count: envTokens().length });
  })

  // The only response that carries a token, which is never stored or shown again.
  .post("/api/mcp/tokens", async (c) => {
    if (crossSite(c) || c.req.header("Content-Type") !== "application/json") {
      return c.json({ error: "Create tokens from the MCP page." }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as { label?: unknown; read_only?: unknown; tailnet_only?: unknown } | null;
    if (typeof body?.label !== "string" || typeof body.read_only !== "boolean" || typeof body.tailnet_only !== "boolean") {
      return c.json({ error: "label must be a string, read_only and tailnet_only booleans" }, 400);
    }
    try {
      const { id, token } = createMcpToken({ label: body.label, readOnly: body.read_only, tailnetOnly: body.tailnet_only });
      c.header("Cache-Control", "no-store");
      return c.json({ id, token }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  })

  .delete("/api/mcp/tokens/:id{[0-9]+}", (c) => {
    if (crossSite(c)) return c.json({ error: "Revoke tokens from the MCP page." }, 403);
    if (!revokeMcpToken(c.req.param("id"))) return c.json({ error: "No live MCP token with that id" }, 404);
    return c.json({ ok: true });
  })

  // get_updates checkpoints, with when the event each stands at was added, and how far back a name new again starts.
  .get("/api/mcp/checkpoints", async (c) => c.json({ checkpoints: await listCheckpoints(options.db, getAppStateDb()), new_checkpoint_days: NEW_CHECKPOINT_DAYS }))

  // Forgets one bookmark; no event is touched.
  .delete("/api/mcp/checkpoints/:name", (c) => {
    if (crossSite(c)) return c.json({ error: "Delete checkpoints from the MCP page." }, 403);
    if (!deleteCheckpoint(getAppStateDb(), c.req.param("name"))) return c.json({ error: "No checkpoint with that name" }, 404);
    return c.json({ ok: true });
  })

  .get("/api/mcp/sessions", (c) => {
    const query = c.req.query();
    const limit = clampLimit(query.limit, 50, 200);
    const offset = clampOffset(query.offset);
    const sessions = listMcpSessions({ limit, offset });
    return c.json({ sessions, count: sessions.length });
  })

  .get("/api/mcp/sessions/:id{.+\\.md}", (c) => {
    const rawId = c.req.param("id");
    const id = rawId.endsWith(".md") ? rawId.slice(0, -3) : rawId;
    const detail = loadMcpSessionDetail(id, c.req.query());
    if (!detail) {
      return c.json({ error: "MCP session not found" }, 404);
    }

    const markdown = renderMcpSessionMarkdown(detail.session, detail.calls, detail.stats);
    return c.text(markdown, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  })

  .get("/api/mcp/sessions/:id", (c) => {
    const detail = loadMcpSessionDetail(c.req.param("id"), c.req.query());
    if (!detail) {
      return c.json({ error: "MCP session not found" }, 404);
    }

    const { session, calls, stats } = detail;
    return c.json({ session, calls, count: stats.call_count, stats });
  });
