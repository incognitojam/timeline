import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";

interface SearchActivity {
  query: string;
  url: string;
  timestamp: string;
}

function parseTimestamp(dateStr: string): string | null {
  try {
    // Convert BST/UTC to GMT for parsing
    let normalized = dateStr.replace(" BST", " GMT+0100").replace(" UTC", " GMT");
    const date = new Date(normalized);
    if (!isNaN(date.getTime())) {
      return date.toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

function decodeHtmlEntities(text: string): string {
  return text
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
    .replace(/&amp;/g, "&");
}

function parseSearchActivityHtml(html: string): SearchActivity[] {
  const activities: SearchActivity[] = [];

  // Match content cells containing activity data (same format as YouTube My Activity)
  const contentCellRegex =
    /<div class="content-cell[^"]*mdl-typography--body-1">([\s\S]*?)<\/div>/g;

  let match;
  while ((match = contentCellRegex.exec(html)) !== null) {
    const content = match[1].replace(/\u00A0/g, " ");

    if (
      !content.trim() ||
      content.includes("Products:") ||
      content.includes("Why is this here?")
    ) {
      continue;
    }

    // Extract timestamp - various formats:
    // "Mar 22, 2024, 12:10:16 PM GMT" or "22 Mar 2024, 12:10:16 GMT" or "27 Feb 2021, 22:24:57 BST"
    const timestampMatch = content.match(
      /(\w+\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?\s*(?:GMT|BST|UTC)|\d{1,2}\s+\w+\s+\d{4},\s+\d{1,2}:\d{2}:\d{2}\s+(?:GMT|BST|UTC))/
    );
    if (!timestampMatch) continue;

    const timestamp = parseTimestamp(timestampMatch[1]);
    if (!timestamp) continue;

    const trimmedContent = content.trim();

    // "Searched for <query>" pattern
    if (trimmedContent.startsWith("Searched for")) {
      const searchMatch = content.match(
        /Searched for[\s\n]*<a href="([^"]+)">([^<]*)<\/a>/
      );
      if (searchMatch) {
        activities.push({
          query: decodeHtmlEntities(searchMatch[2]),
          url: searchMatch[1],
          timestamp,
        });
      }
    }
    // "Visited <url>" pattern (for clicked search results)
    else if (trimmedContent.startsWith("Visited")) {
      const visitMatch = content.match(
        /Visited[\s\n]*<a href="([^"]+)">([^<]*)<\/a>/
      );
      if (visitMatch) {
        activities.push({
          query: decodeHtmlEntities(visitMatch[2]),
          url: visitMatch[1],
          timestamp,
        });
      }
    }
    // Plain text search (no link)
    else {
      const plainSearchMatch = content.match(/Searched for[\s\n]*([^<\n]+)/);
      if (plainSearchMatch) {
        const query = plainSearchMatch[1].trim();
        if (query && !query.includes("GMT")) {
          activities.push({
            query: decodeHtmlEntities(query),
            url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
            timestamp,
          });
        }
      }
    }
  }

  return activities;
}

export async function importGoogleSearch(
  db: Database,
  importPath: string,
  sourceAccount: string
): Promise<number> {
  const importBatch = `google-search-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  console.log(`Loading Google Search Activity from ${importPath}...`);

  const html = await Bun.file(importPath).text();
  const activities = parseSearchActivityHtml(html);

  console.log(`Found ${activities.length} search activities`);

  let imported = 0;
  let skipped = 0;

  const insertBatch = db.transaction((items: SearchActivity[]) => {
    for (const activity of items) {
      const sourceId = `search:${activity.timestamp}:${activity.query.slice(0, 50)}`;

      try {
        insert.run(
          "google-search",
          sourceId,
          sourceAccount,
          "search",
          activity.timestamp,
          activity.query,
          activity.query,
          JSON.stringify(["google", "search"]),
          JSON.stringify(activity),
          importBatch
        );
        imported++;
      } catch {
        skipped++;
      }
    }
  });

  // Process in batches
  const batchSize = 1000;
  for (let i = 0; i < activities.length; i += batchSize) {
    const batch = activities.slice(i, i + batchSize);
    insertBatch(batch);

    if ((i + batchSize) % 10000 === 0 || i + batchSize >= activities.length) {
      console.log(
        `Processed ${Math.min(i + batchSize, activities.length)} / ${activities.length}`
      );
    }
  }

  // Get date range
  const dateRange = db
    .query(
      `
    SELECT MIN(timestamp) as min_date, MAX(timestamp) as max_date
    FROM events WHERE source = 'google-search' AND import_batch = ?
  `
    )
    .get(importBatch) as { min_date: string; max_date: string } | null;

  console.log(`\nImport complete:`);
  console.log(`  Searches imported: ${imported.toLocaleString()}`);
  console.log(`  Skipped (duplicates): ${skipped}`);
  if (dateRange?.min_date) {
    console.log(
      `  Date range: ${dateRange.min_date.split("T")[0]} to ${dateRange.max_date.split("T")[0]}`
    );
  }
  console.log(`  Batch ID: ${importBatch}`);

  return imported;
}

// CLI
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log(
    "Usage: bun run src/parsers/google-search.ts <my-activity.html> [account-name]"
  );
  console.log("");
  console.log("Imports Google Search activity from My Activity HTML export.");
  console.log("Path should be: My Activity/Search/My Activity.html");
  console.log("");
  console.log(
    "Example: bun run src/parsers/google-search.ts '/tmp/takeout/My Activity/Search/My Activity.html' my-account"
  );
  process.exit(1);
}

const importPath = args[0];
const accountName = args[1] || "default";

console.log(`Importing Google Search activity from ${importPath}`);
console.log(`Account: ${accountName}\n`);

const db = getDb();
initDb(db);

await importGoogleSearch(db, importPath, accountName);

db.close();
