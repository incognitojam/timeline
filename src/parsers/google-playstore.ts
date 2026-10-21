import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";

interface PlayStoreInstall {
  install: {
    doc: {
      documentType: string;
      title: string;
    };
    firstInstallationTime: string;
    lastUpdateTime?: string;
    deviceAttribute?: {
      manufacturer?: string;
      model?: string;
    };
  };
}

// File can be either an array of {install: ...} or an object with {install: [...]}
type InstallsExport = PlayStoreInstall[] | { install?: PlayStoreInstall["install"][] };

function parseTimestamp(timestampStr: string): string | null {
  try {
    const date = new Date(timestampStr);
    if (!isNaN(date.getTime())) {
      return date.toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

async function importPlayStoreInstalls(
  db: Database,
  importPath: string,
  sourceAccount: string
) {
  const importBatch = `google-playstore-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  console.log(`Loading Play Store Installs from ${importPath}...`);

  const data: InstallsExport = await Bun.file(importPath).json();

  // Handle both formats: array of {install: ...} or object with {install: [...]}
  let installs: PlayStoreInstall["install"][];
  if (Array.isArray(data)) {
    // Array format: [{install: {...}}, ...]
    installs = data.map(item => item.install);
  } else {
    // Object format: {install: [...]}
    installs = data.install || [];
  }

  console.log(`Found ${installs.length} app installs`);

  let imported = 0;
  let skipped = 0;

  const insertBatch = db.transaction(
    (items: PlayStoreInstall["install"][]) => {
      for (const install of items) {
        const timestamp = parseTimestamp(install.firstInstallationTime);
        if (!timestamp) {
          skipped++;
          continue;
        }

        const appName = install.doc?.title || "Unknown App";
        const docType = install.doc?.documentType || "app";
        const device = install.deviceAttribute;
        const deviceInfo = device
          ? `${device.manufacturer || ""} ${device.model || ""}`.trim()
          : null;

        const sourceId = `install:${timestamp}:${appName}`;

        const tags = ["app-install"];
        if (docType === "GAME") {
          tags.push("game");
        }

        const content = deviceInfo
          ? `Installed ${appName} on ${deviceInfo}`
          : `Installed ${appName}`;

        try {
          insert.run(
            "google-playstore",
            sourceId,
            sourceAccount,
            "app:install",
            timestamp,
            appName,
            content,
            JSON.stringify(tags),
            JSON.stringify(install),
            importBatch
          );
          imported++;
        } catch {
          skipped++;
        }
      }
    }
  );

  insertBatch(installs);

  // Get date range
  const dateRange = db
    .query(
      `
    SELECT MIN(timestamp) as min_date, MAX(timestamp) as max_date
    FROM events WHERE source = 'google-playstore' AND import_batch = ?
  `
    )
    .get(importBatch) as { min_date: string; max_date: string } | null;

  console.log(`\nImport complete:`);
  console.log(`  Apps imported: ${imported}`);
  console.log(`  Skipped: ${skipped}`);
  if (dateRange?.min_date) {
    console.log(
      `  Date range: ${dateRange.min_date.split("T")[0]} to ${dateRange.max_date.split("T")[0]}`
    );
  }
  console.log(`  Batch ID: ${importBatch}`);
}

// CLI
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log(
    "Usage: bun run src/parsers/google-playstore.ts <installs.json> [account-name]"
  );
  console.log("");
  console.log("Imports Google Play Store install history.");
  console.log("Path should be: Google Play Store/Installs.json");
  console.log("");
  console.log(
    "Example: bun run src/parsers/google-playstore.ts '/tmp/takeout/Google Play Store/Installs.json' my-account"
  );
  process.exit(1);
}

const importPath = args[0];
const accountName = args[1] || "default";

console.log(`Importing Play Store installs from ${importPath}`);
console.log(`Account: ${accountName}\n`);

const db = getDb();
initDb(db);

await importPlayStoreInstalls(db, importPath, accountName);

db.close();
