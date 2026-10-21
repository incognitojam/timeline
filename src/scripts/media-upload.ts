/**
 * Upload local-only media to R2 (the existing-cache upload rung).
 *
 *   bun run media-upload                 # DRY RUN — reports what would upload
 *   bun run media-upload --execute       # actually upload
 *   bun run media-upload --execute --limit=100 --concurrency=8
 *
 * Reads the timeline DB read-only and the local media cache; the only writes are
 * to R2. Idempotent/resumable — re-running uploads only what's still missing.
 */

import { openReadonlyDbAtPath } from "../db/readonly";
import { loadConfig } from "../config";
import { LocalMediaStore } from "../media/storage";
import { createR2BlobStore } from "../media/r2";
import { uploadLocalMedia } from "../media/upload";
import { formatBinaryBytes } from "../lib/format";

function numFlag(name: string): number | undefined {
  const arg = process.argv.find((a) => a.startsWith(`${name}=`));
  return arg ? Number(arg.split("=")[1]) : undefined;
}

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const limit = numFlag("--limit");
  const concurrency = numFlag("--concurrency");

  const config = await loadConfig();
  if (!config.media.r2?.enabled) {
    throw new Error("R2 is not enabled ([media.r2].enabled = false); nothing to upload to.");
  }
  const local = new LocalMediaStore(config.media.path);
  const remote = createR2BlobStore(config.media.r2);
  const db = openReadonlyDbAtPath(config.database.path);

  console.log(
    execute
      ? "Uploading local-only media to R2…"
      : "DRY RUN — no uploads (pass --execute to upload)",
  );

  let lastPct = -1;
  try {
    const result = await uploadLocalMedia(db, local, remote, {
      dryRun: !execute,
      limit,
      concurrency,
      onProgress: (uploadDone, total) => {
        const pct = total === 0 ? 100 : Math.floor((uploadDone / total) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          process.stderr.write(`\r  ${uploadDone}/${total} (${pct}%)`);
        }
      },
    });
    if (execute) process.stderr.write("\n");

    console.log(`  already in R2: ${result.alreadyInR2} blobs`);
    console.log(`  to upload:     ${result.toUpload} blobs, ${formatBinaryBytes(result.toUploadBytes)}`);
    if (execute) {
      console.log(`  uploaded:      ${result.uploaded} blobs, ${formatBinaryBytes(result.uploadedBytes)}`);
      console.log(`  failed:        ${result.failed}`);
      // Non-zero exit on partial failure so automation doesn't treat it as success.
      if (result.failed > 0) {
        console.error(`${result.failed} upload(s) failed; re-run to retry the rest.`);
        process.exitCode = 1;
      }
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
