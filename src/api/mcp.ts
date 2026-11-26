/**
 * MCP API for the web app: managed tokens, and read access to recorded MCP
 * sessions and tool calls, which the MCP HTTP and stdio transports write.
 */

import { type Context, Hono } from "hono";
import { renderMcpSessionMarkdown } from "../mcp/render";
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

export const mcpRoutes = new Hono()
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
