/**
 * Cleanup Misattached Facebook Attachments
 *
 * Re-links attachment rows whose linked event does not actually reference
 * the attachment's original_uri in raw_data. These are leftovers from the
 * pre-fix parser, which used result.lastInsertRowid after ON CONFLICT DO
 * UPDATE and could associate attachments with whichever row happened to be
 * the most recent real INSERT on the connection.
 *
 * Strategy:
 *   1. Build a uri → eventIds map by scanning every Facebook event's raw_data.
 *   2. For each misattached attachment:
 *      - if the uri maps to one or more events: UPDATE event_id to one of
 *        them (so status/content_hash/storage_path survive). Backfill will
 *        later fill in the other events sharing the uri.
 *      - if the uri maps to no event (raw_data was overwritten by a newer
 *        export that dropped the field): DELETE — there's no event to point
 *        at, and backfill can't recover the link either.
 *
 * After cleanup, run backfill-facebook-attachments.ts to insert rows for any
 * remaining (event_id, source_id) pairs that share a uri, then
 * facebook-extractor.ts to extract files for any new pending rows.
 */
import type { Database } from "bun:sqlite";
import { openReadonlyTimelineDb } from "../db/readonly";
import { getDb, initDb, type TimelineEvent } from "../db/schema";

interface BadRow {
  id: number;
  event_id: number;
  original_uri: string;
  status: string;
  content_hash: string | null;
}

// Per-source_account map of URI → event_ids. Facebook events are scoped by
// source_account, so two different account exports could share a relative
// media URI; we must not relink across that boundary.
type UriIndex = Map<string, Map<string, number[]>>;

const URI_FIELDS = ["photos", "videos", "gifs", "audio_files", "files"] as const;

function extractUris(rawData: string): string[] {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawData) as Record<string, unknown>;
  } catch {
    return [];
  }
  const uris: string[] = [];
  for (const field of URI_FIELDS) {
    const arr = raw[field];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (item && typeof item === "object" && "uri" in item) {
        const uri = (item as { uri: unknown }).uri;
        if (typeof uri === "string") uris.push(uri);
      }
    }
  }
  const sticker = raw.sticker;
  if (sticker && typeof sticker === "object" && "uri" in sticker) {
    const uri = (sticker as { uri: unknown }).uri;
    if (typeof uri === "string") uris.push(uri);
  }
  return uris;
}

function buildUriIndex(db: Database): UriIndex {
  const index: UriIndex = new Map();
  const rows = db
    .prepare(
      "SELECT id, source_account, raw_data FROM events WHERE source = 'facebook' AND (raw_data LIKE '%\"uri\":%' OR raw_data LIKE '%\"sticker\":%')"
    )
    .iterate() as IterableIterator<
      Pick<TimelineEvent, "id" | "source_account" | "raw_data">
    >;

  let scanned = 0;
  let totalUris = 0;
  for (const row of rows) {
    scanned++;
    const account = row.source_account ?? "";
    let perAccount = index.get(account);
    if (!perAccount) {
      perAccount = new Map<string, number[]>();
      index.set(account, perAccount);
    }
    for (const uri of extractUris(row.raw_data)) {
      let arr = perAccount.get(uri);
      if (!arr) {
        arr = [];
        perAccount.set(uri, arr);
        totalUris++;
      }
      arr.push(row.id);
    }
    if (scanned % 50000 === 0) {
      console.log(`  scanned ${scanned.toLocaleString()} events...`);
    }
  }
  const accounts = [...index.keys()].map((a) => a || "(empty)").join(", ");
  console.log(
    `  scanned ${scanned.toLocaleString()} events, ${totalUris.toLocaleString()} distinct (account, URI) pairs indexed across accounts: ${accounts}`
  );
  return index;
}

function findBadRows(db: Database): BadRow[] {
  // INSTR (not LIKE) avoids treating '_' and '%' in URIs as wildcards.
  return db
    .prepare(
      `SELECT a.id, a.event_id, a.original_uri, a.status, a.content_hash
       FROM attachments a
       JOIN events e ON e.id = a.event_id
       WHERE a.source = 'facebook'
         AND a.original_uri IS NOT NULL
         AND INSTR(e.raw_data, a.original_uri) = 0`
    )
    .all() as BadRow[];
}

