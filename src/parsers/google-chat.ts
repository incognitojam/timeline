import { Database } from "bun:sqlite";
import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { getDb, initDb } from "../db/schema";
import { extractConversationId } from "../db/conversation-id";
import {
  onImportComplete,
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";

interface ChatMember {
  name: string;
  email: string;
  user_type: string;
}

interface ChatGroupInfo {
  name: string;
  members: ChatMember[];
  emoji_id?: string;
}

interface ChatMessage {
  creator: {
    name: string;
    email: string;
    user_type: string;
  };
  created_date: string;
  text: string;
  topic_id: string;
  message_id: string;
  attached_files?: Array<{ export_name: string }>;
}

interface ChatMessages {
  messages: ChatMessage[];
}

interface UserInfo {
  name: string;
  email: string;
  user_type?: string;
}

function parseGoogleDate(dateStr: string): string | null {
  // Format: "Friday, 21 May 2021 at 14:41:21 UTC"
  try {
    const cleaned = dateStr.replace(" at ", " ").replace(" UTC", " UTC");
    const date = new Date(cleaned);
    if (isNaN(date.getTime())) {
      // Try alternate parsing
      const match = dateStr.match(/(\d+)\s+(\w+)\s+(\d+)\s+at\s+(\d+):(\d+):(\d+)/);
      if (match) {
        const [, day, month, year, hour, min, sec] = match;
        const monthMap: Record<string, number> = {
          January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
          July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
        };
        const d = new Date(Date.UTC(
          parseInt(year),
          monthMap[month] ?? 0,
          parseInt(day),
          parseInt(hour),
          parseInt(min),
          parseInt(sec)
        ));
        return d.toISOString();
      }
      return null;
    }
    return date.toISOString();
  } catch {
    return null;
  }
}

export async function importChatData(
  db: Database,
  importPath: string,
  sourceAccount: string
): Promise<number> {
  const importBatch = `google-chat-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, tags, raw_data, import_batch, conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalImported = 0;
  let totalSkipped = 0;

  // Collect all identities for batch upsert
  const allIdentities: UpsertIdentityOptions[] = [];

  // Process Groups directory
  const groupsDir = join(importPath, "Groups");
  try {
    const spaces = await readdir(groupsDir);

    for (const space of spaces) {
      const spacePath = join(groupsDir, space);
      const spaceStat = await stat(spacePath);
      if (!spaceStat.isDirectory()) continue;

      // Read group info if available
      let groupName = space;
      let members: ChatMember[] = [];
      try {
        const groupInfo: ChatGroupInfo = await Bun.file(
          join(spacePath, "group_info.json")
        ).json();
        groupName = groupInfo.name || space;
        members = groupInfo.members || [];
      } catch {
        // No group info, use space name
      }

      // Collect member identities
      const memberIdentifiers: string[] = [];
      for (const m of members) {
        if (m.email) {
          const identifier = formatIdentifier("google-chat", m.email);
          memberIdentifiers.push(identifier);
          allIdentities.push({
            platform: "google-chat",
            platformId: m.email,
            displayName: m.name,
          });
        }
      }

      // Read messages
      const messagesPath = join(spacePath, "messages.json");
      try {
        const data: ChatMessages = await Bun.file(messagesPath).json();

        console.log(`Processing ${groupName}: ${data.messages.length} messages`);

        for (const msg of data.messages) {
          // Skip system messages like "Updated room membership"
          if (msg.text.includes("Updated room membership")) {
            totalSkipped++;
            continue;
          }

          const timestamp = parseGoogleDate(msg.created_date);
          if (!timestamp) {
            totalSkipped++;
            continue;
          }

          const tags: string[] = ["group"];
          if (msg.attached_files && msg.attached_files.length > 0) {
            tags.push("has-attachment");
          }

          // Build people array with platform identifiers
          const senderEmail = msg.creator.email;
          const senderIdentifier = formatIdentifier("google-chat", senderEmail);

          // Add sender identity
          allIdentities.push({
            platform: "google-chat",
            platformId: senderEmail,
            displayName: msg.creator.name,
          });

          // People: sender first, then other members
          const people = [senderIdentifier];
          for (const mi of memberIdentifiers) {
            if (mi !== senderIdentifier && !people.includes(mi)) {
              people.push(mi);
            }
          }

          try {
            const rawData = { ...msg, group: groupName, members: members.map(m => m.name) };
            insert.run(
              "google-chat",
              msg.message_id,
              sourceAccount,
              "message",
              timestamp,
              groupName,
              msg.text,
              JSON.stringify(people),
              JSON.stringify(tags),
              JSON.stringify(rawData),
              importBatch,
              // Derived from the same object persisted to raw_data, so this
              // matches what extractConversationId reads back off the row.
              extractConversationId("google-chat", rawData)
            );
            totalImported++;
          } catch (e) {
            totalSkipped++;
          }
        }
      } catch {
        // No messages file
      }
    }
  } catch {
    // No Groups directory
  }

  // Process Users directory (DMs)
  const usersDir = join(importPath, "Users");
  try {
    const users = await readdir(usersDir);

    for (const user of users) {
      const userPath = join(usersDir, user);
      const userStat = await stat(userPath);
      if (!userStat.isDirectory()) continue;

      // Read user info if available
      let userName = user;
      let userEmail: string | null = null;
      try {
        const userInfo: UserInfo = await Bun.file(join(userPath, "user_info.json")).json();
        userName = userInfo.name || user;
        userEmail = userInfo.email || null;
      } catch {
        // No user info
      }

      // Add DM partner identity if we have email
      let dmPartnerIdentifier: string | null = null;
      if (userEmail) {
        dmPartnerIdentifier = formatIdentifier("google-chat", userEmail);
        allIdentities.push({
          platform: "google-chat",
          platformId: userEmail,
          displayName: userName,
        });
      }

      // Read messages
      const messagesPath = join(userPath, "messages.json");
      try {
        const data: ChatMessages = await Bun.file(messagesPath).json();

        console.log(`Processing DM with ${userName}: ${data.messages.length} messages`);

        for (const msg of data.messages) {
          const timestamp = parseGoogleDate(msg.created_date);
          if (!timestamp) {
            totalSkipped++;
            continue;
          }

          const tags: string[] = ["dm"];
          if (msg.attached_files && msg.attached_files.length > 0) {
            tags.push("has-attachment");
          }

          // Build people array with platform identifiers
          const senderEmail = msg.creator.email;
          const senderIdentifier = formatIdentifier("google-chat", senderEmail);

          // Add sender identity
          allIdentities.push({
            platform: "google-chat",
            platformId: senderEmail,
            displayName: msg.creator.name,
          });

          // People: sender first, then DM partner (if different)
          const people = [senderIdentifier];
          if (dmPartnerIdentifier && dmPartnerIdentifier !== senderIdentifier) {
            people.push(dmPartnerIdentifier);
          }

          try {
            const rawData = { ...msg, dm_with: userName, dm_with_email: userEmail };
            insert.run(
              "google-chat",
              msg.message_id,
              sourceAccount,
              "message",
              timestamp,
              `DM: ${userName}`,
              msg.text,
              JSON.stringify(people),
              JSON.stringify(tags),
              JSON.stringify(rawData),
              importBatch,
              extractConversationId("google-chat", rawData)
            );
            totalImported++;
          } catch (e) {
            totalSkipped++;
          }
        }
      } catch {
        // No messages file
      }
    }
  } catch {
    // No Users directory
  }

  // Batch upsert all collected identities
  let identitiesUpserted = 0;
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
    identitiesUpserted = uniqueIdentities.size;
  }

  onImportComplete(db);

  console.log(`\nImport complete:`);
  console.log(`  Messages imported: ${totalImported}`);
  console.log(`  Identities: ${identitiesUpserted}`);
  console.log(`  Skipped: ${totalSkipped}`);
  console.log(`  Batch ID: ${importBatch}`);

  return totalImported;
}

// CLI - only runs when executed directly
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log("Usage: bun run src/parsers/google-chat.ts <import-path> [account-name]");
    console.log("Example: bun run src/parsers/google-chat.ts './imports/Google Chat' my-account");
    process.exit(1);
  }

  const importPath = args[0];
  const accountName = args[1] || "default";

  const db = getDb();
  initDb(db);

  await importChatData(db, importPath, accountName);

  db.close();
}
