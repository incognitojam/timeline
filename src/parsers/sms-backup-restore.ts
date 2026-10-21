/**
 * SMS Backup & Restore Parser
 *
 * Imports SMS, MMS, and call logs from the SMS Backup & Restore Android app.
 * Can be used as a CLI tool or imported as a library.
 *
 * CLI Usage:
 *   bun run src/parsers/sms-backup-restore.ts <sms.xml> <calls.xml> [account-name]
 *   bun run src/parsers/sms-backup-restore.ts --sms <sms.xml> [account-name]
 *   bun run src/parsers/sms-backup-restore.ts --calls <calls.xml> [account-name]
 */

import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import { extractConversationId } from "../db/conversation-id";
import {
  onImportComplete,
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";
import { isPhoneNumberLike, normalizePhoneNumber } from "../lib/phone";
import { basename } from "path";

// Call types from Android
const CALL_TYPES: Record<number, string> = {
  1: "call:incoming",
  2: "call:outgoing",
  3: "call:missed",
  4: "call:voicemail",
  5: "call:rejected",
  6: "call:blocked",
};

// SMS types from Android
const SMS_TYPES: Record<number, string> = {
  1: "sms:received",
  2: "sms:sent",
  3: "sms:draft",
  4: "sms:outbox",
  5: "sms:failed",
  6: "sms:queued",
};

// MMS msg_box types from Android
const MMS_TYPES: Record<number, string> = {
  1: "mms:received",
  2: "mms:sent",
  3: "mms:draft",
  4: "mms:outbox",
};

interface CallEntry {
  number: string;
  duration: string;
  date: string;
  type: string;
  contact_name: string;
  readable_date: string;
  presentation?: string;
  subscription_id?: string;
}

interface SmsEntry {
  address: string;
  date: string;
  type: string;
  body: string;
  contact_name: string;
  readable_date: string;
  date_sent?: string;
  read?: string;
  status?: string;
}

export function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (match, code) => {
      const num = Number(code);
      return num >= 0 && num <= 0x10ffff ? String.fromCodePoint(num) : match;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (match, code) => {
      const num = parseInt(code, 16);
      return num >= 0 && num <= 0x10ffff ? String.fromCodePoint(num) : match;
    })
    // &amp; last so we don't double-decode entities that contained a literal "&amp;"
    .replace(/&amp;/g, "&");
}

export function parseXmlAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Match attribute="value" or attribute='value'
  const attrRegex = /(\w+)=["']([^"']*)["']/g;
  let match;
  while ((match = attrRegex.exec(tag)) !== null) {
    attrs[match[1]] = decodeXmlText(match[2]);
  }
  return attrs;
}

/**
 * Import call logs from an XML file
 */
