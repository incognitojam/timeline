import { Hono } from "hono";
import type { QueryExecutor } from "../db/pool";
import { checkConversationRefresh, requestConversationRefresh } from "../sync/refresh";

/** Refreshing one conversation from the conversation view (see src/sync/refresh.ts). */
export function createConversationRefreshRoutes(readDb: QueryExecutor) {
  return new Hono()
    .get("/api/conversation/refresh", async (c) => {
      const source = c.req.query("source");
      const conversationId = c.req.query("conversationId");
      if (!source || !conversationId) return c.json({ error: "source and conversationId are required" }, 400);
      const check = await checkConversationRefresh(readDb, source, conversationId);
      return c.json(check.ok ? { refreshable: true } : { refreshable: false, reason: check.reason });
    })
    .post("/api/conversation/refresh", async (c) => {
      const body = await c.req.json().catch(() => null) as { source?: unknown; conversationId?: unknown } | null;
      const source = body?.source;
      const conversationId = body?.conversationId;
      if (typeof source !== "string" || typeof conversationId !== "string") {
        return c.json({ error: "source and conversationId are required" }, 400);
      }
      const outcome = await requestConversationRefresh(readDb, source, conversationId);
      if (!outcome.ok) return c.json({ error: outcome.reason }, 409);
      return c.json({ jobId: outcome.jobId, joined: outcome.joined });
    });
}
