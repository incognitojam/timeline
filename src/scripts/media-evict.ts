/**
 * Local media-cache eviction.
 *
 *   bun run media-evict              # DRY RUN — reports the plan, deletes nothing
 *   bun run media-evict --execute    # evict oldest R2-durable blobs to the bound
 *
 * Drops the oldest (by cache mtime) blobs that are confirmed in R2 to keep local
 * usage under [media].cache_limit_gib. Read-through restores any evicted blob on
 * demand. Reads the timeline DB read-only; the only writes are local file
 * deletions. Idempotent/resumable.
 */

import { openReadonlyDbAtPath } from "../db/readonly";
import { loadConfig } from "../config";
import { LocalMediaStore } from "../media/storage";
import { createR2BlobStore } from "../media/r2";
import { cacheLimitBytes, evictMedia } from "../media/eviction";
import { formatBinaryBytes } from "../lib/format";

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const config = await loadConfig();
  const local = new LocalMediaStore(config.media.path);
  const remote = config.media.r2?.enabled ? createR2BlobStore(config.media.r2) : null;

  const limitBytes = cacheLimitBytes(config.media);

  const db = openReadonlyDbAtPath(config.database.path);
  let result: Awaited<ReturnType<typeof evictMedia>>;
  try {
    result = await evictMedia(db, local, remote, limitBytes, { dryRun: !execute });
  } finally {
    db.close();
  }

  console.log(execute ? "Media cache eviction" : "Media cache eviction plan (dry run) — deletes nothing");
  console.log(`  local cache:   ${result.localBlobs} blobs, ${formatBinaryBytes(result.localBytes)}`);
  const evictableLabel =
    result.durabilityCheck === "full-list"
      ? "evictable (durable in R2)"
      : "confirmed evictable";
  console.log(`  ${evictableLabel}: ${result.evictableBlobs} blobs, ${formatBinaryBytes(result.evictableBytes)}`);
  console.log(`  durability check: ${result.durabilityCheck} (${result.durabilityCheckedBlobs} blobs checked)`);
  if (!remote) {
    console.log("  (R2 not configured — nothing is evictable; durability can't be confirmed)");
  }
  if (result.limitBytes === null) {
    console.log("  bound:         not set ([media].cache_limit_gib) — report-only");
    return;
  }
  console.log(`  bound:         ${formatBinaryBytes(result.limitBytes)}`);
  if (result.localBytes <= result.limitBytes) {
    console.log("  under bound — nothing to evict");
  } else {
    console.log(
      `  ${execute ? "evicting" : "would evict"}: ${result.toEvictBlobs} blobs, ${formatBinaryBytes(result.toEvictBytes)} (oldest first) → resulting ${formatBinaryBytes(result.resultingBytes)}`,
    );
    if (result.shortfallBytes > 0) {
      console.log(`  WARNING: ${formatBinaryBytes(result.shortfallBytes)} still over the bound after evicting all evictable blobs`);
    }
  }

  if (execute) {
    console.log(`  evicted:       ${result.evicted} blobs, ${formatBinaryBytes(result.reclaimedBytes)} reclaimed`);
    console.log(`  failed:        ${result.failed}`);
    if (result.failed > 0) {
      console.error(`${result.failed} eviction(s) failed; re-run to retry.`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
