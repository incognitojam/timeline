import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getAppStateDb } from "../db/app-state";
import { isDevelopmentMode } from "./auth";
import { getMcpBearerToken } from "./mcp-tokens";
import { uploadTokenHash } from "./upload-tokens";

interface UploadToken {
  id: number;
  label: string;
  sources: string;
  tailnet_login: string;
}

declare module "hono" {
  interface ContextVariableMap {
    uploadSources?: string[];
  }
}

const windows = new Map<number, { until: number; count: number }>();
const limitBody = bodyLimit({
  maxSize: 5 * 1024 * 1024,
  onError: c => c.json({ error: "upload_too_large" }, 413),
});

function rateLimit(id: number): number {
  const now = Date.now();
  let window = windows.get(id);
  if (!window || window.until <= now) {
    for (const [key, previous] of windows) {
      if (previous.until <= now) windows.delete(key);
    }
    window = { until: now + 3600_000, count: 0 };
    windows.set(id, window);
  }
  return ++window.count > 120 ? Math.ceil((window.until - now) / 1000) : 0;
}

export const uploadAuth: MiddlewareHandler<{ Bindings: { peerAddress?: string } }> = async (c, next) => {
  const secret = getMcpBearerToken(c.req.header("Authorization") ?? null);
  if (!secret?.startsWith("tlu_")) return next();

  const db = getAppStateDb();
  const token = db.query<UploadToken, [string]>(
    "SELECT id, label, sources, tailnet_login FROM upload_tokens WHERE token_sha256=? AND revoked_at IS NULL"
  ).get(uploadTokenHash(secret));
  if (!token) return c.json({ error: "Unauthorized" }, 401);

  const login = c.req.header("Tailscale-User-Login");
  const peer = c.env?.peerAddress;
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (!isDevelopmentMode() && (!login || !loopback)) {
    return c.json({ error: "tailnet_only" }, 403);
  }
  if (login !== undefined && login !== token.tailnet_login) return c.json({ error: "login_mismatch" }, 403);

  const retryAfter = rateLimit(token.id);
  if (retryAfter) {
    c.header("Retry-After", String(retryAfter));
    return c.json({ error: "rate_limited" }, 429);
  }

  const sources: string[] = JSON.parse(token.sources);
  if (c.req.method === "GET" && c.req.path === "/api/upload/whoami") {
    c.res = c.json({ label: token.label, sources, tailnet_login: login ?? null });
  } else if (c.req.method === "POST" && c.req.path === "/api/inbox/upload") {
    c.set("uploadSources", sources);
    const limited = await limitBody(c, next);
    if (limited) return limited;
  } else {
    return c.json({ error: "forbidden" }, 403);
  }
  if (c.res.ok) db.run("UPDATE upload_tokens SET last_used_at=CURRENT_TIMESTAMP WHERE id=?", [token.id]);
  return c.res;
};
