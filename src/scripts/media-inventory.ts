/**
 * Dry-run media inventory: classifies stored media by local- and R2-presence.
 * Read-only — writes and deletes nothing.
 *
 *   bun run src/scripts/media-inventory.ts
 */

import { openReadonlyDbAtPath } from "../db/readonly";
import { loadConfig } from "../config";
import { LocalMediaStore } from "../media/storage";
import { createR2BlobStore } from "../media/r2";
import { inventoryMedia } from "../media/inventory";
import { formatBinaryBytes } from "../lib/format";

async function main(): Promise<void> {
  const config = await loadConfig();
  const local = new LocalMediaStore(config.media.path);
  const remote = config.media.r2?.enabled ? createR2BlobStore(config.media.r2) : null;

  const db = openReadonlyDbAtPath(config.database.path);
  let inv: Awaited<ReturnType<typeof inventoryMedia>>;
  try {
    inv = await inventoryMedia(db, local, remote);
  } finally {
    db.close();
  }

  console.log("Media inventory (dry run) — no files written or deleted");
  console.log(`Tables: ${inv.tables.join(", ")}`);
  console.log(`Unique stored blobs (by content_hash): ${inv.uniqueBlobs}`);
  console.log("");
  if (inv.r2Checked) {
    console.log(`  durable in R2:          ${inv.durableInR2.blobs} blobs, ${formatBinaryBytes(inv.durableInR2.bytes)}`);
    console.log(`  local only (to upload): ${inv.localOnly.blobs} blobs, ${formatBinaryBytes(inv.localOnly.bytes)}`);
    console.log(`  missing (to recover):   ${inv.missing.blobs} blobs, ${formatBinaryBytes(inv.missing.bytes)}`);
  } else {
    console.log("  R2 not configured — local presence only:");
    console.log(`  local present:          ${inv.localOnly.blobs} blobs, ${formatBinaryBytes(inv.localOnly.bytes)}`);
    console.log(`  local missing:          ${inv.missing.blobs} blobs, ${formatBinaryBytes(inv.missing.bytes)}`);
  }
  console.log(`  failed rows:            ${inv.failedRows}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
