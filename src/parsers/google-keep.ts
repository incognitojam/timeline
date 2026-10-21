import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { getDb, initDb } from "../db/schema";

interface KeepListItem {
  text: string;
  isChecked: boolean;
}

interface KeepLabel {
  name: string;
}

interface KeepNote {
  title?: string;
  textContent?: string;
  listContent?: KeepListItem[];
  color: string;
  isTrashed: boolean;
  isPinned: boolean;
  isArchived: boolean;
  labels?: KeepLabel[];
  createdTimestampUsec: number;
  userEditedTimestampUsec: number;
}

function getContent(note: KeepNote): string {
  if (note.textContent) {
    return note.textContent;
  }

  if (note.listContent) {
    return note.listContent
      .map((item) => `${item.isChecked ? "[x]" : "[ ]"} ${item.text}`)
      .filter((line) => line.trim() !== "[ ]" && line.trim() !== "[x]")
      .join("\n");
  }

  return "";
}

function getType(note: KeepNote): string {
  if (note.listContent && note.listContent.length > 0) {
    return "note:list";
  }
  return "note:text";
}

function getTags(note: KeepNote): string[] {
  const tags: string[] = [];

  if (note.labels) {
    tags.push(...note.labels.map((l) => l.name));
  }

  if (note.isPinned) tags.push("pinned");
  if (note.isArchived) tags.push("archived");
  if (note.isTrashed) tags.push("trashed");
  if (note.color !== "DEFAULT") tags.push(note.color.toLowerCase());

  return tags;
}

export async function importKeepData(
  db: Database,
  importPath: string,
  sourceAccount: string
): Promise<number> {
  const importBatch = `google-keep-${sourceAccount}-${Date.now()}`;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, tags, raw_data, import_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Find all JSON files in the Keep directory
  const files = await readdir(importPath);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));

  let totalImported = 0;
  let totalSkipped = 0;

  for (const file of jsonFiles) {
    const filePath = join(importPath, file);
    const note: KeepNote = await Bun.file(filePath).json();

    // Skip notes that are just empty
    const content = getContent(note);
    if (!note.title && !content) {
      totalSkipped++;
      continue;
    }

    // Convert microseconds to ISO timestamp
    const timestamp = new Date(note.createdTimestampUsec / 1000).toISOString();
    const type = getType(note);
    const tags = getTags(note);

    // Use filename as source_id (unique per note)
    const sourceId = basename(file, ".json");

    try {
      insert.run(
        "google-keep",
        sourceId,
        sourceAccount,
        type,
        timestamp,
        note.title || null,
        content || null,
        JSON.stringify(tags),
        JSON.stringify(note),
        importBatch
      );
      totalImported++;
    } catch (e) {
      totalSkipped++;
    }
  }

  console.log(`\nImport complete:`);
  console.log(`  Notes imported: ${totalImported}`);
  console.log(`  Skipped: ${totalSkipped}`);
  console.log(`  Batch ID: ${importBatch}`);

  return totalImported;
}

// CLI
const args = process.argv.slice(2);
if (args.length < 1) {
  console.log("Usage: bun run src/parsers/google-keep.ts <import-path> [account-name]");
  console.log("Example: bun run src/parsers/google-keep.ts ./imports/keep my-account");
  process.exit(1);
}

const importPath = args[0];
const accountName = args[1] || "default";

const db = getDb();
initDb(db);

await importKeepData(db, importPath, accountName);

db.close();