function cleanup(options: { dryRun: boolean }) {
  // initDb() writes migrations, so open read-only in dry-run mode to allow
  // inspecting prod DBs without needing write access.
  const db = options.dryRun
    ? openReadonlyTimelineDb()
    : getDb();
  if (!options.dryRun) initDb(db);

  console.log("Building uri → event_id index from Facebook raw_data...");
  const index = buildUriIndex(db);

  console.log("\nFinding misattached attachments...");
  const bad = findBadRows(db);
  console.log(`Found ${bad.length.toLocaleString()} misattached rows`);

  if (bad.length === 0) {
    db.close();
    return;
  }

  // Categorize each bad row using the (source_account, uri) index:
  //   - exactly one source_account claims the uri → relink to its first event
  //     (storage_path survives; backfill fills the other events in that
  //     account that share the uri).
  //   - multiple source_accounts claim it → we can't tell which import the
  //     attachment originally belonged to, so DELETE rather than guess.
  //   - no source_account claims it → DELETE; the uri lives in no current
  //     raw_data and there's nothing to anchor to.
  const toRelink: { id: number; newEventId: number }[] = [];
  const toDelete: number[] = [];
  let multiMatchSingleAccount = 0;
  let crossAccountAmbiguous = 0;

  for (const row of bad) {
    const accountsWithUri: { account: string; eventIds: number[] }[] = [];
    for (const [account, perAccount] of index) {
      const eventIds = perAccount.get(row.original_uri);
      if (eventIds && eventIds.length > 0) {
        accountsWithUri.push({ account, eventIds });
      }
    }
    if (accountsWithUri.length === 0) {
      toDelete.push(row.id);
      continue;
    }
    if (accountsWithUri.length > 1) {
      crossAccountAmbiguous++;
      toDelete.push(row.id);
      continue;
    }
    const { eventIds } = accountsWithUri[0];
    if (eventIds.length > 1) multiMatchSingleAccount++;
    toRelink.push({ id: row.id, newEventId: eventIds[0] });
  }

  console.log(`\nPlanned actions:`);
  console.log(
    `  relink: ${toRelink.length.toLocaleString()} (of which ${multiMatchSingleAccount.toLocaleString()} have multiple matching events in the same account — backfill will fill the rest)`
  );
  console.log(
    `  delete: ${toDelete.length.toLocaleString()} (${crossAccountAmbiguous.toLocaleString()} ambiguous across accounts, ${(toDelete.length - crossAccountAmbiguous).toLocaleString()} no matching event)`
  );

  if (options.dryRun) {
    console.log("\nSample relinks (first 5):");
    for (const r of toRelink.slice(0, 5)) console.log(`  attachment ${r.id} → event ${r.newEventId}`);
    console.log("\nSample deletes (first 5):");
    const idMap = new Map(bad.map((b) => [b.id, b]));
    for (const id of toDelete.slice(0, 5)) {
      const row = idMap.get(id);
      console.log(`  attachment ${id} status=${row?.status} uri=${row?.original_uri}`);
    }
    console.log("\nDry run — no changes written.");
    db.close();
    return;
  }

  const update = db.prepare("UPDATE attachments SET event_id = ? WHERE id = ?");
  const del = db.prepare("DELETE FROM attachments WHERE id = ?");
  // Relinking can collide with existing (event_id, source_id) — when the
  // bad row's source_id is identical to another row already attached to the
  // target event (e.g. the backfill already created the correct row). In
  // that case the UPDATE raises a UNIQUE violation; fall back to delete.
  let relinked = 0;
  let deletedAfterCollision = 0;
  let deleted = 0;

  db.exec("BEGIN");
  try {
    for (const r of toRelink) {
      try {
        update.run(r.newEventId, r.id);
        relinked++;
      } catch (e) {
        if (e instanceof Error && /UNIQUE/i.test(e.message)) {
          del.run(r.id);
          deletedAfterCollision++;
        } else {
          throw e;
        }
      }
    }
    for (const id of toDelete) {
      del.run(id);
      deleted++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  console.log(`\nDone:`);
  console.log(`  relinked: ${relinked.toLocaleString()}`);
  console.log(`  deleted (UNIQUE collision with already-correct row): ${deletedAfterCollision.toLocaleString()}`);
  console.log(`  deleted (no matching event): ${deleted.toLocaleString()}`);
  console.log(`\nNext:`);
  console.log(`  1. bun run src/media/backfill-facebook-attachments.ts`);
  console.log(`  2. bun run src/media/facebook-extractor.ts <export-path>   # only if step 1 added pending rows`);

  db.close();
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Cleanup Misattached Facebook Attachments

Usage:
  bun run src/media/cleanup-misattached-facebook-attachments.ts [options]

Options:
  --dry-run      Show what would change without writing
  --help, -h     Show this help message
`);
  process.exit(0);
}

const dryRun = args.includes("--dry-run");
if (dryRun) console.log("Dry run mode\n");
cleanup({ dryRun });
