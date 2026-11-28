import { createHash } from "node:crypto";
import { z } from "zod";
import { initJellyfinActivityEvidence } from "../../db/schema";
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
  } catch (error) {
    if (error instanceof z.ZodError && error.issues.some((issue) => issue.path.join(".") === "item.Type")) {
      throw new Error("Unsupported Jellyfin item.Type at line " + number);
    }
    throw new Error("Invalid Jellyfin export at line " + number);
  }
}

export function importActivityFile(db: Database, path: string) {
  return processActivityFile(db, path, false);
}

export function previewActivityFile(db: Database, path: string, settingsDb?: Database) {
  return processActivityFile(db, path, true, settingsDb);
}

async function processActivityFile(db: Database, path: string, preview: boolean, settingsDb?: Database) {
  const bytes = await Bun.file(path).arrayBuffer();
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (!text.endsWith("\n") || text.includes("\r")) throw new Error("Expected LF-terminated Jellyfin JSON Lines");
  const lines = text.slice(0, -1).split("\n");
  const manifest = parseLine(header, lines[0], 1);
  const zone = new Intl.DateTimeFormat("en", { timeZone: manifest.timeZone }).resolvedOptions().timeZone;
  const config = getSyncSourceRow("jellyfin", settingsDb);
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
  const metadata = {
    rowsAccepted: end.count,
    createdEstimated: 0,
    createdUnknown: 0,
    updatedEstimated: 0,
    updatedUnknown: 0,
    rowsNew: 0,
    rowsEnriched: 0,
    evidenceOnlyStops: 0,
    supersededRows: 0,
    skippedAlreadyStored: 0,
  };
  const result = { eventsAdded: 0, eventsUpdated: 0, metadata };
  const rollback = Symbol("preview complete");
  try {
    db.transaction(() => {
      if (preview) initJellyfinActivityEvidence(db);
      const seen = new Set<number>();
      const changed = new Set<number>();
      const accounts = new Set<string>();
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
        accounts.add(account);
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
          if (old.item || !row.item) {
            metadata.skippedAlreadyStored++;
            continue;
          }
          // Enrich the first observation without rewriting its original spellings.
          Object.assign(row, { UserId: old.UserId, ItemId: old.ItemId, DateCreated: old.DateCreated });
        }
        if (prior) metadata.rowsEnriched++;
        else metadata.rowsNew++;
        changed.add(row.Id);
        db.run(
          `INSERT INTO jellyfin_activity_evidence(server_id,user_id,log_id,raw_data) VALUES (?,?,?,?)
        ON CONFLICT(server_id,log_id) DO UPDATE SET raw_data=excluded.raw_data`,
          [server, user, row.Id, JSON.stringify(row)],
        );
      }
      for (const account of accounts) {
        const counts = reconcileActivity(db, account, zone, changed);
        result.eventsAdded += counts.eventsAdded;
        result.eventsUpdated += counts.eventsUpdated;
        metadata.updatedEstimated += counts.updatedEstimated;
        metadata.updatedUnknown += counts.updatedUnknown;
        metadata.createdEstimated += counts.createdEstimated;
        metadata.createdUnknown += counts.createdUnknown;
        metadata.evidenceOnlyStops += counts.evidenceOnlyStops;
        metadata.supersededRows += counts.supersededRows;
      }
      if (preview) throw rollback;
    }).immediate();
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return result;
}
