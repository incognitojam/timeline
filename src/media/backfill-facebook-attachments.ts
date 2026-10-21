/**
 * Backfill Facebook Attachments
 *
 * Extracts attachment metadata from existing Facebook message events
 * and populates the attachments table.
 */

import { Database } from "bun:sqlite";
import { getDb, initDb, type TimelineEvent } from "../db/schema";
import { insertPendingAttachment } from "./attachments";

function getMimeType(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop();
  const mimeTypes: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    aac: "audio/aac",
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    zip: "application/zip",
    txt: "text/plain",
  };
  return mimeTypes[ext || ""] ?? null;
}

async function backfillAttachments(db: Database, options: { dryRun?: boolean; limit?: number } = {}) {
  const { dryRun = false, limit } = options;

  // Get Facebook message events with potential attachments
  const query = `
    SELECT id, type, raw_data
    FROM events
    WHERE source = 'facebook'
      AND (type IN ('message:photo', 'message:video', 'message:gif', 'message:audio', 'message:sticker')
           OR (type = 'message' AND raw_data LIKE '%"files":%'))
    ${limit ? `LIMIT ${limit}` : ""}
  `;

  const events = db.prepare(query).all() as Pick<TimelineEvent, "id" | "type" | "raw_data">[];

  console.log(`Found ${events.length} Facebook media messages to process`);

  let totalAttachments = 0;
  let processedEvents = 0;

  for (const event of events) {
    processedEvents++;
    try {
      const raw = JSON.parse(event.raw_data);

      // Collect attachments based on message type
      const attachments: { uri: string }[] = [];

      if (raw.photos) {
        for (const photo of raw.photos) {
          if (photo.uri) attachments.push({ uri: photo.uri });
        }
      }
      if (raw.videos) {
        for (const video of raw.videos) {
          if (video.uri) attachments.push({ uri: video.uri });
        }
      }
      if (raw.gifs) {
        for (const gif of raw.gifs) {
          if (gif.uri) attachments.push({ uri: gif.uri });
        }
      }
      if (raw.audio_files) {
        for (const audio of raw.audio_files) {
          if (audio.uri) attachments.push({ uri: audio.uri });
        }
      }
      if (raw.sticker?.uri) {
        attachments.push({ uri: raw.sticker.uri });
      }
      if (raw.files) {
        for (const file of raw.files) {
          if (file.uri) attachments.push({ uri: file.uri });
        }
      }

      for (const attachment of attachments) {
        const filename = attachment.uri.split("/").pop() || attachment.uri;
        const mimeType = getMimeType(filename);

        if (dryRun) {
          console.log(`Would insert: event ${event.id} -> ${filename}`);
        } else {
          try {
            insertPendingAttachment(db, {
              eventId: event.id,
              source: "facebook",
              sourceId: filename,
              filename,
              mimeType,
              originalUri: attachment.uri,
            });
            totalAttachments++;
          } catch {
            // Duplicate, skip
          }
        }
      }
    } catch (e) {
      console.error(`Error processing event ${event.id}:`, e);
    }

    if (processedEvents % 10000 === 0) {
      console.log(`Progress: ${processedEvents}/${events.length} events, ${totalAttachments} attachments`);
    }
  }

  return { processedEvents, totalAttachments };
}

// CLI
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitIndex = args.indexOf("--limit");
const limit = limitIndex >= 0 ? parseInt(args[limitIndex + 1], 10) : undefined;

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Backfill Facebook Attachments

Usage:
  bun run src/media/backfill-facebook-attachments.ts [options]

Options:
  --dry-run      Show what would be inserted without doing it
  --limit <n>    Process only the first n events
  --help, -h     Show this help message
`);
  process.exit(0);
}

console.log("Backfill Facebook Attachments");
if (dryRun) console.log("Dry run mode");
if (limit) console.log(`Limit: ${limit}`);
console.log();

const db = getDb();
initDb(db);

const stats = await backfillAttachments(db, { dryRun, limit });

console.log(`\n${"=".repeat(50)}`);
console.log("Backfill complete:");
console.log(`  Events processed: ${stats.processedEvents}`);
console.log(`  Attachments created: ${stats.totalAttachments}`);

db.close();
