import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import { parseSkypeUserId } from "../lib/skype";
import {
  onImportComplete,
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";

// Skype export structure
interface SkypeExport {
  userId: string;
  exportDate: string;
  conversations: SkypeConversation[];
}

interface SkypeConversation {
  id: string;
  displayName: string | null;
  version: number;
  properties: any;
  threadProperties: any;
  MessageList: SkypeMessage[];
}

interface SkypeMessage {
  id: string;
  displayName: string | null;
  originalarrivaltime: string;
  messagetype: string;
  version: number;
  content: string;
  conversationid: string;
  from: string;
  properties: any;
  amsreferences: string[] | null;
}

interface Stats {
  messages: number;
  calls: number;
  attachments: number;
  activities: number;
  skipped: number;
  conversations: number;
  spamSkipped: number;
  identitiesUpserted: number;
}

// Maximum member count for a group to be imported (spam groups have 400-600 members)
const MAX_GROUP_MEMBERS = 200;

// Decode HTML entities that Skype uses in message content
function decodeHtmlEntities(text: string | null | undefined): string | null {
  if (!text) return null;
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Parse call duration from XML content like <partlist><part><duration>123.456</duration></part></partlist>
function parseCallDuration(content: string): number | null {
  const match = content.match(/<duration>(\d+(?:\.\d+)?)<\/duration>/);
  if (match) {
    return Math.round(parseFloat(match[1]) * 1000); // Convert seconds to ms
  }
  return null;
}

// Extract call type from XML content (started, ended, missed)
function parseCallType(content: string): "started" | "ended" | "missed" | "call" {
  const typeMatch = content.match(/<partlist\s+type="(\w+)"/);
  const type = typeMatch ? typeMatch[1] : "call";
  if (type === "started" || type === "ended" || type === "missed") {
    return type;
  }
  return "call";
}

// Extract readable text from message content, stripping XML/HTML
function extractTextContent(content: string, messagetype: string): string | null {
  if (!content) return null;

  // For call events, create a readable summary
  if (messagetype === "Event/Call") {
    const callType = parseCallType(content);
    const duration = parseCallDuration(content);
    if (duration) {
      const mins = Math.floor(duration / 60000);
      const secs = Math.floor((duration % 60000) / 1000);
      return `Call ${callType} (${mins}m ${secs}s)`;
    }
    return `Call ${callType}`;
  }

  // For URI objects (attachments), extract filename if present
  if (messagetype.includes("UriObject") || messagetype.includes("Media_")) {
    const nameMatch = content.match(/<OriginalName\s+v="([^"]+)"/);
    if (nameMatch) {
      return `[${nameMatch[1]}]`;
    }
    return "[attachment]";
  }

  // For regular messages, decode HTML entities and strip any remaining tags
  let text = decodeHtmlEntities(content);
  if (text) {
    // Remove <ss> emoji tags but keep the content
    text = text.replace(/<ss[^>]*>([^<]*)<\/ss>/g, "$1");
    // Remove <a> tags but keep the href or content
    text = text.replace(/<a\s+href="([^"]+)"[^>]*>[^<]*<\/a>/g, "$1");
    // Remove any other HTML tags
    text = text.replace(/<[^>]+>/g, "");
  }
  return text;
}

// Determine if conversation is a group chat
function isGroupChat(conversationId: string): boolean {
  return conversationId.startsWith("19:") && conversationId.includes("@thread");
}

// Check if conversation should be skipped (system/junk/duplicates)
function shouldSkipConversation(conversationId: string): boolean {
  return (
    conversationId === "48:calllogs" || // Call logs (redundant with Event/Call)
    conversationId.startsWith("28:") || // Skype system/concierge
    conversationId.startsWith("19:uni01_") // Unified threads (duplicates of DMs)
  );
}

// Check if a group conversation is likely spam based on member count
function isSpamGroup(conv: SkypeConversation): boolean {
  if (!conv.threadProperties) return false;

  const memberCount = conv.threadProperties.membercount;
  if (memberCount && parseInt(memberCount) > MAX_GROUP_MEMBERS) {
    return true;
  }

  return false;
}

