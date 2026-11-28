import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "../../db/sqlite";
import { getSyncSourceRow, parseSyncSourceSettings } from "../../sync/config";
import { activityRow, guid, reconcileActivity, utc, type ActivityRow } from "./activity";
import { compact, ids } from "./ids";

const header = z.strictObject({
  format: z.literal("jellyfin-activity"),
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  serverId: z.string().regex(/^[a-f\d]{32}$/i),
  timeZone: z.string().min(1),
  users: z.array(guid).min(1),
});
const footer = z.strictObject({ count: z.int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
function parseLine<T>(schema: z.ZodType<T>, line: string, number: number): T {
  try {
    return schema.parse(JSON.parse(line));
  } catch {
    throw new Error("Invalid Jellyfin export at line " + number);
  }
}

export async function importActivityFile(db: Database, path: string) {
  const bytes = await Bun.file(path).arrayBuffer();
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!text.endsWith("\n") || text.includes("\r")) throw new Error("Expected LF-terminated Jellyfin JSON Lines");
  const lines = text.slice(0, -1).split("\n");
  const manifest = parseLine(header, lines[0], 1);
  const zone = new Intl.DateTimeFormat("en", { timeZone: manifest.timeZone }).resolvedOptions().timeZone;
  const config = getSyncSourceRow("jellyfin");
  if (!config) throw new Error("Configure Jellyfin user IDs before importing activity");
  const settings = parseSyncSourceSettings(config);
  const allowed = ids(settings.users);
  if (
    typeof settings.timezone === "string" &&
    new Intl.DateTimeFormat("en", { timeZone: settings.timezone }).resolvedOptions().timeZone !== zone
  )
    throw new Error("Jellyfin export and sync time zones differ");
  const users = manifest.users.map(compact);
  if (new Set(users).size !== users.length || users.some((id) => !allowed.includes(id)))
    throw new Error("Jellyfin export contains an unlisted or repeated user");
  const end = parseLine(footer, lines[lines.length - 1], lines.length);
  const digest = createHash("sha256")
    .update(text.slice(0, text.length - lines[lines.length - 1].length - 1))
    .digest("hex");
  if (end.count !== lines.length - 2 || end.sha256 !== digest)
    throw new Error("Incomplete Jellyfin export: count or SHA-256 mismatch");
  return db
    .transaction(() => {
      const seen = new Set<number>();
      const touched = new Set<string>();
      const server = manifest.serverId.toLowerCase();
      const find = db.query<{ raw_data: string; user_id: string }, [string, number]>(
        "SELECT raw_data,user_id FROM jellyfin_activity_evidence WHERE server_id=? AND log_id=?",
      );
      for (let i = 1; i < lines.length - 1; i++) {
        const row = parseLine(activityRow, lines[i], i + 1);
        utc(row);
        const user = compact(row.UserId);
        if (!users.includes(user) || seen.has(row.Id) || (!row.ItemId && row.item))
          throw new Error("Unexpected account, duplicate ID or invalid item at line " + (i + 1));
        seen.add(row.Id);
        const account = server + "/" + user;
        const prior = find.get(server, row.Id);
        if (prior) {
          const old: ActivityRow = JSON.parse(prior.raw_data);
          if (
            prior.user_id !== user ||
            old.Type !== row.Type ||
            old.Name !== row.Name ||
            utc(old).iso !== utc(row).iso ||
            compact(old.ItemId ?? "") !== compact(row.ItemId ?? "")
          )
            throw new Error("Conflicting activity row at line " + (i + 1));
          if (old.item || !row.item) continue;
          // Enrich the first observation without rewriting its original spellings.
          Object.assign(row, { UserId: old.UserId, ItemId: old.ItemId, DateCreated: old.DateCreated });
        }
        db.run(
          `INSERT INTO jellyfin_activity_evidence(server_id,user_id,log_id,raw_data) VALUES (?,?,?,?)
        ON CONFLICT(server_id,log_id) DO UPDATE SET raw_data=excluded.raw_data`,
          [server, user, row.Id, JSON.stringify(row)],
        );
        touched.add(account);
      }
      let eventsAdded = 0,
        eventsUpdated = 0;
      for (const account of touched) {
        const counts = reconcileActivity(db, account, zone);
        eventsAdded += counts.eventsAdded;
        eventsUpdated += counts.eventsUpdated;
      }
      return { eventsAdded, eventsUpdated };
    })
    .immediate();
}
