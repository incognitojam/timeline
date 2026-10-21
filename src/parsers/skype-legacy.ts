import { Database } from "bun:sqlite";
import { extractConversationId } from "../db/conversation-id";
import { getDb, initDb } from "../db/schema";
import {
  decodeHtmlEntities,
  parsePartlist,
  getCallDuration,
} from "./skype-utils";
import {
  onImportComplete,
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";

// Old Skype desktop client stored messages in a local SQLite database
// Path was: C:\Documents and Settings\<user>\Application Data\Skype\<skypename>\main.db

interface Stats {
  messages: number;
  calls: number;
  attachments: number;
  skipped: number;
  conversations: number;
  callsWithEmptyPartlist: number;
  identitiesUpserted: number;
}

// Parse call duration from XML content (for non-call events that may have duration)
function parseCallDuration(content: string): number | null {
  const match = content.match(/<duration>(\d+(?:\.\d+)?)<\/duration>/);
  if (match) {
    return Math.round(parseFloat(match[1]) * 1000);
  }
  return null;
}

// Extract readable text from body_xml, stripping XML/HTML
function extractTextContent(bodyXml: string | null, msgType: number): string | null {
  if (!bodyXml) return null;

  // Call events have <partlist> XML
  if (bodyXml.includes("<partlist")) {
    const duration = parseCallDuration(bodyXml);
    if (duration) {
      const mins = Math.floor(duration / 60000);
      const secs = Math.floor((duration % 60000) / 1000);
      return `Call (${mins}m ${secs}s)`;
    }
    return "Call";
  }

  // File transfers have <files> XML
  if (bodyXml.includes("<files")) {
    const nameMatch = bodyXml.match(/<file[^>]*>([^<]+)<\/file>/);
    if (nameMatch) {
      return `[${nameMatch[1]}]`;
    }
    return "[file transfer]";
  }

  // Regular messages - decode entities and strip tags
  let text = decodeHtmlEntities(bodyXml);
  if (text) {
    // Remove <ss> emoji tags but keep content
    text = text.replace(/<ss[^>]*>([^<]*)<\/ss>/g, "$1");
    // Remove <a> tags but keep href
    text = text.replace(/<a\s+href="([^"]+)"[^>]*>[^<]*<\/a>/g, "$1");
    // Remove quote tags
    text = text.replace(/<quote[^>]*>.*?<\/quote>/gs, "[quote]");
    // Remove any other tags
    text = text.replace(/<[^>]+>/g, "");
  }
  return text;
}

// Check if a conversation is a group chat based on displayname
// Groups have multiple participants shown as "Name1, Name2, ..."
function isGroupConversation(displayname: string | null): boolean {
  if (!displayname) return false;
  // Group displaynames contain commas separating multiple participants
  return displayname.includes(",");
}

// Message types in old Skype
// 61 = regular message
// 30 = call started
// 39 = call ended
// 68 = file transfer
// 51 = contact request sent
// 50 = contact request received

function getEventType(msgType: number, bodyXml: string | null, isGroup: boolean): string | null {

  switch (msgType) {
    case 61: // Regular message
      return isGroup ? "message:group" : "message:dm";
    case 30: // Call started - skip, we use call ended which has duration
      return null;
    case 39: // Call ended - has duration info
      return "message:call";
    case 68: // File transfer
      return isGroup ? "message:group:attachment" : "message:dm:attachment";
    case 51: // Contact request sent
    case 50: // Contact request received
      return null; // Skip contact requests
    case 60: // Birthday reminder
    case 110: // Block event
      return null;
    default:
      // Check if body contains call data
      if (bodyXml && bodyXml.includes("<partlist")) {
        return "message:call";
      }
      // Default to message
      if (msgType >= 1 && msgType <= 100) {
        return isGroup ? "message:group" : "message:dm";
      }
      return null;
  }
}

