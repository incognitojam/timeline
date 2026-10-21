import { Database } from "bun:sqlite";
import { join } from "node:path";
import { parseCSV } from "../lib/csv";
import { runParser } from "../lib/parser-cli";
import { extractConversationId } from "../db/conversation-id";
import {
  onImportComplete,
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";

// Convert LinkedIn date formats to a full ISO 8601 timestamp.
//
// The date-only formats (connections, positions) carry no time-of-day, so we
// anchor them to UTC midnight ("T00:00:00Z") rather than emitting a bare
// "YYYY-MM-DD". A bare date sorts before the day view's lower bound
// ("YYYY-MM-DDT00:00:00") and is silently excluded from /timeline?date=...
// despite still appearing in search — see parseAmexDate for the same fix.
export function toISO(dateStr: string): string | null {
  if (!dateStr) return null;

  // "2025-12-15 20:39:35 UTC" format
  if (dateStr.includes(" UTC")) {
    return dateStr.replace(" UTC", "Z").replace(" ", "T");
  }

  // "13 Dec 2025" format (connections)
  const match = dateStr.match(/(\d{1,2}) (\w{3}) (\d{4})/);
  if (match) {
    const months: Record<string, string> = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04",
      May: "05", Jun: "06", Jul: "07", Aug: "08",
      Sep: "09", Oct: "10", Nov: "11", Dec: "12",
    };
    const [, day, mon, year] = match;
    return `${year}-${months[mon]}-${day.padStart(2, "0")}T00:00:00Z`;
  }

  // "Jan 2025" format (positions)
  const monthYear = dateStr.match(/^(\w{3}) (\d{4})$/);
  if (monthYear) {
    const months: Record<string, string> = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04",
      May: "05", Jun: "06", Jul: "07", Aug: "08",
      Sep: "09", Oct: "10", Nov: "11", Dec: "12",
    };
    const [, mon, year] = monthYear;
    return `${year}-${months[mon]}-01T00:00:00Z`;
  }

  return null;
}

/**
 * Extract LinkedIn username from profile URL
 * e.g., "https://www.linkedin.com/in/alice" → "alice"
 */
function extractUsernameFromUrl(url: string): string | null {
  if (!url) return null;
  const match = url.match(/linkedin\.com\/in\/([^/?]+)/);
  return match ? match[1] : null;
}

