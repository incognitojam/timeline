import { importMemories } from "./memories";
import { parseConversation, extractedExports, detectClaudeCategory, categoryPattern } from "./export";
import { createBoundedWriter } from "../../db/bounded-writes";
import { isDeepStrictEqual } from "node:util";
import { getServiceDbPath } from "../../db/paths";
import { loadEnvFile } from "../../config";
import { configureBunSqliteForSqliteVec } from "../../embeddings/sqlite-vec";
import { existsSync } from "node:fs";
import { readJsonArray } from "./json-array";
import { Database } from "../../db/sqlite";
import { parserCliArgs } from "../../ingest/cli";

import {
  onImportComplete,
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../../db/queries";
import { basename, join, resolve } from "path";
import {
  extractText,
  toContentBlocks,
} from "../../ingest/ai/format-content";

interface ClaudeMemory {
  conversations_memory?: string;
  key_facts?: string[];
  updated_at?: string;
}

interface ImportStats {
  conversations: number;
  messages: number;
  memories: number;
  refreshed: number;
  skipped: number;
  identitiesUpserted: number;
}

export interface ImportClaudeOptions {
  refreshRawData?: boolean;
  dryRun?: boolean;
  allowNewAccount?: boolean;
}

// Claude.ai exports don't include model information, so we use a generic identifier
const CLAUDE_ASSISTANT_PLATFORM_ID = "assistant";
const CLAUDE_ASSISTANT_DISPLAY_NAME = "Claude";

export function getClaudeSkipReason(path: string): string | undefined {
  const category = categoryPattern.exec(basename(path))?.[1];
  if (!category || ["conversations", "memories"].includes(category)) return undefined;
  if (["memories", "projects"].includes(category)) throw new Error(`Claude ${category} import is not supported by this version; leave this ZIP unprocessed for a later version`);
  return `skipped: not imported (${category})`;
}

export async function importClaudeExport(db: Database, zipPath: string, sourceAccount: string, options: ImportClaudeOptions = {}): Promise<number> {
  const preview = await runClaudeImport(db, zipPath, sourceAccount, { ...options, dryRun: true }, !options.dryRun);
  if (options.dryRun) return preview.added;
  if (!options.allowNewAccount && (preview.otherAccountMessages || preview.otherAccountMemories || preview.accountHasNoHistory)) {
    throw new Error(`Export records already exist under another account or the supplied account has no history; confirm a separate account with --allow-new-account\nMessages already present under other accounts: ${preview.otherAccountMessages}\nMemories already present under other accounts: ${preview.otherAccountMemories}\nSupplied account has no history: ${preview.accountHasNoHistory}`);
  }
  return (await runClaudeImport(db, zipPath, sourceAccount, options)).added;
}

async function runClaudeImport(
  db: Database,
  zipPath: string,
  sourceAccount: string,
  options: ImportClaudeOptions = {},
  preflight = false
): Promise<{ added: number; otherAccountMessages: number; otherAccountMemories: number; accountHasNoHistory: boolean }> {
  if (!sourceAccount.trim()) throw new Error("Claude import requires an explicit account name");
  const accounts = db.prepare("SELECT DISTINCT source_account FROM events WHERE source = 'claude'").all() as { source_account: string }[];
  const accountHasNoHistory = accounts.length > 0 && !accounts.some((row) => row.source_account === sourceAccount);
  const skippedCategories = new Set<string>();
  const writer = createBoundedWriter(db);
  const existing = db.prepare("SELECT id, title, raw_data FROM events WHERE source = 'claude' AND source_id = ? AND source_account = ?");
  const otherAccount = db.prepare("SELECT 1 FROM events WHERE source = 'claude' AND source_id = ? AND source_account != ? LIMIT 1");
  let otherAccountMessages = 0;
  let otherAccountMemories = 0;
  let changedMemories = 0;
  let skippedMemories = 0;
  let emptyConversations = 0;
  let renamedConversations = 0;
  let existingMemories = 0;
  let existingMessages = 0;
  let existingConversations = 0;
  const importBatch = `claude-${sourceAccount}-${Date.now()}`;
  const refreshRawData = options.refreshRawData ?? false;

  const stats: ImportStats = {
    conversations: 0,
    messages: 0,
    memories: 0,
    refreshed: 0,
    skipped: 0,
    identitiesUpserted: 0,
  };

  // Pre-compute identifiers
  const userIdentifier = formatIdentifier("claude", sourceAccount);
  const assistantIdentifier = formatIdentifier("claude", CLAUDE_ASSISTANT_PLATFORM_ID);

  // Collect identities for batch upsert
  const identities = new Map<string, UpsertIdentityOptions>();

  // User identity
  identities.set(userIdentifier, {
    platform: "claude",
    platformId: sourceAccount,
    displayName: sourceAccount,
    username: sourceAccount,
  });

  // Assistant identity (Claude.ai doesn't include model info)
  identities.set(assistantIdentifier, {
    platform: "claude",
    platformId: CLAUDE_ASSISTANT_PLATFORM_ID,
    displayName: CLAUDE_ASSISTANT_DISPLAY_NAME,
    username: CLAUDE_ASSISTANT_PLATFORM_ID,
  });

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, tags, raw_data, import_batch, conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
  `);

  const updateRefresh = db.prepare(`
    UPDATE events SET content = ?, raw_data = ?
    WHERE source = ? AND source_id = ? AND source_account = ?
  `);

  for await (const { tempDir, category, files, zipPath: archive } of extractedExports(zipPath)) {
    if (category && !(await detectClaudeCategory(archive, tempDir, files))) throw new Error("Invalid Claude category contents");
    if (category === "memories") {
      await writer.flush();
      const memoryResult = await importMemories(db, tempDir, files, sourceAccount, options.dryRun ?? false);
      stats.memories += memoryResult.added;
      existingMemories += memoryResult.present;
      changedMemories += memoryResult.changed;
      skippedMemories += memoryResult.skipped;
      otherAccountMemories += memoryResult.otherAccountMemories;
      continue;
    }
    if (category && category !== "conversations") {
      skippedCategories.add(category);
      continue;
    }
    // Parse conversations.json
    const conversationsPath = files.find((file) => basename(file) === "conversations.json") ?? join(tempDir, "conversations.json");
    const conversationsFile = Bun.file(conversationsPath);

    if (await conversationsFile.exists()) {
      for await (const value of readJsonArray(conversationsPath)) {
        const conv = parseConversation(value);
        let conversationExists = false;
        let renamed = false;
        let importable = false;
        stats.conversations++;

        const title = conv.name || `Untitled (${conv.uuid.slice(0, 8)})`;

        for (const msg of conv.chat_messages || []) {
          const eventType =
            msg.sender === "human"
              ? "claude:message:user"
              : "claude:message:assistant";

          const blocks =
            msg.content && msg.content.length > 0
              ? toContentBlocks(msg.content)
              : toContentBlocks(msg.text);
          const contentText = extractText(blocks);
          if (blocks.length === 0) { stats.skipped++; continue; }
          importable = true;

          const people =
            msg.sender === "human"
              ? [userIdentifier]
              : [assistantIdentifier, userIdentifier];

          const tags: string[] = ["editor:claude"];
          if (msg.attachments && msg.attachments.length > 0) {
            tags.push("attachment:has");
          }
          if (msg.files && msg.files.length > 0) {
            tags.push("attachment:files");
          }
          if (blocks.some((b) => b.type === "flag")) {
            tags.push("safety:flag");
          }

          const sourceId = `${conv.uuid}:${msg.uuid}`;
          const stored = existing.get(sourceId, sourceAccount) as { id: number; title: string; raw_data: string } | null;
          if (otherAccount.get(sourceId, sourceAccount)) otherAccountMessages++;
          if (stored) { existingMessages++; conversationExists = true; if (conv.name && stored.title !== title) renamed = true; }
          if (stored && !refreshRawData && (!conv.name || stored.title === title)) {
            await writer.breathe();
            continue;
          }
          const { content: originalContent, text: originalText, ...messageFields } = msg;
          const rawData = JSON.stringify({
            ...messageFields,
            text: originalText === contentText ? undefined : originalText,
            account_uuid: conv.account?.uuid,
            original_content: isDeepStrictEqual(originalContent, blocks) ? undefined : originalContent,
            conversation_uuid: conv.uuid,
            message_uuid: msg.uuid,
            conversation_name: conv.name,
            conversation_summary: conv.summary,
            sender: msg.sender,
            attachments: msg.attachments,
            files: msg.files,
            content: blocks,
          });

          if (options.dryRun) {
            if (!stored) stats.messages++;
            else if (refreshRawData && stored.raw_data !== rawData) stats.refreshed++;
            continue;
          }
          await writer.add(() => {
          const result = insert.get(
            "claude",
            sourceId,
            sourceAccount,
            eventType,
            msg.created_at,
            title,
            contentText,
            JSON.stringify(people),
            tags.length > 0 ? JSON.stringify(tags) : null,
            rawData,
            importBatch,
            conv.uuid
          );

          if (result !== null) {
            stats.messages++;
          } else if (refreshRawData && stored && stored.raw_data !== rawData) {
            const previous = JSON.parse(stored.raw_data) as { updated_at?: string | null };
            db.prepare("INSERT INTO event_versions (event_id, observed_at, source_edited_at, raw_data) VALUES (?, ?, ?, ?)").run(stored.id, new Date().toISOString(), previous.updated_at ?? null, stored.raw_data);
            updateRefresh.run(
              contentText,
              rawData,
              "claude",
              sourceId,
              sourceAccount
            );
            stats.refreshed++;
          }
          if (stored && conv.name && stored.title !== title) db.prepare("UPDATE events SET title = ? WHERE id = ?").run(title, stored.id);
          }, rawData.length * 2);
          await writer.breathe();
        }

        if (conversationExists) existingConversations++;
        if (!importable) emptyConversations++;
        if (renamed) renamedConversations++;

      }
    }

    // Parse memories.json
    const memoriesPath = join(tempDir, "memories.json");
    const memoriesFile = Bun.file(memoriesPath);

    if (await memoriesFile.exists()) {
      const memories: ClaudeMemory[] = await memoriesFile.json();

      for (let i = 0; i < memories.length; i++) {
        const memory = memories[i];

        // Build content from memory data
        const parts: string[] = [];
        if (memory.conversations_memory) {
          parts.push(memory.conversations_memory);
        }
        if (memory.key_facts && memory.key_facts.length > 0) {
          parts.push("\nKey facts:\n" + memory.key_facts.map((f) => `- ${f}`).join("\n"));
        }

        const content = parts.join("\n");
        if (!content.trim()) {
          continue;
        }

        if (otherAccount.get(`memory:${i}`, sourceAccount)) otherAccountMemories++;
        if (existing.get(`memory:${i}`, sourceAccount)) { existingMemories++; continue; }
        if (options.dryRun) { stats.memories++; continue; }
        await writer.flush();
        const result = insert.get(
          "claude",
          `memory:${i}`,
          sourceAccount,
          "claude:memory",
          memory.updated_at || new Date().toISOString(),
          "Claude Memory",
          content,
          JSON.stringify([assistantIdentifier, userIdentifier]),
          null,
          JSON.stringify(memory),
          importBatch,
          null
        );

        if (result !== null) {
          stats.memories++;
        }
      }
    }
  }
  await writer.flush();

  // Upsert all collected identities
  if (!options.dryRun && identities.size > 0) {
    upsertIdentities(db, [...identities.values()]);
    stats.identitiesUpserted = identities.size;
  }

  if (!preflight) {
  console.log(`\n${"=".repeat(50)}`);
  console.log(options.dryRun ? "Dry run:" : "Import complete:");
  console.log(`  Conversations new: ${stats.conversations - existingConversations - emptyConversations}; already present: ${existingConversations}`);
  console.log(`  Empty conversations: ${emptyConversations}; renamed conversations: ${renamedConversations}`);
  console.log(`  Messages already present under other accounts: ${otherAccountMessages}`);
  console.log(`  Messages new: ${stats.messages}; already present: ${existingMessages}`);
  console.log("  Projects: 0 (not imported)");
  console.log(`  Memories new: ${stats.memories}; changed: ${changedMemories}; already present: ${existingMemories}; skipped empty: ${skippedMemories}`);
  console.log(`  Memories already present under other accounts: ${otherAccountMemories}`);
  if (refreshRawData) {
    console.log(`  Refreshed: ${stats.refreshed.toLocaleString()}`);
  }
  console.log(`  Identities: ${stats.identitiesUpserted}`);
  console.log(`  Empty messages skipped: ${stats.skipped}`);
  for (const category of skippedCategories) console.log(`  Skipped: not imported (${category})`);
  if (accountHasNoHistory) console.log("  Warning: supplied account has no history, but another Claude account does");
  console.log(`  Batch ID: ${importBatch}`);
  }

  if (!options.dryRun) onImportComplete(db);

  return { added: stats.messages + stats.memories, otherAccountMessages, otherAccountMemories, accountHasNoHistory };
}

// CLI
if (import.meta.main) {
  const args = parserCliArgs({
    usage: "bun run src/platforms/claude/parser.ts <export.zip> <account-name>",
    flags: ["--refresh-raw-data", "--dry-run", "--allow-new-account"],
    minArgs: 2,
    details: `Imports Claude.ai conversation export into timeline.
Export from: claude.ai → Settings → Account → Export Data

  --dry-run          Read-only counts before importing
  --allow-new-account Confirm this is a separate Claude account
  --refresh-raw-data  Archive previous raw data, then rewrite existing content + raw data

Examples:
  bun run src/platforms/claude/parser.ts ~/Downloads/data-export.zip my-account
  bun run src/platforms/claude/parser.ts ~/Downloads/data-export.zip my-account --refresh-raw-data`,
  });
  const refreshRawData = args.includes("--refresh-raw-data");
  const positional = args.filter((a) => !a.startsWith("--"));

  const zipPath = positional[0].startsWith("~")
    ? positional[0].replace("~", process.env.HOME || "")
    : positional[0];

  const accountName = positional[1];

  console.log(`Importing Claude export from ${zipPath}`);
  console.log(`Account: ${accountName}`);
  if (refreshRawData) {
    console.log(
      "Refresh mode: existing rows will have content + raw_data rewritten"
    );
  }
  console.log();

  const dryRun = args.includes("--dry-run");
  loadEnvFile();
  const dbPath = resolve(process.env.TIMELINE_DB_PATH || getServiceDbPath());
  if (!existsSync(dbPath)) throw new Error(`Database does not exist: ${dbPath}`);
  configureBunSqliteForSqliteVec();
  const db = new Database(dbPath, { readonly: dryRun, create: false });
  const count = db.prepare("SELECT count(*) AS n FROM events").get() as { n: number };
  console.log(`Database: ${dbPath} (${count.n} events)`);

  await importClaudeExport(db, zipPath, accountName, { refreshRawData, dryRun, allowNewAccount: args.includes("--allow-new-account") });

  db.close();
}
