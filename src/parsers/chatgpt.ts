import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import {
  onImportComplete,
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";
import { mkdtemp, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import * as Schema from "effect/Schema";
import { findChatGPTConversationFiles } from "../shared/chatgpt-export";
import { backgroundCommand } from "../lib/background-priority";

const chatGPTMessageSchema = Schema.Struct({
  id: Schema.String,
  author: Schema.Struct({
    role: Schema.String,
  }),
  create_time: Schema.optional(Schema.NullOr(Schema.Number)),
  content: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        parts: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
        text: Schema.optional(Schema.NullOr(Schema.String)),
      })
    )
  ),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        model_slug: Schema.optional(Schema.NullOr(Schema.String)),
        is_visually_hidden_from_conversation: Schema.optional(Schema.NullOr(Schema.Boolean)),
      })
    )
  ),
});

const chatGPTNodeSchema = Schema.Struct({
  message: Schema.optional(Schema.NullOr(chatGPTMessageSchema)),
});

const chatGPTConversationSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  create_time: Schema.Number,
  mapping: Schema.Record({ key: Schema.String, value: chatGPTNodeSchema }),
  default_model_slug: Schema.optional(Schema.NullOr(Schema.String)),
  is_archived: Schema.optional(Schema.NullOr(Schema.Boolean)),
  is_starred: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const chatGPTConversationListSchema = Schema.Array(Schema.Unknown);
const decodeChatGPTConversation = Schema.decodeUnknownSync(chatGPTConversationSchema, {
  errors: "all",
});

type ChatGPTConversation = Schema.Schema.Type<typeof chatGPTConversationSchema>;
type ChatGPTMessage = Schema.Schema.Type<typeof chatGPTMessageSchema>;

export interface ChatGPTDecodeResult {
  conversations: ReadonlyArray<ChatGPTConversation>;
  rejected: ReadonlyArray<{ index: number; error: string }>;
}

export function decodeChatGPTConversations(input: unknown): ChatGPTDecodeResult {
  const items = Schema.decodeUnknownSync(chatGPTConversationListSchema)(input);
  const conversations: ChatGPTConversation[] = [];
  const rejected: Array<{ index: number; error: string }> = [];

  for (const [index, item] of items.entries()) {
    try {
      conversations.push(decodeChatGPTConversation(item));
    } catch (error) {
      rejected.push({ index, error: String(error) });
    }
  }

  return { conversations, rejected };
}

interface ImportStats {
  conversations: number;
  messages: number;
  skipped: number;
  identitiesUpserted: number;
}

/**
 * Format model slug into a human-readable name.
 * Examples:
 *   gpt-4o-2024-08-06 -> GPT-4o
 *   gpt-4 -> GPT-4
 *   o1-preview -> O1 Preview
 */