export async function importLinkedInData(
  db: Database,
  importPath: string,
  sourceAccount: string
) {
  const importBatch = `linkedin-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp,
      title, content, people, location_name, tags, raw_data, import_batch,
      conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let stats = { messages: 0, connections: 0, positions: 0, education: 0, skipped: 0, identitiesUpserted: 0 };

  // Collect all identities for batch upsert
  const allIdentities: UpsertIdentityOptions[] = [];

  // Import messages
  // Note: Messages only have display names, not usernames, so we use linkedin:name:...
  const messagesFile = Bun.file(join(importPath, "messages.csv"));
  if (await messagesFile.exists()) {
    const messages = parseCSV(await messagesFile.text());
    console.log(`Processing messages.csv: ${messages.length} entries`);

    for (const msg of messages) {
      const convId = msg["CONVERSATION ID"];
      const date = msg["DATE"];
      if (!convId || !date) continue;

      try {
        const title = msg["SUBJECT"] || (msg["CONTENT"] ? msg["CONTENT"].slice(0, 100) : null);

        // Build people array with platform identifiers
        // For messages, we only have display names, use name: prefix
        const people: string[] = [];
        if (msg["FROM"]) {
          const fromIdentifier = formatIdentifier("linkedin", `name:${msg["FROM"]}`);
          people.push(fromIdentifier);
          allIdentities.push({
            platform: "linkedin",
            platformId: `name:${msg["FROM"]}`,
            displayName: msg["FROM"],
          });
        }
        if (msg["TO"]) {
          const toIdentifier = formatIdentifier("linkedin", `name:${msg["TO"]}`);
          if (!people.includes(toIdentifier)) {
            people.push(toIdentifier);
          }
          allIdentities.push({
            platform: "linkedin",
            platformId: `name:${msg["TO"]}`,
            displayName: msg["TO"],
          });
        }

        insert.run(
          "linkedin",
          `message:${convId}:${date}`,
          sourceAccount,
          "message",
          toISO(date),
          null,
          title,
          msg["CONTENT"] || null,
          JSON.stringify(people),
          null,
          null,
          JSON.stringify(msg),
          importBatch,
          // Derived from the same object persisted to raw_data, so this
          // matches what extractConversationId reads back off the row.
          extractConversationId("linkedin", msg)
        );
        stats.messages++;
      } catch {
        stats.skipped++;
      }
    }
  }

  // Import connections
  const connectionsFile = Bun.file(join(importPath, "Connections.csv"));
  if (await connectionsFile.exists()) {
    // Skip the notes header line
    const text = await connectionsFile.text();
    const lines = text.split("\n");
    const dataStart = lines.findIndex((l) => l.startsWith("First Name,"));
    if (dataStart >= 0) {
      const connections = parseCSV(lines.slice(dataStart).join("\n"));
      console.log(`Processing Connections.csv: ${connections.length} entries`);

      for (const conn of connections) {
        const name = `${conn["First Name"]} ${conn["Last Name"]}`.trim();
        const connectedOn = conn["Connected On"];
        if (!name || !connectedOn) continue;

        try {
          // Extract username from URL if available
          const username = extractUsernameFromUrl(conn["URL"]);
          const platformId = username || `name:${name}`;
          const identifier = formatIdentifier("linkedin", platformId);

          // Add identity
          allIdentities.push({
            platform: "linkedin",
            platformId,
            displayName: name,
            username: username || undefined,
          });

          insert.run(
            "linkedin",
            `connection:${conn["URL"] || name}`,
            sourceAccount,
            "connection",
            toISO(connectedOn),
            null,
            `Connected with ${name}`,
            `${name} - ${conn["Position"] || ""} at ${conn["Company"] || ""}`.trim(),
            JSON.stringify([identifier]),
            null,
            conn["Company"] ? JSON.stringify([conn["Company"]]) : null,
            JSON.stringify(conn),
            importBatch,
            null
          );
          stats.connections++;
        } catch {
          stats.skipped++;
        }
      }
    }
  }

  // Import positions (job history)
  const positionsFile = Bun.file(join(importPath, "Positions.csv"));
  if (await positionsFile.exists()) {
    const positions = parseCSV(await positionsFile.text());
    console.log(`Processing Positions.csv: ${positions.length} entries`);

    for (const pos of positions) {
      const company = pos["Company Name"];
      const title = pos["Title"];
      const startedOn = pos["Started On"];
      if (!company || !startedOn) continue;

      try {
        insert.run(
          "linkedin",
          `position:${company}:${startedOn}`,
          sourceAccount,
          "job",
          toISO(startedOn),
          pos["Finished On"] ? toISO(pos["Finished On"]) : null,
          `${title} at ${company}`,
          pos["Description"] || null,
          null,
          pos["Location"] || null,
          JSON.stringify([company]),
          JSON.stringify(pos),
          importBatch,
          null
        );
        stats.positions++;
      } catch {
        stats.skipped++;
      }
    }
  }

  // Import education
  const educationFile = Bun.file(join(importPath, "Education.csv"));
  if (await educationFile.exists()) {
    const education = parseCSV(await educationFile.text());
    console.log(`Processing Education.csv: ${education.length} entries`);

    for (const edu of education) {
      const school = edu["School Name"];
      const startDate = edu["Start Date"];
      if (!school) continue;

      try {
        insert.run(
          "linkedin",
          `education:${school}:${startDate || "unknown"}`,
          sourceAccount,
          "education",
          startDate ? toISO(startDate) : null,
          edu["End Date"] ? toISO(edu["End Date"]) : null,
          `${edu["Degree Name"] || "Studied"} at ${school}`,
          edu["Notes"] || null,
          null,
          null,
          JSON.stringify([school]),
          JSON.stringify(edu),
          importBatch,
          null
        );
        stats.education++;
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
      // Prefer entries with username (actual profile URL) over name-based ones
      if (!uniqueIdentities.has(key) || (id.username && !uniqueIdentities.get(key)?.username)) {
        uniqueIdentities.set(key, id);
      }
    }
    upsertIdentities(db, [...uniqueIdentities.values()]);
    stats.identitiesUpserted = uniqueIdentities.size;
  }

  onImportComplete(db);

  console.log(`\nImport complete:`);
  console.log(`  Messages: ${stats.messages}`);
  console.log(`  Connections: ${stats.connections}`);
  console.log(`  Positions: ${stats.positions}`);
  console.log(`  Education: ${stats.education}`);
  console.log(`  Identities: ${stats.identitiesUpserted}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Batch ID: ${importBatch}`);

  return stats.messages + stats.connections + stats.positions + stats.education;
}

// CLI
if (import.meta.main) {
  runParser(importLinkedInData, {
    name: "linkedin",
    examples: ["bun run src/parsers/linkedin.ts ./imports/linkedin my-account"],
  });
}
