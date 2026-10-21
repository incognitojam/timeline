/**
 * Facebook Media Extractor
 *
 * Processes pending Facebook attachments from ZIP exports and stores them
 * with content-addressed deduplication.
 */

import { Database } from "bun:sqlite";
import { readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { getDb, initDb, type Attachment } from "../db/schema";
import { markAttachmentFailedById, markAttachmentStored } from "./attachments";
import { imageDimensions } from "./dimensions";
import { storeFile, computeHash, getMimeType } from "./storage";
import { backgroundCommand } from "../lib/background-priority";

interface ExtractStats {
  processed: number;
  stored: number;
  deduplicated: number;
  failed: number;
  skipped: number;
}

/**
 * Recursively find all ZIP files in a directory
 */
async function findAllZips(dir: string): Promise<string[]> {
  const zips: string[] = [];

  async function scan(path: string) {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(path, entry.name);
        if (entry.isDirectory()) {
          await scan(fullPath);
        } else if (entry.name.endsWith(".zip")) {
          zips.push(fullPath);
        }
      }
    } catch {
      // Directory not readable
    }
  }

  // Check if dir itself is a ZIP
  try {
    const s = await stat(dir);
    if (!s.isDirectory() && dir.endsWith(".zip")) {
      return [dir];
    }
  } catch {
    // Not a file
  }

  await scan(dir);
  return zips;
}

/**
 * Try to extract a file from multiple ZIPs until found
 */
async function extractFromZips(
  zipPaths: string[],
  originalUri: string
): Promise<Buffer | null> {
  for (const zipPath of zipPaths) {
    try {
      const proc = Bun.spawn(backgroundCommand(["unzip", "-p", zipPath, originalUri]), {
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(proc.stdout).arrayBuffer();
      const exitCode = await proc.exited;

      if (exitCode === 0 && output.byteLength > 0) {
        return Buffer.from(output);
      }
    } catch {
      // Try next ZIP
    }
  }
  return null;
}

/**
 * Try to fetch a file from a URL (for CDN-hosted attachments)
 */
async function fetchFromUrl(url: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Timeline/1.0)",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) return null;
    return Buffer.from(buffer);
  } catch {
    return null;
  }
}

/**
 * Get the conversation ID from an original URI
 */
function getConversationId(originalUri: string): string {
  const parts = originalUri.split("/");
  const inboxIndex = parts.findIndex((p) =>
    ["inbox", "archived_threads", "filtered_threads", "message_requests", "e2ee_cutover"].includes(p)
  );
  if (inboxIndex >= 0 && parts[inboxIndex + 1]) {
    return parts[inboxIndex + 1];
  }
  const messagesIndex = parts.indexOf("messages");
  if (messagesIndex >= 0 && parts[messagesIndex + 2]) {
    return parts[messagesIndex + 2];
  }
  return "unknown";
}

/**
 * Process pending Facebook attachments from ZIP exports
 */
