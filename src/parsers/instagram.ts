import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getDb, initDb } from "../db/schema";
import { extractConversationId } from "../db/conversation-id";
import {
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";

// Instagram uses the same text encoding as Facebook - latin1 bytes labeled as UTF-8
function decodeInstagramText(text: string | undefined): string | null {
  if (!text) return null;
  try {
    const bytes = new Uint8Array(text.split("").map((c) => c.charCodeAt(0)));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return text;
  }
}

interface Stats {
  messages: number;
  photos: number;
  videos: number;
  shares: number;
  reels: number;
  audio: number;
  stickers: number;
  other: number;
  skipped: number;
  conversations: number;
  identities: number;
}

/**
 * Import Instagram messages from an extracted export folder
 * @param db - Database instance
 * @param importPath - Path to the messages folder (containing inbox/)
 * @param sourceAccount - Account name for source_account field
 * @returns Number of events added
 */
export async function importInstagramData(
  db: Database,
  importPath: string,
  sourceAccount: string
): Promise<number> {
  const importBatch = `instagram-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      duration_ms, title, content, people, tags, raw_data, import_batch,
      conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stats: Stats = {
    messages: 0,
    photos: 0,
    videos: 0,
    shares: 0,
    reels: 0,
    audio: 0,
    stickers: 0,
    other: 0,
    skipped: 0,
    conversations: 0,
    identities: 0,
  };

  // Collect all identities for batch upsert
  const allIdentities: UpsertIdentityOptions[] = [];

  // Instagram message folders to check
  const categories = ["inbox", "message_requests"];

  for (const category of categories) {
    const categoryPath = join(importPath, category);
    let conversations: string[];
    try {
      conversations = await readdir(categoryPath);
    } catch {
      console.log(`  Skipping ${category} (not found)`);
      continue;
    }

    console.log(`Processing ${category}...`);

    for (const convDir of conversations) {
      const convPath = join(categoryPath, convDir);
      let files: string[];
      try {
        files = (await readdir(convPath)).filter(
          (f) => f.startsWith("message_") && f.endsWith(".json")
        );
      } catch {
        continue;
      }

      if (files.length === 0) continue;
      stats.conversations++;

      let conversationTitle: string | null = null;
      let participants: string[] = [];
      let participantIdentifiers: string[] = [];
      let threadPath: string | null = null;

      for (const file of files) {
        const filePath = join(convPath, file);
        let data: any;
        try {
          data = await Bun.file(filePath).json();
        } catch (e) {
          console.log(`  Error reading ${filePath}: ${e}`);
          continue;
        }

        if (!conversationTitle) {
          conversationTitle = decodeInstagramText(data.title) || convDir;
          participants = (data.participants || []).map(
            (p: any) => decodeInstagramText(p.name) || p.name
          );
          // The export's thread_path is "<category>/<folder>"; synthesize the
          // same shape from the folder if an export ever omits it, so every
          // message row carries a stable conversation_id.
          threadPath =
            typeof data.thread_path === "string" && data.thread_path !== ""
              ? data.thread_path
              : `${category}/${convDir}`;

          // Collect participant identities using name: prefix (Instagram doesn't expose IDs)
          for (const name of participants) {
            if (name) {
              const identifier = formatIdentifier("instagram", `name:${name}`);
              participantIdentifiers.push(identifier);
              allIdentities.push({
                platform: "instagram",
                platformId: `name:${name}`,
                displayName: name,
              });
            }
          }
        }

        // Determine if this is a group chat based on participant count
        const isGroup = participants.length > 2;
        const baseType = isGroup ? "message:group" : "message:dm";

        for (const msg of data.messages || []) {
          const senderName =
            decodeInstagramText(msg.sender_name) || msg.sender_name;
          const timestamp = new Date(msg.timestamp_ms).toISOString();
          const messageId = `msg:${convDir}:${msg.timestamp_ms}:${senderName}`;

          let eventType = baseType;
          let title: string | null = conversationTitle;
          let content: string | null = null;

          // Determine message type and content
          if (msg.photos?.length > 0) {
            eventType = `${baseType}:attachment`;
            content = decodeInstagramText(msg.content) || "[photo]";
            stats.photos++;
          } else if (msg.videos?.length > 0) {
            eventType = `${baseType}:attachment`;
            content = decodeInstagramText(msg.content) || "[video]";
            stats.videos++;
          } else if (msg.share) {
            eventType = `${baseType}:share`;
            const shareLink = msg.share.link || "";
            const shareText =
              decodeInstagramText(msg.share.share_text) ||
              decodeInstagramText(msg.content);

            if (shareLink.includes("/reel/") || shareLink.includes("/reels/")) {
              eventType = `${baseType}:share:reel`;
              stats.reels++;
            } else {
              stats.shares++;
            }

            content = shareText || shareLink || "[shared content]";
          } else if (msg.sticker) {
            eventType = `${baseType}:sticker`;
            content = "[sticker]";
            stats.stickers++;
          } else if (msg.audio_files?.length > 0) {
            eventType = `${baseType}:audio`;
            content = "[voice message]";
            stats.audio++;
          } else if (msg.is_unsent) {
            eventType = `${baseType}:unsent`;
            content = "[unsent message]";
            stats.other++;
          } else if (msg.content) {
            content = decodeInstagramText(msg.content);
            stats.messages++;
          } else {
            content = null;
            stats.other++;
          }

          const rawData = {
            ...msg,
            sender_name: senderName,
            content: decodeInstagramText(msg.content),
            conversation: {
              title: conversationTitle,
              participants,
              thread_path: threadPath,
              category,
            },
          };

          if (msg.reactions) {
            rawData.reactions = msg.reactions.map((r: any) => ({
              reaction: decodeInstagramText(r.reaction),
              actor: decodeInstagramText(r.actor),
            }));
          }

          // Build people array with sender first using platform identifiers
          const senderIdentifier = formatIdentifier("instagram", `name:${senderName}`);
          const people = [senderIdentifier, ...participantIdentifiers.filter(p => p !== senderIdentifier)];

          // Collect sender identity if not already in participants
          if (!participantIdentifiers.includes(senderIdentifier)) {
            allIdentities.push({
              platform: "instagram",
              platformId: `name:${senderName}`,
              displayName: senderName,
            });
          }

          try {
            insert.run(
              "instagram",
              messageId,
              sourceAccount,
              eventType,
              timestamp,
              null,
              title,
              content,
              JSON.stringify(people),
              JSON.stringify([conversationTitle]),
              JSON.stringify(rawData),
              importBatch,
              // Derived from the same object persisted to raw_data, so this
              // matches what extractConversationId reads back off the row.
              extractConversationId("instagram", rawData)
            );
          } catch {
            stats.skipped++;
          }
        }
      }
    }
  }

  // Batch upsert all collected identities
  if (allIdentities.length > 0) {
    // Deduplicate by platform:platformId
    const uniqueIdentities = new Map<string, UpsertIdentityOptions>();
    for (const id of allIdentities) {
      const key = `${id.platform}:${id.platformId}`;
      // Prefer entries with display name
      if (!uniqueIdentities.has(key) || (id.displayName && !uniqueIdentities.get(key)?.displayName)) {
        uniqueIdentities.set(key, id);
      }
    }
    upsertIdentities(db, [...uniqueIdentities.values()]);
    stats.identities = uniqueIdentities.size;
  }

  const totalMessages =
    stats.messages +
    stats.photos +
    stats.videos +
    stats.shares +
    stats.reels +
    stats.audio +
    stats.stickers +
    stats.other;

  console.log(`\n${"=".repeat(50)}`);
  console.log("Import complete:");
  console.log(`  Conversations: ${stats.conversations}`);
  console.log(`  Text messages: ${stats.messages.toLocaleString()}`);
  console.log(`  Photos: ${stats.photos}`);
  console.log(`  Videos: ${stats.videos}`);
  console.log(`  Shares: ${stats.shares}`);
  console.log(`  Reels: ${stats.reels}`);
  console.log(`  Audio: ${stats.audio}`);
  console.log(`  Stickers: ${stats.stickers}`);
  console.log(`  Identities: ${stats.identities}`);
  console.log(`  Other: ${stats.other}`);
  console.log(`  Skipped (duplicates): ${stats.skipped}`);
  console.log(`  Batch ID: ${importBatch}`);
  console.log(`  Total messages: ${totalMessages.toLocaleString()}`);

  return totalMessages;
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log(
      "Usage: bun run src/parsers/instagram.ts <messages-path> [account-name]"
    );
    console.log("");
    console.log("Imports Instagram DMs from the messages folder of an export.");
    console.log("The path should point to the messages folder containing inbox/");
    console.log("");
    console.log(
      "Example: bun run src/parsers/instagram.ts /tmp/instagram/your_instagram_activity/messages my-account"
    );
    process.exit(1);
  }

  const importPath = args[0];
  const accountName = args[1] || "default";

  console.log(`Importing Instagram messages from ${importPath}`);
  console.log(`Account: ${accountName}\n`);

  const db = getDb();
  initDb(db);

  await importInstagramData(db, importPath, accountName);

  db.close();
}
