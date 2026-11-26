/**
 * MCP tokens: managed tokens in app-state.db's mcp_tokens, plus the older
 * comma-separated MCP_TOKENS env var, whose tokens have full access.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parseArgs } from "node:util";
import { getAppStateDb } from "../db/app-state";

/** Hex SHA-256 of a bearer token, the form tokens are stored and compared in. */
export function tokenSha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** What a token may do. `id` and `label` are null for an MCP_TOKENS token. */
export interface McpAccess {
  hash: string;
  id: number | null;
  label: string | null;
  readOnly: boolean;
  tailnetOnly: boolean;
}

export interface McpTokenRow {
  id: number;
  label: string;
  read_only: number;
  tailnet_only: number;
  created_at: string;
  last_used_at: string | null;
  last_client: string | null;
  revoked_at: string | null;
}

export function envTokens(): string[] {
  return process.env.MCP_TOKENS?.split(",").map(t => t.trim()).filter(Boolean) ?? [];
}

/** True when any MCP token exists: an MCP_TOKENS value or a live managed token. */
export function isMcpEnabled(): boolean {
  return envTokens().length > 0 ||
    !!getAppStateDb().query("SELECT 1 FROM mcp_tokens WHERE revoked_at IS NULL LIMIT 1").get();
}

/** The access a token's hash grants now, or null if it is unknown or revoked. */
export function mcpAccessForHash(hash: string): McpAccess | null {
  const row = getAppStateDb().query<{ id: number; label: string; read_only: number; tailnet_only: number; revoked_at: string | null }, [string]>(
    "SELECT id, label, read_only, tailnet_only, revoked_at FROM mcp_tokens WHERE token_sha256 = ?"
  ).get(hash);
  // A revoked token stays refused even if the same value is also in MCP_TOKENS.
  if (row?.revoked_at) return null;
  if (row) return { hash, id: row.id, label: row.label, readOnly: !!row.read_only, tailnetOnly: !!row.tailnet_only };
  const given = Buffer.from(hash, "hex");
  const env = envTokens().some(token => timingSafeEqual(Buffer.from(tokenSha256(token), "hex"), given));
  return env ? { hash, id: null, label: null, readOnly: false, tailnetOnly: false } : null;
}

export function mcpAccess(token: string): McpAccess | null {
  return token ? mcpAccessForHash(tokenSha256(token)) : null;
}

const lastTouched = new Map<number, number>();

/**
 * Record that a managed token was used: always at session start, with the
 * client's name (null if it gave none), otherwise at most once a minute.
 */
export function touchMcpToken(id: number, client?: string | null): void {
  const now = Date.now();
  if (client === undefined && now - (lastTouched.get(id) ?? 0) < 60_000) return;
  getAppStateDb().run(
    "UPDATE mcp_tokens SET last_used_at = CURRENT_TIMESTAMP, last_client = COALESCE(?, last_client) WHERE id = ?",
    [client ?? null, id],
  );
  lastTouched.set(id, now);
}

/** Create a managed token and return it; only its hash is kept. */
export function createMcpToken(input: { label: string; readOnly: boolean; tailnetOnly: boolean }): { id: number; token: string } {
  const label = input.label.trim();
  if (!label) throw new Error("Provide a label");
  // revoke takes an id or a label, so a label must not look like an id.
  if (/^\d+$/.test(label)) throw new Error("A label cannot be only digits");
  const token = "tlm_" + randomBytes(32).toString("base64url");
  const row = getAppStateDb().query<{ id: number }, [string, string, number, number]>(`
    INSERT INTO mcp_tokens (label, token_sha256, read_only, tailnet_only) VALUES (?, ?, ?, ?)
    ON CONFLICT(label) WHERE revoked_at IS NULL DO NOTHING RETURNING id
  `).get(label, tokenSha256(token), input.readOnly ? 1 : 0, input.tailnetOnly ? 1 : 0);
  if (!row) throw new Error(`A live MCP token already has the label: ${label}`);
  return { id: row.id, token };
}

export function listMcpTokens(): McpTokenRow[] {
  return getAppStateDb().query<McpTokenRow, []>(`
    SELECT id, label, read_only, tailnet_only, created_at, last_used_at, last_client, revoked_at
    FROM mcp_tokens ORDER BY revoked_at IS NOT NULL, created_at DESC, id DESC
  `).all();
}

/** Revoke a live token by id (all digits) or label; false if none matched. */
export function revokeMcpToken(idOrLabel: string): boolean {
  const column = /^\d+$/.test(idOrLabel) ? "id" : "label";
  return getAppStateDb().run(
    `UPDATE mcp_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE ${column} = ? AND revoked_at IS NULL`,
    [idOrLabel],
  ).changes > 0;
}

export function runMcpTokenCommand(args: string[]): void {
  const [command, ...rest] = args;
  if (command === "list" && !rest.length) {
    console.log(JSON.stringify(listMcpTokens().map(row => ({
      ...row, read_only: !!row.read_only, tailnet_only: !!row.tailnet_only,
    }))));
    return;
  }
  if (command === "revoke" && rest.length === 1) {
    if (!revokeMcpToken(rest[0])) throw new Error("No live MCP token with that id or label");
    return;
  }
  if (command !== "create") throw new Error("Expected mcp-token create, list, or revoke <id or label>");
  const { values } = parseArgs({ args: rest, options: {
    label: { type: "string" }, "read-only": { type: "boolean" }, "tailnet-only": { type: "boolean" },
  } });
  if (!values.label?.trim()) throw new Error("Provide --label");
  const { token } = createMcpToken({
    label: values.label, readOnly: !!values["read-only"], tailnetOnly: !!values["tailnet-only"],
  });
  console.log(token);
}

/**
 * Extract an MCP bearer token from an Authorization header.
 */
export function getMcpBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}
