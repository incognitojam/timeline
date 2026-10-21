import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import {
  onImportComplete,
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  type ContentBlock,
  extractText,
  toContentBlocks,
} from "./shared/format-content";
import { backgroundCommand } from "../lib/background-priority";

interface ClaudeConversation {
  uuid: string;
  name: string;
  summary?: string;
  created_at: string;
  updated_at: string;
  chat_messages: ClaudeMessage[];
}

interface ClaudeMessage {
  uuid: string;
  text: string;
  sender: "human" | "assistant";
  created_at: string;
  updated_at?: string;
  content?: ContentBlock[];
  attachments?: unknown[];
  files?: unknown[];
}

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
}

// Claude.ai exports don't include model information, so we use a generic identifier
const CLAUDE_ASSISTANT_PLATFORM_ID = "assistant";
const CLAUDE_ASSISTANT_DISPLAY_NAME = "Claude";

export async function importClaudeExport(
  db: Database,
  zipPath: string,
  sourceAccount: string,
  options: ImportClaudeOptions = {}
): Promise<number> {
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateRefresh = db.prepare(`
    UPDATE events SET content = ?, raw_data = ?
    WHERE source = ? AND source_id = ? AND source_account = ?
  `);

  // Extract ZIP to temp directory
  const tempDir = await mkdtemp(join(tmpdir(), "claude-export-"));

  try {
    // Extract using unzip command (reliable and handles large files)
    const proc = Bun.spawn(backgroundCommand(["unzip", "-q", "-o", zipPath, "-d", tempDir]));
    await proc.exited;

    if (proc.exitCode !== 0) {
      throw new Error(`Failed to extract ZIP: exit code ${proc.exitCode}`);
    }

    // Parse conversations.json
    const conversationsPath = join(tempDir, "conversations.json");
    const conversationsFile = Bun.file(conversationsPath);

    if (await conversationsFile.exists()) {
      const conversations: ClaudeConversation[] = await conversationsFile.json();
      console.log(`Found ${conversations.length} conversations`);

      for (const conv of conversations) {
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

          if (blocks.length === 0) {
            stats.skipped++;
            continue;
          }

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
          const rawData = JSON.stringify({
            conversation_uuid: conv.uuid,
            message_uuid: msg.uuid,
            conversation_name: conv.name,
            conversation_summary: conv.summary,
            sender: msg.sender,
            attachments: msg.attachments,
            files: msg.files,
            content: blocks,
          });

          const result = insert.run(
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

          if (result.changes > 0) {
            stats.messages++;
          } else if (refreshRawData) {
            updateRefresh.run(
              contentText,
              rawData,
              "claude",
              sourceId,
              sourceAccount
            );
            stats.refreshed++;
          } else {
            stats.skipped++;
          }
        }

        // Progress indicator
        if (stats.conversations % 50 === 0) {
          console.log(
            `  Processed ${stats.conversations} conversations, ${stats.messages.toLocaleString()} messages...`
          );
        }
      }
    } else {
      console.log("No conversations.json found in export");
    }

    // Parse memories.json
    const memoriesPath = join(tempDir, "memories.json");
    const memoriesFile = Bun.file(memoriesPath);

    if (await memoriesFile.exists()) {
      const memories: ClaudeMemory[] = await memoriesFile.json();
      console.log(`Found ${memories.length} memory entries`);

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

        const result = insert.run(
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

        if (result.changes > 0) {
          stats.memories++;
        }
      }
    }
  } finally {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true });
  }

  // Upsert all collected identities
  if (identities.size > 0) {
    upsertIdentities(db, [...identities.values()]);
    stats.identitiesUpserted = identities.size;
  }

  // Print summary
  console.log(`\n${"=".repeat(50)}`);
  console.log("Import complete:");
  console.log(`  Conversations: ${stats.conversations}`);
  console.log(`  Messages: ${stats.messages.toLocaleString()}`);
  console.log(`  Memories: ${stats.memories}`);
  if (refreshRawData) {
    console.log(`  Refreshed: ${stats.refreshed.toLocaleString()}`);
  }
  console.log(`  Identities: ${stats.identitiesUpserted}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Batch ID: ${importBatch}`);

  onImportComplete(db);

  return stats.messages + stats.memories;
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  const refreshRawData = args.includes("--refresh-raw-data");
  const positional = args.filter((a) => !a.startsWith("--"));

  if (positional.length < 1) {
    console.log(
      "Usage: bun run src/parsers/claude.ts <export.zip> [account-name] [--refresh-raw-data]"
    );
    console.log("");
    console.log("Imports Claude.ai conversation export into timeline.");
    console.log("Export from: claude.ai → Settings → Account → Export Data");
    console.log("");
    console.log("Flags:");
    console.log(
      "  --refresh-raw-data  Rewrite content + raw_data for existing rows"
    );
    console.log("");
    console.log("Examples:");
    console.log(
      "  bun run src/parsers/claude.ts ~/Downloads/data-export.zip my-account"
    );
    console.log(
      "  bun run src/parsers/claude.ts ~/Downloads/data-export.zip my-account --refresh-raw-data"
    );
    process.exit(1);
  }

  const zipPath = positional[0].startsWith("~")
    ? positional[0].replace("~", process.env.HOME || "")
    : positional[0];

  const accountName = positional[1] || "default";

  console.log(`Importing Claude export from ${zipPath}`);
  console.log(`Account: ${accountName}`);
  if (refreshRawData) {
    console.log(
      "Refresh mode: existing rows will have content + raw_data rewritten"
    );
  }
  console.log();

  const db = getDb();
  initDb(db);

  await importClaudeExport(db, zipPath, accountName, { refreshRawData });

  db.close();
}