export async function importCalls(
  db: Database,
  filePath: string,
  sourceAccount: string,
  options: { silent?: boolean } = {}
): Promise<{ imported: number; identities: number; unkeyed: number }> {
  const importBatch = `sms-backup-restore-calls-${sourceAccount}-${Date.now()}`;
  const content = await Bun.file(filePath).text();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp, duration_ms,
      title, content, people, raw_data, import_batch, conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Find all <call ... /> tags
  const callRegex = /<call\s+[^>]+\/>/g;
  const calls = content.match(callRegex) || [];

  let imported = 0;
  let skipped = 0;
  let unkeyed = 0;
  const allIdentities: UpsertIdentityOptions[] = [];

  // Get the owner's phone identity (use sourceAccount as platform ID)
  const ownerIdentifier = formatIdentifier("phone", sourceAccount);

  const insertMany = db.transaction((entries: string[]) => {
    for (const callTag of entries) {
      const attrs = parseXmlAttributes(callTag) as unknown as CallEntry;

      const timestamp = parseInt(attrs.date);
      const duration = parseInt(attrs.duration) || 0;
      const callType = parseInt(attrs.type);
      const type = CALL_TYPES[callType] || `call:type${callType}`;

      // Normalize phone number for identifier
      const normalizedNumber = normalizePhoneNumber(attrs.number);
      const otherPartyIdentifier = formatIdentifier("phone", normalizedNumber);

      // Generate unique ID from timestamp + number
      const sourceId = `${attrs.date}-${normalizedNumber}`;

      // Title is just the contact name (event type distinguishes call direction)
      const contactName =
        attrs.contact_name !== "(Unknown)" ? attrs.contact_name : attrs.number;
      const title = contactName;

      // Format duration for content (calls don't have text content, just metadata)
      const durationStr =
        duration > 0
          ? `${Math.floor(duration / 60)}m ${duration % 60}s`
          : "No answer";
      const contentStr = durationStr;

      // Collect other party identity with contact name if available
      allIdentities.push({
        platform: "phone",
        platformId: normalizedNumber,
        displayName: attrs.contact_name !== "(Unknown)" && !isPhoneNumberLike(attrs.contact_name) ? attrs.contact_name : undefined,
      });

      // People array with platform identifiers: [sender, recipient]
      // Incoming call (1): contact called me
      // Outgoing call (2): I called contact
      let people: string[];
      if (callType === 1 || callType === 3 || callType === 5 || callType === 6) {
        // Incoming, missed, rejected, blocked - contact is sender
        people = [otherPartyIdentifier, ownerIdentifier];
      } else {
        // Outgoing - I am sender
        people = [ownerIdentifier, otherPartyIdentifier];
      }

      // Derived from the same object persisted to raw_data, so this matches
      // what extractConversationId reads back off the row. A row with no
      // number cannot be keyed (the insert guard would abort the batch).
      const conversationId = extractConversationId("phone", attrs);
      if (!conversationId) {
        unkeyed++;
        continue;
      }
      const result = insert.run(
        "phone",
        sourceId,
        sourceAccount,
        type,
        new Date(timestamp).toISOString(),
        duration * 1000, // Convert to ms
        title,
        contentStr,
        JSON.stringify(people),
        JSON.stringify(attrs),
        importBatch,
        conversationId
      );
      if (result.changes > 0) {
        imported++;
      } else {
        skipped++;
      }
    }
  });

  insertMany(calls);

  // Batch upsert identities
  let identitiesUpserted = 0;
  if (allIdentities.length > 0) {
    const uniqueIdentities = new Map<string, UpsertIdentityOptions>();
    for (const id of allIdentities) {
      const key = `${id.platform}:${id.platformId}`;
      if (!uniqueIdentities.has(key) || (id.displayName && !uniqueIdentities.get(key)?.displayName)) {
        uniqueIdentities.set(key, id);
      }
    }
    upsertIdentities(db, [...uniqueIdentities.values()]);
    identitiesUpserted = uniqueIdentities.size;
  }

  onImportComplete(db);

  if (!options.silent) {
    console.log(`Calls import complete:`);
    console.log(`  Imported: ${imported}`);
    console.log(`  Identities: ${identitiesUpserted}`);
    console.log(`  Skipped: ${skipped}`);
    console.log(`  Batch ID: ${importBatch}`);
  }

  if (unkeyed > 0) {
    console.warn(`  Skipped ${unkeyed} row(s) with no address/number (no conversation id)`);
  }
  return { imported, identities: identitiesUpserted, unkeyed };
}

/**
 * Import SMS messages from an XML file
 */
export async function importSms(
  db: Database,
  filePath: string,
  sourceAccount: string,
  options: { silent?: boolean } = {}
): Promise<{ imported: number; identities: number; unkeyed: number }> {
  const importBatch = `sms-backup-restore-sms-${sourceAccount}-${Date.now()}`;
  const content = await Bun.file(filePath).text();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, raw_data, import_batch, conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Find all <sms ... /> tags
  const smsRegex = /<sms\s+[^>]+\/>/g;
  const messages = content.match(smsRegex) || [];

  let imported = 0;
  let skipped = 0;
  let unkeyed = 0;
  const allIdentities: UpsertIdentityOptions[] = [];

  // Get the owner's phone identity
  const ownerIdentifier = formatIdentifier("phone", sourceAccount);

  const insertMany = db.transaction((entries: string[]) => {
    for (const smsTag of entries) {
      const attrs = parseXmlAttributes(smsTag) as unknown as SmsEntry;

      const timestamp = parseInt(attrs.date);
      const smsType = parseInt(attrs.type);
      const type = SMS_TYPES[smsType] || `sms:type${smsType}`;

      // Normalize phone number for identifier
      const normalizedAddress = normalizePhoneNumber(attrs.address);
      const otherPartyIdentifier = formatIdentifier("phone", normalizedAddress);

      // Generate unique ID from timestamp + address
      const sourceId = `${attrs.date}-${normalizedAddress}`;

      // Title is just the contact name (event type distinguishes direction)
      const contactName =
        attrs.contact_name !== "(Unknown)"
          ? attrs.contact_name
          : attrs.address;
      const title = contactName;

      // Collect other party identity with contact name if available
      allIdentities.push({
        platform: "phone",
        platformId: normalizedAddress,
        displayName: attrs.contact_name !== "(Unknown)" && !isPhoneNumberLike(attrs.contact_name) ? attrs.contact_name : undefined,
      });

      // People array with platform identifiers: [sender, recipient]
      // Received (1): contact sent to me
      // Sent (2): I sent to contact
      let people: string[];
      if (smsType === 2) {
        // Sent - I am sender
        people = [ownerIdentifier, otherPartyIdentifier];
      } else {
        // Received - contact is sender
        people = [otherPartyIdentifier, ownerIdentifier];
      }

      // A message with an empty address cannot be keyed; skip it rather than
      // let the insert guard abort the whole batch.
      const conversationId = extractConversationId("phone", attrs);
      if (!conversationId) {
        unkeyed++;
        continue;
      }
      const result = insert.run(
        "phone",
        sourceId,
        sourceAccount,
        type,
        new Date(timestamp).toISOString(),
        title,
        attrs.body || "",
        JSON.stringify(people),
        JSON.stringify(attrs),
        importBatch,
        conversationId
      );
      if (result.changes > 0) {
        imported++;
      } else {
        skipped++;
      }
    }
  });

  insertMany(messages);

  // Batch upsert identities
  let identitiesUpserted = 0;
  if (allIdentities.length > 0) {
    const uniqueIdentities = new Map<string, UpsertIdentityOptions>();
    for (const id of allIdentities) {
      const key = `${id.platform}:${id.platformId}`;
      if (!uniqueIdentities.has(key) || (id.displayName && !uniqueIdentities.get(key)?.displayName)) {
        uniqueIdentities.set(key, id);
      }
    }
    upsertIdentities(db, [...uniqueIdentities.values()]);
    identitiesUpserted = uniqueIdentities.size;
  }

  onImportComplete(db);

  if (!options.silent) {
    console.log(`SMS import complete:`);
    console.log(`  Imported: ${imported}`);
    console.log(`  Identities: ${identitiesUpserted}`);
    console.log(`  Skipped: ${skipped}`);
    console.log(`  Batch ID: ${importBatch}`);
  }

  if (unkeyed > 0) {
    console.warn(`  Skipped ${unkeyed} row(s) with no address/number (no conversation id)`);
  }
  return { imported, identities: identitiesUpserted, unkeyed };
}

