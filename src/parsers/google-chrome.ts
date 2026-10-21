import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getDb, initDb } from "../db/schema";

interface ChromeHistoryEntry {
  favicon_url: string;
  page_transition_qualifier?: string;
  title: string;
  url: string;
  time_usec: number;
  client_id?: string;
}

interface ChromeHistory {
  "Browser History": ChromeHistoryEntry[];
}

function usecToIso(usec: number): string {
  // Chrome uses microseconds since epoch
  return new Date(usec / 1000).toISOString();
}

function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return null;
  }
}

function getTags(entry: ChromeHistoryEntry): string[] {
  const tags: string[] = [];

  const domain = extractDomain(entry.url);
  if (domain) {
    // Add simplified domain tag (e.g., "google.com" -> "google")
    const simpleDomain = domain.replace(/^www\./, "").split(".")[0];
    tags.push(simpleDomain);
  }

  if (entry.page_transition_qualifier) {
    tags.push(entry.page_transition_qualifier.toLowerCase().replace(/_/g, "-"));
  }

  return tags;
}

export async function importChromeHistory(
  db: Database,
  importPath: string,
  sourceAccount: string
): Promise<number> {
  const importBatch = `chrome-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalImported = 0;
  let totalSkipped = 0;

  // Look for History.json in various locations
  const historyFiles = [
    join(importPath, "History.json"),
    join(importPath, "Chrome", "History.json"),
  ];

  for (const filePath of historyFiles) {
    const file = Bun.file(filePath);
    if (!(await file.exists())) continue;

    console.log(`Processing: ${filePath}`);
    const data: ChromeHistory = await file.json();
    const entries = data["Browser History"];

    console.log(`Found ${entries.length} history entries`);

    const insertMany = db.transaction((items: ChromeHistoryEntry[]) => {
      for (const entry of items) {
        // Skip entries without titles (usually redirects)
        if (!entry.title) {
          totalSkipped++;
          continue;
        }

        const timestamp = usecToIso(entry.time_usec);
        const sourceId = `${entry.url}@${entry.time_usec}`;
        const domain = extractDomain(entry.url);
        const tags = getTags(entry);

        try {
          insert.run(
            "chrome",
            sourceId,
            sourceAccount,
            "browse",
            timestamp,
            entry.title,
            domain, // Store domain in content for searchability
            JSON.stringify(tags),
            JSON.stringify(entry),
            importBatch
          );
          totalImported++;
        } catch {
          totalSkipped++;
        }
      }
    });

    insertMany(entries);
  }

  console.log(`\nImport complete:`);
  console.log(`  History entries imported: ${totalImported}`);
  console.log(`  Skipped: ${totalSkipped}`);
  console.log(`  Batch ID: ${importBatch}`);

  return totalImported;
}

// CLI
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log("Usage: bun run src/parsers/google-chrome.ts <import-path> [account-name]");
  console.log("");
  console.log("Import path should contain:");
  console.log("  - History.json or Chrome/History.json");
  console.log("");
  console.log("Example: bun run src/parsers/google-chrome.ts ./imports/chrome my-account");
  process.exit(1);
}

const importPath = args[0];
const accountName = args[1] || "default";

const db = getDb();
initDb(db);

await importChromeHistory(db, importPath, accountName);

db.close();
