import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getDb, initDb } from "../db/schema";
import { upsertIdentities, type UpsertIdentityOptions } from "../db/queries";

interface Attendee {
  email?: string;
  name?: string;
}

interface CalendarEvent {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  dtstart: string;
  dtend?: string;
  created?: string;
  organizer?: string;
  attendees: Attendee[];
  status?: string;
  isAllDay: boolean;
}

function parseIcsDate(value: string, params: string): string | null {
  try {
    // Handle all-day events: DTSTART;VALUE=DATE:20160201
    if (params.includes("VALUE=DATE") || value.length === 8) {
      const year = value.substring(0, 4);
      const month = value.substring(4, 6);
      const day = value.substring(6, 8);
      return `${year}-${month}-${day}T00:00:00.000Z`;
    }

    // Handle datetime: 20161004T160000Z or 20161004T160000
    if (value.length >= 15) {
      const year = value.substring(0, 4);
      const month = value.substring(4, 6);
      const day = value.substring(6, 8);
      const hour = value.substring(9, 11);
      const min = value.substring(11, 13);
      const sec = value.substring(13, 15);

      if (value.endsWith("Z")) {
        return `${year}-${month}-${day}T${hour}:${min}:${sec}.000Z`;
      }
      // Assume UTC if no timezone specified
      return `${year}-${month}-${day}T${hour}:${min}:${sec}.000Z`;
    }

    return null;
  } catch {
    return null;
  }
}

function unfoldIcs(ics: string): string {
  // ICS uses line folding: continuation lines start with space or tab
  return ics.replace(/\r?\n[ \t]/g, "");
}