/**
 * Import MMS messages from an XML file
 */
export async function importMms(
  db: Database,
  filePath: string,
  sourceAccount: string,
  options: { silent?: boolean } = {}
): Promise<{ imported: number; identities: number; unkeyed: number }> {
  const importBatch = `sms-backup-restore-mms-${sourceAccount}-${Date.now()}`;
  const content = await Bun.file(filePath).text();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, raw_data, import_batch, conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Find all <mms ...>...</mms> blocks
  const mmsRegex = /<mms\s+([^>]+)>[\s\S]*?<\/mms>/g;
  let imported = 0;
  let skipped = 0;
  let unkeyed = 0;
  const allIdentities: UpsertIdentityOptions[] = [];

  // Get the owner's phone identity
  const ownerIdentifier = formatIdentifier("phone", sourceAccount);

  const mmsBlocks: Array<{ attrs: string; block: string }> = [];
  let mmsMatch;
  while ((mmsMatch = mmsRegex.exec(content)) !== null) {
    mmsBlocks.push({ attrs: mmsMatch[1], block: mmsMatch[0] });
  }

  const insertMany = db.transaction(
    (entries: Array<{ attrs: string; block: string }>) => {
      for (const { attrs: attrStr, block } of entries) {
        const attrs = parseXmlAttributes(`<mms ${attrStr}>`);

        const timestamp = parseInt(attrs.date);
        // Skip messages with date=0 (corrupted/invalid)
        if (timestamp === 0) {
          skipped++;
          continue;
        }

        const msgBox = parseInt(attrs.msg_box);
        const type = MMS_TYPES[msgBox] || `mms:type${msgBox}`;

        // Extract text from <part> elements
        const partRegex = /<part\s+[^>]*text="([^"]*)"[^>]*\/>/g;
        const textParts: string[] = [];
        let partMatch;
        while ((partMatch = partRegex.exec(block)) !== null) {
          const text = decodeXmlText(partMatch[1]);
          if (text.trim()) {
            textParts.push(text);
          }
        }

        const body = textParts.join("\n");

        // Normalize phone number for identifier
        const normalizedAddress = normalizePhoneNumber(attrs.address);
        const otherPartyIdentifier = formatIdentifier("phone", normalizedAddress);

        // Generate unique ID from timestamp + address
        const sourceId = `mms-${attrs.date}-${normalizedAddress}-${attrs._id || ""}`;

        // Title is just the contact name (event type distinguishes direction)
        const contactName =
          attrs.contact_name !== "(Unknown)"
            ? attrs.contact_name
            : attrs.address;
        const title = contactName;

        // Collect other party identity with contact name if available
        allIdentities.push({
          platform: "phone",
          platformId: normalizedAddress,
          displayName: attrs.contact_name !== "(Unknown)" && !isPhoneNumberLike(attrs.contact_name) ? attrs.contact_name : undefined,
        });

        // People array with platform identifiers: [sender, recipient]
        // Received (1): contact sent to me
        // Sent (2): I sent to contact
        let people: string[];
        if (msgBox === 2) {
          // Sent - I am sender
          people = [ownerIdentifier, otherPartyIdentifier];
        } else {
          // Received - contact is sender
          people = [otherPartyIdentifier, ownerIdentifier];
        }

        const rawData = { ...attrs, text_content: body };
        const conversationId = extractConversationId("phone", rawData);
        if (!conversationId) {
          unkeyed++;
          continue;
        }
        const result = insert.run(
          "phone",
          sourceId,
          sourceAccount,
          type,
          new Date(timestamp).toISOString(),
          title,
          body,
          JSON.stringify(people),
          JSON.stringify(rawData),
          importBatch,
          conversationId
        );
        if (result.changes > 0) {
          imported++;
        } else {
          skipped++;
        }
      }
    }
  );

  insertMany(mmsBlocks);

  // Batch upsert identities
  let identitiesUpserted = 0;
  if (allIdentities.length > 0) {
    const uniqueIdentities = new Map<string, UpsertIdentityOptions>();
    for (const id of allIdentities) {
      const key = `${id.platform}:${id.platformId}`;
      if (!uniqueIdentities.has(key) || (id.displayName && !uniqueIdentities.get(key)?.displayName)) {
        uniqueIdentities.set(key, id);
      }
    }
    upsertIdentities(db, [...uniqueIdentities.values()]);
    identitiesUpserted = uniqueIdentities.size;
  }

  onImportComplete(db);

  if (!options.silent) {
    console.log(`MMS import complete:`);
    console.log(`  Imported: ${imported}`);
    console.log(`  Identities: ${identitiesUpserted}`);
    console.log(`  Skipped: ${skipped}`);
    console.log(`  Batch ID: ${importBatch}`);
  }

  if (unkeyed > 0) {
    console.warn(`  Skipped ${unkeyed} row(s) with no address/number (no conversation id)`);
  }
  return { imported, identities: identitiesUpserted, unkeyed };
}