export async function importLegacySkypeData(
  targetDb: Database,
  skypeDbPath: string,
  sourceAccount: string
) {
  const importBatch = `skype-legacy-${sourceAccount}-${Date.now()}`;

  // Open the old Skype database
  const skypeDb = new Database(skypeDbPath, { readonly: true });

  // Build conversation lookup
  const conversations: Map<number, { displayname: string; identity: string }> = new Map();
  const convRows = skypeDb.query("SELECT id, displayname, identity FROM Conversations").all() as any[];
  for (const row of convRows) {
    conversations.set(row.id, {
      displayname: row.displayname || row.identity,
      identity: row.identity
    });
  }

  const insert = targetDb.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp,
      duration_ms, title, content, people, tags, raw_data, import_batch, conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const stats: Stats = {
    messages: 0,
    calls: 0,
    attachments: 0,
    skipped: 0,
    conversations: conversations.size,
    callsWithEmptyPartlist: 0,
    identitiesUpserted: 0,
  };

  // Collect all identities for batch upsert
  const allIdentities: UpsertIdentityOptions[] = [];

  const addIdentity = (platformId: string, displayName?: string | null) => {
    if (!platformId) return;
    allIdentities.push({
      platform: "skype",
      platformId,
      displayName: displayName || platformId,
    });
  };

  // Query all messages
  const messages = skypeDb.query(`
    SELECT
      id, timestamp, author, from_dispname, dialog_partner,
      chatname, body_xml, type, convo_id
    FROM Messages
    WHERE timestamp IS NOT NULL
    ORDER BY timestamp
  `).all() as any[];

  console.log(`Processing ${messages.length} messages...`);

  for (const msg of messages) {
    const conv = conversations.get(msg.convo_id);
    const conversationTitle = conv?.displayname || msg.dialog_partner || "Unknown";
    const isGroup = isGroupConversation(conv?.displayname || null);

    const eventType = getEventType(msg.type, msg.body_xml, isGroup);
    if (!eventType) {
      stats.skipped++;
      continue;
    }

    const content = extractTextContent(msg.body_xml, msg.type);

    // For call events, parse partlist for accurate participants and duration
    let people: string[];
    let duration: number | null;

    if (eventType === "message:call") {
      const participants = parsePartlist(msg.body_xml);
      // For calls, dialog_partner is null for group chats, set for DMs
      // This is more reliable than checking for commas in conversation title
      const isCallGroup = msg.dialog_partner === null;

      if (participants.length === 0) {
        // Warn about broken data but use fallback (from_dispname/author)
        console.warn(
          `WARNING: Call event ${msg.id} has empty/missing partlist, using fallback. body_xml: ${msg.body_xml?.substring(0, 100) || "null"}`
        );
        stats.callsWithEmptyPartlist++;

        const senderDisplayName = msg.from_dispname || msg.author;
        const senderIdentifier = formatIdentifier("skype", msg.author);
        people = [senderIdentifier];
        addIdentity(msg.author, senderDisplayName);

        if (!isCallGroup && msg.dialog_partner && msg.dialog_partner !== msg.author) {
          const partnerConv = Array.from(conversations.values()).find(
            (c) => c.identity === msg.dialog_partner
          );
          const partnerDisplayName = partnerConv?.displayname || msg.dialog_partner;
          const partnerIdentifier = formatIdentifier("skype", msg.dialog_partner);
          people.push(partnerIdentifier);
          addIdentity(msg.dialog_partner, partnerDisplayName);
        }

        // Still try to parse duration from body_xml even if partlist is empty
        duration = msg.body_xml ? parseCallDuration(msg.body_xml) : null;
      } else {
        const participantIdentitySet = new Set<string>();
        const peopleSet = new Set<string>();

        for (const participant of participants) {
          participantIdentitySet.add(participant.identity);
          const identifier = formatIdentifier("skype", participant.identity);
          peopleSet.add(identifier);
          addIdentity(participant.identity, participant.name || participant.identity);
        }

        if (!isCallGroup) {
          if (msg.dialog_partner && !participantIdentitySet.has(msg.dialog_partner)) {
            const partnerConv = Array.from(conversations.values()).find(
              (c) => c.identity === msg.dialog_partner
            );
            const partnerDisplayName = partnerConv?.displayname || msg.dialog_partner;
            const partnerIdentifier = formatIdentifier("skype", msg.dialog_partner);
            peopleSet.add(partnerIdentifier);
            addIdentity(msg.dialog_partner, partnerDisplayName);
          }

          if (msg.author && !participantIdentitySet.has(msg.author)) {
            const authorIdentifier = formatIdentifier("skype", msg.author);
            peopleSet.add(authorIdentifier);
            addIdentity(msg.author, msg.from_dispname || msg.author);
          }
        }

        people = [...peopleSet];
        duration = getCallDuration(participants);
      }
    } else {
      // For non-call events, use existing logic
      duration = msg.body_xml ? parseCallDuration(msg.body_xml) : null;
      const senderDisplayName = msg.from_dispname || msg.author;
      const senderIdentifier = formatIdentifier("skype", msg.author);
      people = [senderIdentifier];
      addIdentity(msg.author, senderDisplayName);

      if (!isGroup && msg.dialog_partner && msg.dialog_partner !== msg.author) {
        const partnerConv = Array.from(conversations.values()).find(
          (c) => c.identity === msg.dialog_partner
        );
        const partnerDisplayName = partnerConv?.displayname || msg.dialog_partner;
        const partnerIdentifier = formatIdentifier("skype", msg.dialog_partner);
        if (!people.includes(partnerIdentifier)) {
          people.push(partnerIdentifier);
        }
        addIdentity(msg.dialog_partner, partnerDisplayName);
      }
    }

    // Create unique source_id
    const sourceId = `legacy:${msg.id}`;

    // For calls, msg.timestamp is the end time. Calculate start from duration.
    // For other events, timestamp is the event time.
    const msgTimestampMs = msg.timestamp * 1000;
    let timestamp: string;
    let endTimestamp: string | null = null;

    if (eventType === "message:call" && duration) {
      // Call: timestamp = start, end_timestamp = end
      const startMs = msgTimestampMs - duration;
      timestamp = new Date(startMs).toISOString();
      endTimestamp = new Date(msgTimestampMs).toISOString();
    } else {
      timestamp = new Date(msgTimestampMs).toISOString();
    }

    // Raw data
    const rawData = {
      id: msg.id,
      author: msg.author,
      from_dispname: msg.from_dispname,
      dialog_partner: msg.dialog_partner,
      chatname: msg.chatname,
      type: msg.type,
      convo_id: msg.convo_id,
      body_xml: msg.body_xml,
    };

    // Derived from the same object persisted to raw_data, so this
    // matches what extractConversationId reads back off the row.
    const conversationId = extractConversationId("skype", rawData);

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
        null,
        JSON.stringify(rawData),
        importBatch,
        conversationId
      );

      if (eventType === "message:call") {
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

  skypeDb.close();

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
    upsertIdentities(targetDb, [...uniqueIdentities.values()]);
    stats.identitiesUpserted = uniqueIdentities.size;
  }

  onImportComplete(targetDb);

  // Print summary
  console.log(`\n${"=".repeat(50)}`);
  console.log("Import complete:");
  console.log(`  Conversations: ${stats.conversations}`);
  console.log(`  Messages: ${stats.messages.toLocaleString()}`);
  console.log(`  Calls: ${stats.calls}`);
  console.log(`  Attachments: ${stats.attachments}`);
  console.log(`  Identities: ${stats.identitiesUpserted}`);
  console.log(`  Skipped: ${stats.skipped}`);
  if (stats.callsWithEmptyPartlist > 0) {
    console.log(`  Calls with empty partlist (used fallback): ${stats.callsWithEmptyPartlist}`);
  }
  console.log(`  Batch ID: ${importBatch}`);
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: bun run src/parsers/skype-legacy.ts <main.db-path> [account-name]");
    console.log("");
    console.log("Imports messages from old Skype desktop client SQLite database.");
    console.log("");
    console.log("The main.db was stored at:");
    console.log("  Windows XP: C:\\Documents and Settings\\<user>\\Application Data\\Skype\\<skypename>\\main.db");
    console.log("  Windows 7+: C:\\Users\\<user>\\AppData\\Roaming\\Skype\\<skypename>\\main.db");
    console.log("");
    console.log("Example:");
    console.log("  bun run src/parsers/skype-legacy.ts /path/to/skype/main.db my-account");
    process.exit(1);
  }

  const skypeDbPath = args[0];
  const accountName = args[1] || "default";

  console.log(`Importing legacy Skype data from ${skypeDbPath}`);
  console.log(`Account: ${accountName}\n`);

  const db = getDb();
  initDb(db);

  await importLegacySkypeData(db, skypeDbPath, accountName);

  db.close();
}