function unescapeIcs(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseIcsFile(ics: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const unfolded = unfoldIcs(ics);
  const lines = unfolded.split(/\r?\n/);

  let currentEvent: Partial<CalendarEvent> | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      currentEvent = { attendees: [], isAllDay: false };
      continue;
    }

    if (line === "END:VEVENT" && currentEvent) {
      if (currentEvent.uid && currentEvent.summary && currentEvent.dtstart) {
        events.push(currentEvent as CalendarEvent);
      }
      currentEvent = null;
      continue;
    }

    if (!currentEvent) continue;

    // Parse property: NAME;PARAMS:VALUE or NAME:VALUE
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const propPart = line.substring(0, colonIdx);
    const value = unescapeIcs(line.substring(colonIdx + 1));

    // Split property name from params
    const semiIdx = propPart.indexOf(";");
    const propName = semiIdx === -1 ? propPart : propPart.substring(0, semiIdx);
    const params = semiIdx === -1 ? "" : propPart.substring(semiIdx + 1);

    switch (propName) {
      case "UID":
        currentEvent.uid = value;
        break;
      case "SUMMARY":
        currentEvent.summary = value;
        break;
      case "DESCRIPTION":
        currentEvent.description = value;
        break;
      case "LOCATION":
        currentEvent.location = value;
        break;
      case "DTSTART":
        currentEvent.dtstart = parseIcsDate(value, params) || value;
        currentEvent.isAllDay = params.includes("VALUE=DATE") || value.length === 8;
        break;
      case "DTEND":
        currentEvent.dtend = parseIcsDate(value, params) || value;
        break;
      case "CREATED":
        currentEvent.created = parseIcsDate(value, params) || value;
        break;
      case "STATUS":
        currentEvent.status = value;
        break;
      case "ORGANIZER":
        // Extract email from "mailto:email@example.com" or CN param
        const orgMatch = value.match(/mailto:([^">\s]+)/i);
        if (orgMatch) {
          currentEvent.organizer = orgMatch[1];
        }
        break;
      case "ATTENDEE":
        const attendeeMatch = value.match(/mailto:([^">\s]+)/i);
        const cnMatch = params.match(/CN=([^;]+)/);
        if (attendeeMatch || cnMatch) {
          currentEvent.attendees?.push({
            email: attendeeMatch ? attendeeMatch[1] : undefined,
            name: cnMatch ? cnMatch[1] : undefined,
          });
        }
        break;
    }
  }

  return events;
}

function getTags(event: CalendarEvent): string[] {
  const tags: string[] = [];

  if (event.isAllDay) tags.push("all-day");
  if (event.status) tags.push(event.status.toLowerCase());
  if (event.attendees && event.attendees.length > 0) tags.push("has-attendees");
  if (event.location) tags.push("has-location");

  return tags;
}

function getDurationMs(event: CalendarEvent): number | null {
  if (!event.dtend) return null;

  try {
    const start = new Date(event.dtstart).getTime();
    const end = new Date(event.dtend).getTime();
    if (isNaN(start) || isNaN(end)) return null;
    return end - start;
  } catch {
    return null;
  }
}

/**
 * Check if event is an auto-generated contact birthday
 */
function isContactBirthday(event: CalendarEvent): boolean {
  // Must be all-day with no attendees and no description
  if (!event.isAllDay) return false;
  if (event.attendees && event.attendees.length > 0) return false;
  if (event.description && event.description.trim() !== "") return false;
  // Title must match "[Name]'s birthday" pattern
  return /^.+'s birthday$/i.test(event.summary);
}

/**
 * Extract the name from a birthday event title
 */
function extractBirthdayName(title: string): string | null {
  const match = title.match(/^(.+)'s birthday$/i);
  return match ? match[1].trim() : null;
}

const PLATFORM = "google-calendar";

/**
 * Build a qualified identifier for a Google Calendar attendee.
 * - Attendees with email: google-calendar:<email>
 * - Attendees with name only: google-calendar:name:<name>
 */
function buildAttendeeIdentifier(attendee: Attendee): string | null {
  if (attendee.email) {
    return `${PLATFORM}:${attendee.email}`;
  }
  if (attendee.name) {
    return `${PLATFORM}:name:${attendee.name}`;
  }
  return null;
}

/**
 * Build identity options for upserting an attendee.
 */
function buildAttendeeIdentityOptions(attendee: Attendee): UpsertIdentityOptions | null {
  if (attendee.email) {
    return {
      platform: PLATFORM,
      platformId: attendee.email,
      displayName: attendee.name,
    };
  }
  if (attendee.name) {
    return {
      platform: PLATFORM,
      platformId: `name:${attendee.name}`,
      displayName: attendee.name,
    };
  }
  return null;
}

/**
 * Build a qualified identifier for a birthday event.
 * Format: google-calendar:name:<Name>
 */
function buildBirthdayIdentifier(name: string): string {
  return `${PLATFORM}:name:${name}`;
}

/**
 * Build identity options for upserting a birthday person.
 */
function buildBirthdayIdentityOptions(name: string): UpsertIdentityOptions {
  return {
    platform: PLATFORM,
    platformId: `name:${name}`,
    displayName: name,
  };
}

export async function importCalendarData(
  db: Database,
  importPath: string,
  sourceAccount: string
): Promise<number> {
  const importBatch = `calendar-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp, duration_ms,
      title, content, location_name, people, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalImported = 0;
  let totalSkipped = 0;
  let birthdayEvents = 0;
  let attendeeEvents = 0;

  // Collect all identities to upsert at the end
  const identitiesToUpsert: UpsertIdentityOptions[] = [];

  // Look for ICS files
  const files = await readdir(importPath);
  const icsFiles = files.filter((f) => f.endsWith(".ics"));

  for (const file of icsFiles) {
    const filePath = join(importPath, file);
    console.log(`Processing: ${filePath}`);

    const icsContent = await Bun.file(filePath).text();
    const events = parseIcsFile(icsContent);

    console.log(`Found ${events.length} calendar events`);

    const insertMany = db.transaction((items: CalendarEvent[]) => {
      for (const event of items) {
        const tags = getTags(event);
        const durationMs = getDurationMs(event);

        // Determine people: from attendees, or from birthday title
        let people: string[] | null = null;

        if (event.attendees && event.attendees.length > 0) {
          // Build qualified identifiers for attendees
          const identifiers: string[] = [];
          for (const attendee of event.attendees) {
            const identifier = buildAttendeeIdentifier(attendee);
            if (identifier) {
              identifiers.push(identifier);
              const identityOptions = buildAttendeeIdentityOptions(attendee);
              if (identityOptions) {
                identitiesToUpsert.push(identityOptions);
              }
            }
          }
          if (identifiers.length > 0) {
            people = identifiers;
            attendeeEvents++;
          }
        } else if (isContactBirthday(event)) {
          // Birthday events - extract name from title and create identifier
          const name = extractBirthdayName(event.summary);
          if (name) {
            const identifier = buildBirthdayIdentifier(name);
            people = [identifier];
            identitiesToUpsert.push(buildBirthdayIdentityOptions(name));
            birthdayEvents++;
          }
        }

        try {
          insert.run(
            "google-calendar",
            event.uid,
            sourceAccount,
            event.isAllDay ? "event:all-day" : "event",
            event.dtstart,
            event.dtend || null,
            durationMs,
            event.summary,
            event.description || null,
            event.location || null,
            people ? JSON.stringify(people) : null,
            JSON.stringify(tags),
            JSON.stringify(event),
            importBatch
          );
          totalImported++;
        } catch {
          totalSkipped++;
        }
      }
    });

    insertMany(events);
  }

  // Upsert all collected identities
  if (identitiesToUpsert.length > 0) {
    // Deduplicate by platform + platformId
    const seen = new Set<string>();
    const uniqueIdentities = identitiesToUpsert.filter((identity) => {
      const key = `${identity.platform}:${identity.platformId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    upsertIdentities(db, uniqueIdentities);
    console.log(`  Identities upserted: ${uniqueIdentities.length}`);
  }

  console.log(`\nImport complete:`);
  console.log(`  Calendar events imported: ${totalImported}`);
  console.log(`  Events with attendees: ${attendeeEvents}`);
  console.log(`  Birthday events: ${birthdayEvents}`);
  console.log(`  Skipped: ${totalSkipped}`);
  console.log(`  Batch ID: ${importBatch}`);

  return totalImported;
}

// CLI
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log("Usage: bun run src/parsers/google-calendar.ts <import-path> [account-name]");
  console.log("");
  console.log("Import path should contain .ics files");
  console.log("");
  console.log("Example: bun run src/parsers/google-calendar.ts ./imports/calendar my-account");
  process.exit(1);
}

const importPath = args[0];
const accountName = args[1] || "default";

const db = getDb();
initDb(db);

await importCalendarData(db, importPath, accountName);

db.close();