// Determine event type from message
function getEventType(msg: SkypeMessage, isGroup: boolean): string | null {
  const baseType = isGroup ? "message:group" : "message:dm";

  switch (msg.messagetype) {
    case "RichText":
    case "Text":
      // Check if it's a call log entry
      if (msg.properties?.callLog) {
        return "call:log";
      }
      return baseType;

    case "Event/Call":
      // Skip "started" events - we only want "ended" or "missed"
      const callType = parseCallType(msg.content);
      if (callType === "started") {
        return null;
      }
      return "message:call";

    case "RichText/UriObject":
    case "RichText/Media_Album":
    case "RichText/Media_Video":
    case "RichText/Media_AudioMsg":
    case "RichText/Media_GenericFile":
      return `${baseType}:attachment`;

    case "ThreadActivity/AddMember":
    case "ThreadActivity/DeleteMember":
    case "ThreadActivity/TopicUpdate":
    case "ThreadActivity/PictureUpdate":
      return null; // Skip activity messages

    case "Notice":
      return null; // Skip system notices

    default:
      // Handle other RichText variants
      if (msg.messagetype.startsWith("RichText")) {
        return baseType;
      }
      return null;
  }
}

// Extract display name from Skype user ID
function extractUsername(skypeId: string): string {
  // Remove prefixes like "8:", "8:live:", etc.
  return skypeId.replace(/^8:(live:)?/, "");
}

