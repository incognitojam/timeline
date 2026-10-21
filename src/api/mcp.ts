/**
 * MCP recording API.
 *
 * Read access to recorded MCP sessions and tool calls. Writes happen from the
 * MCP HTTP and stdio transports.
 */

import { Hono } from "hono";
import { renderMcpSessionMarkdown } from "../mcp/render";
import { getMcpSession, getMcpSessionStats, listMcpSessions, listMcpToolCalls } from "../mcp/recording";
import { clampLimit, clampOffset } from "./query-params";

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