/**
 * Auto-detect file type and process accordingly.
 * Used by inbox processor for automatic file handling.
 */
export async function processSmsFile(
  db: Database,
  filePath: string,
  sourceAccount: string | null
): Promise<number> {
  if (!sourceAccount) {
    throw new Error("SMS parser requires 'account' to be specified in config");
  }

  const content = await Bun.file(filePath).text();
  const fileName = basename(filePath).toLowerCase();

  let total = 0;

  // Check what's in the file
  const hasSms = content.includes("<sms ");
  const hasMms = content.includes("<mms ");
  const hasCalls = content.includes("<call ");

  // Also check filename hints
  const isCallsFile = fileName.includes("call");

  // Import silently when used as library
  const options = { silent: true };

  if (hasCalls && (isCallsFile || !hasSms)) {
    const result = await importCalls(db, filePath, sourceAccount, options);
    total += result.imported;
  }

  if (hasSms) {
    const result = await importSms(db, filePath, sourceAccount, options);
    total += result.imported;
  }

  if (hasMms) {
    const result = await importMms(db, filePath, sourceAccount, options);
    total += result.imported;
  }

  return total;
}

// CLI - only runs when executed directly
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log(
      "Usage: bun run src/parsers/sms-backup-restore.ts <sms.xml> <calls.xml> [account-name]"
    );
    console.log(
      "   or: bun run src/parsers/sms-backup-restore.ts --sms <sms.xml> [account-name]"
    );
    console.log(
      "   or: bun run src/parsers/sms-backup-restore.ts --calls <calls.xml> [account-name]"
    );
    console.log("\nExamples:");
    console.log(
      "  bun run src/parsers/sms-backup-restore.ts ./sms.xml ./calls.xml my-account"
    );
    console.log(
      "  bun run src/parsers/sms-backup-restore.ts --sms ./sms.xml my-account"
    );
    process.exit(1);
  }

  const db = getDb();
  initDb(db);

  if (args[0] === "--sms") {
    const smsPath = args[1];
    const accountName = args[2] || "default";
    await importSms(db, smsPath, accountName);
    console.log("\nImporting MMS messages...\n");
    await importMms(db, smsPath, accountName);
  } else if (args[0] === "--calls") {
    const callsPath = args[1];
    const accountName = args[2] || "default";
    await importCalls(db, callsPath, accountName);
  } else {
    const smsPath = args[0];
    const callsPath = args[1];
    const accountName = args[2] || "default";

    console.log("Importing SMS messages...\n");
    await importSms(db, smsPath, accountName);

    console.log("\nImporting MMS messages...\n");
    await importMms(db, smsPath, accountName);

    console.log("\nImporting call logs...\n");
    await importCalls(db, callsPath, accountName);
  }

  db.close();
}