async function importSkypeData(
  db: Database,
  importPath: string,
  sourceAccount: string
) {
  const importBatch = `skype-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp,
      duration_ms, title, content, people, tags, raw_data, import_batch, conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stats: Stats = {
    messages: 0,
    calls: 0,
    attachments: 0,
    activities: 0,
    skipped: 0,
    conversations: 0,
    spamSkipped: 0,
    identitiesUpserted: 0,
  };

  // Collect all identities for batch upsert
  const allIdentities: UpsertIdentityOptions[] = [];

  // Load messages.json
  const messagesPath = `${importPath}/messages.json`;
  let data: SkypeExport;
  try {
    data = await Bun.file(messagesPath).json();
  } catch (e) {
    console.error(`Failed to load ${messagesPath}:`, e);
    process.exit(1);
  }

  console.log(`User ID: ${data.userId}`);
  console.log(`Export Date: ${data.exportDate}`);
  console.log(`Conversations: ${data.conversations.length}`);

  for (const conv of data.conversations) {
    // Skip system conversations
    if (shouldSkipConversation(conv.id)) {
      continue;
    }

    // Skip spam groups (high member count)
    if (isSpamGroup(conv)) {
      const memberCount = conv.threadProperties?.membercount || "?";
      console.log(`  Skipping spam group: ${conv.displayName} (${memberCount} members)`);
      stats.spamSkipped++;
      continue;
    }

    const isGroup = isGroupChat(conv.id);
    const conversationTitle =
      decodeHtmlEntities(conv.displayName) ||
      (isGroup ? "Group Chat" : extractUsername(conv.id));

    stats.conversations++;

    // Extract participants from threadProperties if available (keep raw IDs for identity parsing)
    let participantIds: string[] = [];
    if (conv.threadProperties?.members) {
      try {
        participantIds = JSON.parse(conv.threadProperties.members);
      } catch {}
    }

    // Pre-process participant identities for this conversation
    const participantIdentifiers: string[] = [];
    for (const pId of participantIds) {
      const { platform, platformId } = parseSkypeUserId(pId);
      participantIdentifiers.push(formatIdentifier(platform, platformId));
      // Only collect identity once per conversation, not per message
      allIdentities.push({
        platform,
        platformId,
        displayName: extractUsername(pId),
      });
    }

    for (const msg of conv.MessageList || []) {
      const eventType = getEventType(msg, isGroup);
      if (!eventType) {
        stats.skipped++;
        continue;
      }

      const senderName =
        decodeHtmlEntities(msg.displayName) || extractUsername(msg.from);
      const content = extractTextContent(msg.content, msg.messagetype);
      const duration =
        msg.messagetype === "Event/Call"
          ? parseCallDuration(msg.content)
          : null;

      // For calls with duration, calculate start time and set end_timestamp
      let timestamp = msg.originalarrivaltime;
      let endTimestamp: string | null = null;
      if (eventType === "message:call" && duration) {
        const endMs = new Date(msg.originalarrivaltime).getTime();
        const startMs = endMs - duration;
        timestamp = new Date(startMs).toISOString();
        endTimestamp = msg.originalarrivaltime;
      }

      // Parse sender identity
      const { platform: senderPlatform, platformId: senderPlatformId } = parseSkypeUserId(msg.from);
      const senderIdentifier = formatIdentifier(senderPlatform, senderPlatformId);

      // Collect sender identity with display name
      allIdentities.push({
        platform: senderPlatform,
        platformId: senderPlatformId,
        displayName: senderName,
      });

      // Build people array with platform identifiers
      const people = [senderIdentifier];
      if (!isGroup && conv.id) {
        // For DMs, parse the conversation ID as the other party
        const { platform: otherPlatform, platformId: otherPlatformId } = parseSkypeUserId(conv.id);
        const otherIdentifier = formatIdentifier(otherPlatform, otherPlatformId);
        if (otherIdentifier !== senderIdentifier) {
          people.push(otherIdentifier);
          // Collect other party identity
          allIdentities.push({
            platform: otherPlatform,
            platformId: otherPlatformId,
            displayName: decodeHtmlEntities(conv.displayName) || extractUsername(conv.id),
          });
        }
      } else if (isGroup && participantIdentifiers.length > 0) {
        for (const pIdentifier of participantIdentifiers) {
          if (pIdentifier !== senderIdentifier && !people.includes(pIdentifier)) {
            people.push(pIdentifier);
          }
        }
      }

      // Create unique source_id
      const sourceId = `msg:${conv.id}:${msg.id}`;

      // Build raw data with conversation context
      const rawData = {
        ...msg,
        _conversation: {
          id: conv.id,
          displayName: conversationTitle,
          isGroup,
          participants: participantIds.map(extractUsername),
        },
      };

      try {
        insert.run(
          "skype",
          sourceId,
          sourceAccount,
          eventType,
          timestamp,
          endTimestamp,
          duration,
          conversationTitle,
          content,
          JSON.stringify(people),
          null, // tags
          JSON.stringify(rawData),
          importBatch,
          conv.id
        );

        if (eventType === "message:call" || eventType === "call:log") {
          stats.calls++;
        } else if (eventType.includes(":attachment")) {
          stats.attachments++;
        } else {
          stats.messages++;
        }
      } catch {
        stats.skipped++;
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
    stats.identitiesUpserted = uniqueIdentities.size;
  }

  onImportComplete(db);

  // Print summary
  console.log(`\n${"=".repeat(50)}`);
  console.log("Import complete:");
  console.log(`  Conversations: ${stats.conversations}`);
  console.log(`  Messages: ${stats.messages.toLocaleString()}`);
  console.log(`  Calls: ${stats.calls}`);
  console.log(`  Attachments: ${stats.attachments}`);
  console.log(`  Identities: ${stats.identitiesUpserted}`);
  console.log(`  Skipped (system): ${stats.skipped}`);
  if (stats.spamSkipped > 0) {
    console.log(`  Skipped (spam groups): ${stats.spamSkipped}`);
  }
  console.log(`  Batch ID: ${importBatch}`);
}

// CLI
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log("Usage: bun run src/parsers/skype.ts <import-path> [account-name]");
  console.log("");
  console.log("Imports Skype messages from an extracted export.");
  console.log("");
  console.log("First extract the tar file:");
  console.log("  tar -xf 8_username_export.tar -C ./skype-export");
  console.log("");
  console.log("Then run the parser:");
  console.log("  bun run src/parsers/skype.ts ./skype-export myaccount");
  process.exit(1);
}

const importPath = args[0];
const accountName = args[1] || "default";

console.log(`Importing Skype data from ${importPath}`);
console.log(`Account: ${accountName}\n`);

const db = getDb();
initDb(db);

await importSkypeData(db, importPath, accountName);

db.close();