export async function extractFacebookMedia(
  db: Database,
  exportPath: string,
  options: { limit?: number; dryRun?: boolean; batchSize?: number } = {}
): Promise<ExtractStats> {
  const { limit, dryRun = false, batchSize = 100 } = options;

  const stats: ExtractStats = {
    processed: 0,
    stored: 0,
    deduplicated: 0,
    failed: 0,
    skipped: 0,
  };

  // Find all ZIPs
  console.log(`Scanning for ZIP files in ${exportPath}...`);
  const zipPaths = await findAllZips(exportPath);
  console.log(`Found ${zipPaths.length} ZIP files`);

  if (zipPaths.length === 0) {
    console.log("No ZIP files found!");
    return stats;
  }

  // Get pending attachments
  const query = db.prepare(`
    SELECT id, event_id, source_id, original_uri, status
    FROM attachments
    WHERE source = 'facebook' AND status = 'pending'
    ${limit ? `LIMIT ${limit}` : ""}
  `);

  const pendingAttachments = query.all() as Pick<
    Attachment,
    "id" | "event_id" | "source_id" | "original_uri" | "status"
  >[];

  console.log(`Found ${pendingAttachments.length} pending attachments\n`);

  for (const attachment of pendingAttachments) {
    stats.processed++;

    if (!attachment.original_uri) {
      stats.skipped++;
      continue;
    }

    const conversationId = getConversationId(attachment.original_uri);
    // For URLs, extract filename from path (before query params)
    let filename = attachment.original_uri.split("/").pop() || attachment.original_uri;
    if (filename.includes("?")) {
      filename = filename.split("?")[0];
    }

    if (dryRun) {
      console.log(`Would extract: ${attachment.original_uri}`);
      continue;
    }

    // Try to extract from any ZIP first
    let content = await extractFromZips(zipPaths, attachment.original_uri);

    // If not in ZIPs and looks like a URL, try fetching it
    if (!content && attachment.original_uri.startsWith("http")) {
      content = await fetchFromUrl(attachment.original_uri);
    }

    if (content) {
      try {
        const result = await storeFile({
          source: "facebook",
          relativePath: join(conversationId, filename),
          content,
        });

        // Extract image dimensions (best-effort; columns are nullable)
        const mimeType = getMimeType(filename);
        let dims: { width: number; height: number } | null = null;
        if (mimeType?.startsWith("image/")) {
          try {
            dims = await imageDimensions(content);
          } catch {
            // Unreadable or corrupt image — store without dimensions
          }
        }

        markAttachmentStored(db, attachment.id, result, {
          width: dims?.width ?? null,
          height: dims?.height ?? null,
        });

        if (result.deduplicated) {
          stats.deduplicated++;
        } else {
          stats.stored++;
        }
      } catch (e) {
        console.error(`Failed to store ${filename}:`, e);
        markAttachmentFailedById(db, attachment.id);
        stats.failed++;
      }
    } else {
      markAttachmentFailedById(db, attachment.id);
      stats.failed++;
    }

    // Progress logging
    if (stats.processed % batchSize === 0) {
      const pct = ((stats.processed / pendingAttachments.length) * 100).toFixed(1);
      console.log(
        `[${pct}%] ${stats.processed}/${pendingAttachments.length} - ` +
          `${stats.stored} stored, ${stats.deduplicated} deduped, ${stats.failed} failed`
      );
    }
  }

  return stats;
}

// ============ CLI ============
// Guard so importing this module (e.g. from tests) doesn't run the CLI —
// the block below calls process.exit() and opens the production database.
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Facebook Media Extractor

Usage:
  bun run src/media/facebook-extractor.ts <export-path> [options]

Options:
  --limit <n>     Process only the first n attachments
  --dry-run       Show what would be extracted without doing it
  --batch <n>     Progress update interval (default: 100)
  --help, -h      Show this help message

Examples:
  bun run src/media/facebook-extractor.ts /path/to/facebook-exports/
  bun run src/media/facebook-extractor.ts /path/to/exports --limit 100
  bun run src/media/facebook-extractor.ts /path/to/exports --dry-run
`);
    process.exit(0);
  }

  if (args.length < 1) {
    console.log("Usage: bun run src/media/facebook-extractor.ts <export-path> [--limit n] [--dry-run]");
    process.exit(1);
  }

  const exportPath = args[0];
  const limitIndex = args.indexOf("--limit");
  const limit = limitIndex >= 0 ? parseInt(args[limitIndex + 1], 10) : undefined;
  const batchIndex = args.indexOf("--batch");
  const batchSize = batchIndex >= 0 ? parseInt(args[batchIndex + 1], 10) : 100;
  const dryRun = args.includes("--dry-run");

  console.log(`Facebook Media Extractor`);
  console.log(`Export path: ${exportPath}`);
  if (limit) console.log(`Limit: ${limit}`);
  if (dryRun) console.log(`Dry run: enabled`);
  console.log();

  const db = getDb();
  initDb(db);

  const stats = await extractFacebookMedia(db, exportPath, { limit, dryRun, batchSize });

  console.log(`\n${"=".repeat(50)}`);
  console.log("Extraction complete:");
  console.log(`  Processed: ${stats.processed}`);
  console.log(`  Stored: ${stats.stored}`);
  console.log(`  Deduplicated: ${stats.deduplicated}`);
  console.log(`  Failed: ${stats.failed}`);
  console.log(`  Skipped: ${stats.skipped}`);

  db.close();
}