function formatModelDisplayName(modelSlug: string | null | undefined): string {
  if (!modelSlug) return "ChatGPT";

  // Strip date suffix (e.g., -2024-08-06)
  let cleaned = modelSlug.replace(/-\d{4}-\d{2}-\d{2}$/, "");

  // Handle GPT models specially
  if (cleaned.startsWith("gpt-")) {
    const version = cleaned.slice(4); // Remove "gpt-"
    return `GPT-${version.toUpperCase()}`;
  }

  // Handle o1, o3, etc. models
  if (/^o\d/.test(cleaned)) {
    const parts = cleaned.split("-");
    return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
  }

  // Default: title case with hyphens to spaces
  return cleaned
    .split("-")
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

function collectMessages(mapping: ChatGPTConversation["mapping"]): ChatGPTMessage[] {
  const messages = Object.values(mapping).flatMap((node) => {
    if (!node.message || node.message.metadata?.is_visually_hidden_from_conversation) {
      return [];
    }
    return [node.message];
  });

  // Sort by create_time
  messages.sort((a, b) => (a.create_time || 0) - (b.create_time || 0));

  return messages;
}

function extractContent(message: ChatGPTMessage): string {
  if (!message.content) return "";

  // Handle different content types
  if (message.content.parts) {
    const textParts = message.content.parts
      .filter((p): p is string => typeof p === "string")
      .filter((p) => p.trim());
    return textParts.join("\n");
  }

  if (message.content.text) {
    return message.content.text;
  }

  return "";
}

export async function importChatGPTExport(
  db: Database,
  zipPath: string,
  sourceAccount: string
): Promise<number> {
  const importBatch = `chatgpt-${sourceAccount}-${Date.now()}`;

  const stats: ImportStats = {
    conversations: 0,
    messages: 0,
    skipped: 0,
    identitiesUpserted: 0,
  };

  // Collect identities for batch upsert
  const identities = new Map<string, UpsertIdentityOptions>();

  // User identity (always present)
  const userIdentifier = formatIdentifier("chatgpt", sourceAccount);
  identities.set(userIdentifier, {
    platform: "chatgpt",
    platformId: sourceAccount,
    displayName: sourceAccount,
    username: sourceAccount,
  });

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp,
      title, content, people, tags, raw_data, import_batch, conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Extract ZIP to temp directory
  const tempDir = await mkdtemp(join(tmpdir(), "chatgpt-export-"));

  try {
    // Extract using unzip command
    const proc = Bun.spawn(backgroundCommand(["unzip", "-q", "-o", zipPath, "-d", tempDir]));
    await proc.exited;

    if (proc.exitCode !== 0) {
      throw new Error(`Failed to extract ZIP: exit code ${proc.exitCode}`);
    }

    const conversationFiles = findChatGPTConversationFiles(await readdir(tempDir));
    if (conversationFiles.length === 0) {
      throw new Error("ChatGPT export contains no conversation JSON files");
    }

    const seenConversationIds = new Set<string>();
    let decodedConversations = 0;
    let rejectedConversations = 0;

    for (const conversationFile of conversationFiles) {
      const decoded = decodeChatGPTConversations(
        await Bun.file(join(tempDir, conversationFile)).json()
      );
      decodedConversations += decoded.conversations.length;
      rejectedConversations += decoded.rejected.length;

      for (const rejection of decoded.rejected) {
        console.warn(
          `Skipping invalid ChatGPT conversation ${conversationFile}[${rejection.index}]: ${rejection.error}`
        );
      }

      for (const conv of decoded.conversations) {
        if (seenConversationIds.has(conv.id)) {
          console.warn(`Skipping duplicate ChatGPT conversation ${conv.id}`);
          continue;
        }
        seenConversationIds.add(conv.id);
        stats.conversations++;

        const title = conv.title || `Untitled (${conv.id.slice(0, 8)})`;
        const messages = collectMessages(conv.mapping);

        for (const msg of messages) {
          if (
            msg.author.role === "system" ||
            msg.author.role === "tool" ||
            msg.author.role === "developer"
          ) {
            stats.skipped++;
            continue;
          }

          if (msg.author.role !== "user" && msg.author.role !== "assistant") {
            console.warn(`Skipping unsupported ChatGPT author role: ${msg.author.role}`);
            stats.skipped++;
            continue;
          }

          const eventType =
            msg.author.role === "user"
              ? "chatgpt:message:user"
              : "chatgpt:message:assistant";

          const content = extractContent(msg);

          // Skip empty messages
          if (!content.trim()) {
            stats.skipped++;
            continue;
          }

          // Convert Unix timestamp to ISO string
          const timestamp = msg.create_time
            ? new Date(msg.create_time * 1000).toISOString()
            : new Date(conv.create_time * 1000).toISOString();

          // Build tags and determine model
          const tags: string[] = ["editor:chatgpt"];
          const model = msg.metadata?.model_slug || conv.default_model_slug;
          if (model && model !== "auto") {
            tags.push(`model:${model}`);
          }

          // Build qualified identifiers for people
          let people: string[];
          if (msg.author.role === "user") {
            people = [userIdentifier];
          } else {
            // Assistant message - use model as identifier, fallback to "assistant"
            const assistantPlatformId = model && model !== "auto" ? model : "assistant";
            const assistantIdentifier = formatIdentifier("chatgpt", assistantPlatformId);
            people = [assistantIdentifier, userIdentifier];

            // Add assistant identity if not already tracked
            if (!identities.has(assistantIdentifier)) {
              identities.set(assistantIdentifier, {
                platform: "chatgpt",
                platformId: assistantPlatformId,
                displayName: formatModelDisplayName(model),
                username: assistantPlatformId,
              });
            }
          }
          if (conv.is_archived) {
            tags.push("archived");
          }
          if (conv.is_starred) {
            tags.push("starred");
          }

          const result = insert.run(
            "chatgpt",
            `${conv.id}:${msg.id}`,
            sourceAccount,
            eventType,
            timestamp,
            title,
            content,
            JSON.stringify(people),
            tags.length > 0 ? JSON.stringify(tags) : null,
            JSON.stringify({
              conversation_id: conv.id,
              message_id: msg.id,
              conversation_title: conv.title,
              author_role: msg.author.role,
              model_slug: model,
              status: msg.status,
            }),
            importBatch,
            conv.id
          );

          if (result.changes > 0) {
            stats.messages++;
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
    }

    if (decodedConversations === 0 && rejectedConversations > 0) {
      throw new Error("ChatGPT export contains no valid conversations");
    }

    console.log(
      `Found ${decodedConversations} conversations across ${conversationFiles.length} file(s)`
    );
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
  console.log(`  Identities: ${stats.identitiesUpserted}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Batch ID: ${importBatch}`);

  onImportComplete(db);

  return stats.messages;
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log("Usage: bun run src/parsers/chatgpt.ts <export.zip> [account-name]");
    console.log("");
    console.log("Imports ChatGPT conversation export into timeline.");
    console.log("Export from: chatgpt.com → Settings → Data controls → Export data");
    console.log("");
    console.log("Examples:");
    console.log("  bun run src/parsers/chatgpt.ts ~/Downloads/chatgpt-export.zip my-account");
    process.exit(1);
  }

  const zipPath = args[0].startsWith("~")
    ? args[0].replace("~", process.env.HOME || "")
    : args[0];

  const accountName = args[1] || "default";

  console.log(`Importing ChatGPT export from ${zipPath}`);
  console.log(`Account: ${accountName}\n`);

  const db = getDb();
  initDb(db);

  await importChatGPTExport(db, zipPath, accountName);

  db.close();
}
