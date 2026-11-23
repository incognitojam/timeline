import { createHash, randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { sep } from "node:path";
import { parseArgs } from "node:util";
import { resolveSourcePath } from "../config";
import type { ServiceConfig } from "../config/types";
import { getAppStateDb } from "../db/app-state";
import { isTokenEligibleParser } from "../inbox/process";

export function uploadTokenHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export async function tokenSourceEligible(config: ServiceConfig, name: string): Promise<boolean> {
  const sources = config.inbox.sources;
  const source = sources[name];
  if (!config.inbox.archive_path || !Object.hasOwn(sources, name) || !source || source.enabled === false ||
      source.type !== "local" || !source.account?.trim() || !isTokenEligibleParser(source.parser)) return false;

  // Comparing filesystem identities also catches symlinks and case-insensitive aliases.
  const path = await realpath(resolveSourcePath(config, source)).catch(missingDirectory);
  if (!path) return false;
  const target = await stat(path, { bigint: true });
  if (!target.isDirectory()) return false;
  for (const [otherName, other] of Object.entries(sources)) {
    if (otherName === name) continue;
    const otherPath = await realpath(resolveSourcePath(config, other)).catch(missingDirectory);
    if (!otherPath) continue;
    if (path.startsWith(otherPath + sep) || otherPath.startsWith(path + sep)) return false;
    const dir = await stat(otherPath, { bigint: true });
    if (dir.dev === target.dev && dir.ino === target.ino) return false;
  }
  return true;
}

function missingDirectory(error: NodeJS.ErrnoException): undefined {
  if (error.code !== "ENOENT") throw error;
  return undefined;
}

export async function runUploadTokenCommand(config: ServiceConfig, args: string[]) {
  const [command, ...rest] = args;
  const db = getAppStateDb();
  if (command === "list" && !rest.length) {
    const rows = db.query<{ sources: string }, []>(
      "SELECT label, sources, tailnet_login, created_at, last_used_at, revoked_at FROM upload_tokens ORDER BY label"
    ).all();
    console.log(JSON.stringify(rows.map(row => ({ ...row, sources: JSON.parse(row.sources) }))));
    return;
  }
  if (command === "revoke" && rest.length === 1) {
    const result = db.run("UPDATE upload_tokens SET revoked_at=CURRENT_TIMESTAMP WHERE label=? AND revoked_at IS NULL", [rest[0]]);
    if (!result.changes) throw new Error("No active token with that label");
    return;
  }
  if (command !== "create") throw new Error("Expected upload-token create, list, or revoke <label>");
  const { values } = parseArgs({ args: rest, options: {
    label: { type: "string" }, source: { type: "string", multiple: true }, "tailnet-login": { type: "string" },
  } });
  const { label, source: sources, "tailnet-login": login } = values;
  if (!label?.trim() || !sources?.length || !login?.trim()) throw new Error("Provide --label, --source and --tailnet-login");
  for (const source of sources) {
    if (!await tokenSourceEligible(config, source)) {
      const reason = config.inbox.archive_path ? "" : " (configure [inbox].archive_path)";
      throw new Error(`Source is not token eligible: ${source}${reason}`);
    }
  }
  const secret = "tlu_" + randomBytes(32).toString("base64url");
  const inserted = db.run(`INSERT INTO upload_tokens(label, sources, tailnet_login, token_sha256) VALUES (?,?,?,?)
    ON CONFLICT(label) WHERE revoked_at IS NULL DO NOTHING`,
    [label, JSON.stringify([...new Set(sources)]), login, uploadTokenHash(secret)]);
  if (!inserted.changes) throw new Error(`An active upload token already has label: ${label}`);
  console.log(secret);
}
