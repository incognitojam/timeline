#!/usr/bin/env bun
/**
 * Conductor Chat Parser
 *
 * Imports chat sessions from Conductor (Mac coding agent app) SQLite database.
 * Conductor stores data in SQLite with JSON content containing full Claude SDK message structure.
 *
 * Account name is auto-detected from branch prefixes (e.g., "username/feature-branch").
 *
 * Usage:
 *   bun run src/parsers/conductor.ts
 *   bun run src/parsers/conductor.ts --dry-run
 *   bun run src/parsers/conductor.ts ~/path/to/conductor.db
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { getDb, initDb } from "../db/schema";
import { onImportComplete } from "../db/queries";
import { insertStoredAttachment } from "../media/attachments";
import {
  type AiImportOptions,
  createEventWriter,
  createIdentityCollector,
} from "./shared/ai-import";
import {
  type ContentBlock,
  extractText,
  toContentBlocks,
} from "./shared/format-content";
import { storeImageBlocks } from "./shared/image-blocks";

export const DEFAULT_CONDUCTOR_DB = `${process.env.HOME}/Library/Application Support/com.conductor.app/conductor.db`;

/**
 * Detect account name from Conductor database using branch prefixes.
 * Looks for branches like "username/feature-branch" and returns the most common prefix.
 * Not perfect for third-party repo contributions, but works without repos on disk.
 */
export function detectAccountFromRepos(conductorDbPath: string): string | null {
  try {
    const db = new Database(conductorDbPath, { readonly: true });

    const branches = db
      .prepare("SELECT branch FROM workspaces WHERE branch IS NOT NULL AND branch LIKE '%/%'")
      .all() as { branch: string }[];
    db.close();

    if (branches.length === 0) return null;

    const prefixes = new Map<string, number>();
    for (const { branch } of branches) {
      const prefix = branch.split("/")[0];
      if (prefix && prefix !== "main" && prefix !== "master") {
        prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1);
      }
    }

    if (prefixes.size === 0) return null;

    let maxCount = 0;
    let mostCommon: string | null = null;
    for (const [prefix, count] of prefixes) {
      if (count > maxCount) {
        maxCount = count;
        mostCommon = prefix;
      }
    }
    return mostCommon;
  } catch {
    return null;
  }
}

interface ConductorMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string; // JSON string
  model: string | null;
  sent_at: string | null;
  created_at: string;
  turn_id: string | null;
  session_title: string | null;
  status: string | null;
  agent_type: string | null;
  workspace_name: string | null;
  branch: string | null;
  repo_name: string | null;
  repo_path: string | null;
}

interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** Parsed and extracted data from a message's content JSON */
interface ParsedMessageData {
  blocks: ContentBlock[];
  content: string;
  model?: string;
  uuid?: string;
  usage?: MessageUsage;
  stopReason?: string;
  parentToolUseId?: string;
}

export interface ImportStats {
  messages: number;
  refreshed: number;
  skipped: number;
  sessions: Set<string>;
  identitiesUpserted: number;
}

/**
 * Parse message content JSON and extract all needed fields in one pass.
 */
function parseContent(contentJson: string): ParsedMessageData {
  try {
    const parsed = JSON.parse(contentJson);
    const blocks = toContentBlocks(parsed.message?.content);

    const ptu = parsed.parent_tool_use_id;
    const parentToolUseId =
      typeof ptu === "string" && ptu.startsWith("toolu_") ? ptu : undefined;

    return {
      blocks,
      content: extractText(blocks),
      model: parsed.message?.model,
      uuid: parsed.uuid,
      usage: parsed.message?.usage,
      stopReason: parsed.message?.stop_reason,
      parentToolUseId,
    };
  } catch {
    // Fall back to the raw JSON string as a single text block so the row
    // still imports; this path is hit only on malformed content.
    return {
      blocks: [{ type: "text", text: contentJson }],
      content: contentJson,
    };
  }
}

export async function importConductor(
  db: Database,
  conductorDbPath: string,
  sourceAccount: string,
  options: AiImportOptions = {}
): Promise<ImportStats> {
  const importBatch = `conductor-${sourceAccount}-${Date.now()}`;
  const dryRun = options.dryRun ?? false;
  const refreshRawData = options.refreshRawData ?? false;

  const stats: ImportStats = {
    messages: 0,
    refreshed: 0,
    skipped: 0,
    sessions: new Set(),
    identitiesUpserted: 0,
  };

  // Collect identities for batch upsert
  const identityCollector = createIdentityCollector("conductor", sourceAccount);
  const userIdentifier = identityCollector.userIdentifier;

  // Open Conductor DB read-only
  const conductorDb = new Database(conductorDbPath, { readonly: true });

  // Query all messages with context
  const query = `
    SELECT
      m.id, m.session_id, m.role, m.content, m.model, m.sent_at, m.created_at, m.turn_id,
      s.title as session_title, s.status, s.agent_type,
      w.directory_name as workspace_name, w.branch,
      r.name as repo_name, r.root_path as repo_path
    FROM session_messages m
    JOIN sessions s ON m.session_id = s.id
    LEFT JOIN workspaces w ON s.workspace_id = w.id
    LEFT JOIN repos r ON w.repository_id = r.id
    WHERE m.sent_at IS NOT NULL AND m.cancelled_at IS NULL
    ORDER BY m.sent_at ASC
  `;

  const messages = conductorDb.prepare(query).all() as ConductorMessage[];
  console.log(`Found ${messages.length.toLocaleString()} messages in Conductor DB`);

  if (dryRun) {
    const sessions = new Set(messages.map((m) => m.session_id));
    console.log(`Sessions: ${sessions.size}`);
    console.log("\nSample messages:");
    for (const msg of messages.slice(0, 5)) {
      const { content: previewText } = parseContent(msg.content);
      const preview = previewText.slice(0, 100).replace(/\n/g, " ");
      console.log(
        `  [${msg.role}] ${msg.repo_name || "?"}/${msg.workspace_name || "?"}: ${preview}...`
      );
    }
    conductorDb.close();
    return stats;
  }

  const eventWriter = createEventWriter(db, {
    source: "conductor",
    sourceAccount,
    importBatch,
    refreshRawData,
  });

  // Wrap in transaction
  db.run("BEGIN TRANSACTION");

  try {
    for (const msg of messages) {
      const parsed = parseContent(msg.content);

      // Skip rows with no blocks at all. Assistant messages that only contain
      // tool_use blocks are kept: the text column may end up empty, but
      // raw_data.content still holds the structured blocks.
      if (parsed.blocks.length === 0) {
        stats.skipped++;
        continue;
      }

      stats.sessions.add(msg.session_id);

      // Check for an existing row before storeImageBlocks: skipping early
      // keeps re-runs from re-reading and re-storing media for every message.
      const sourceId = `${msg.session_id}:${msg.id}`;
      if (eventWriter.findExisting(sourceId) !== null && !refreshRawData) {
        stats.skipped++;
        continue;
      }

      const storedImageBlocks = await storeImageBlocks({
        blocks: parsed.blocks,
        source: "conductor",
        sourceLabel: "Conductor",
        loggerPrefix: "conductor",
        sourceAccount,
        sessionId: msg.session_id,
        messageId: msg.id,
      });
      const normalizedBlocks = storedImageBlocks.blocks;
      const contentText = extractText(normalizedBlocks);

      // Get model from content JSON (more accurate) or fall back to column
      const fullModelId = parsed.model || msg.model;

      const eventType =
        msg.role === "user"
          ? "conductor:message:user"
          : "conductor:message:assistant";

      // Title: repo_name / workspace_name: session_title
      const location = [msg.repo_name, msg.workspace_name].filter(Boolean).join(" / ");
      const title = [location, msg.session_title].filter(Boolean).join(": ") || "Conductor Chat";

      // Tags
      const tags = [
        "editor:conductor",
        msg.repo_name && `project:${msg.repo_name}`,
        fullModelId && `model:${fullModelId}`,
        msg.workspace_name && `workspace:${msg.workspace_name}`,
        msg.branch && `branch:${msg.branch}`,
        msg.agent_type && `agent:${msg.agent_type}`,
      ].filter((t): t is string => Boolean(t));

      // Build qualified identifiers for people
      const assistantIdentifier = identityCollector.registerAssistant(fullModelId);

      let people: string[];
      if (msg.role === "user") {
        people = [userIdentifier];
      } else {
        people = [assistantIdentifier, userIdentifier];
      }

      // Raw data
      const rawData = JSON.stringify({
        session_id: msg.session_id,
        message_id: msg.id,
        message_uuid: parsed.uuid,
        turn_id: msg.turn_id,
        model: fullModelId,
        usage: parsed.usage,
        stop_reason: parsed.stopReason,
        session_title: msg.session_title,
        workspace_name: msg.workspace_name,
        workspace_branch: msg.branch,
        repo_name: msg.repo_name,
        repo_path: msg.repo_path,
        agent_type: msg.agent_type,
        parent_tool_use_id: parsed.parentToolUseId,
        content: normalizedBlocks,
      });

      const { outcome, eventId } = eventWriter.write({
        sourceId,
        eventType,
        timestamp: msg.sent_at,
        title,
        content: contentText,
        people,
        tags,
        rawData,
        conversationId: msg.session_id,
      });
      if (outcome === "inserted") stats.messages++;
      else if (outcome === "refreshed") stats.refreshed++;
      else {
        stats.skipped++;
        continue;
      }

      if (eventId !== null) {
        for (const attachment of storedImageBlocks.attachments) {
          insertStoredAttachment(db, {
            eventId,
            source: "conductor",
            sourceId: attachment.sourceId,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            width: attachment.width,
            height: attachment.height,
          }, attachment.stored);
        }
      }

      // Progress indicator
      if ((stats.messages + stats.refreshed + stats.skipped) % 500 === 0) {
        console.log(
          `  Processed ${(stats.messages + stats.refreshed + stats.skipped).toLocaleString()} messages...`
        );
      }
    }

    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    conductorDb.close();
    throw error;
  }

  conductorDb.close();

  // Upsert all collected identities (only on actual import; dry runs
  // returned before reaching this point)
  stats.identitiesUpserted = identityCollector.upsertAll(db);

  // Print summary
  console.log(`\n${"=".repeat(50)}`);
  console.log("Import complete:");
  console.log(`  Sessions: ${stats.sessions.size}`);
  console.log(`  Messages: ${stats.messages.toLocaleString()}`);
  if (refreshRawData) {
    console.log(`  Refreshed: ${stats.refreshed.toLocaleString()}`);
  }
  console.log(`  Identities: ${stats.identitiesUpserted}`);
  console.log(`  Skipped: ${stats.skipped.toLocaleString()}`);
  console.log(`  Batch ID: ${importBatch}`);

  onImportComplete(db);

  return stats;
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);

  // Parse flags
  const dryRun = args.includes("--dry-run");
  const refreshRawData = args.includes("--refresh-raw-data");
  const positionalArgs = args.filter((a) => !a.startsWith("--"));

  // Determine database path from positional args (account is always auto-detected)
  const conductorDbPath = positionalArgs.length > 0
    ? (positionalArgs[0].startsWith("~")
        ? positionalArgs[0].replace("~", process.env.HOME || "")
        : positionalArgs[0])
    : DEFAULT_CONDUCTOR_DB;

  if (!existsSync(conductorDbPath)) {
    console.error(`Conductor database not found at: ${conductorDbPath}`);
    process.exit(1);
  }

  // Auto-detect account from branch prefixes
  const accountName = detectAccountFromRepos(conductorDbPath);
  if (!accountName) {
    console.error("Could not auto-detect account from branch prefixes.");
    console.error("Make sure you have workspaces with branches like 'username/feature-branch'.");
    process.exit(1);
  }
  console.log(`Auto-detected account: ${accountName}`);

  console.log(`Importing Conductor sessions from ${conductorDbPath}`);
  console.log(`Account: ${accountName}`);
  if (dryRun) {
    console.log("DRY RUN - No changes will be made");
  }
  if (refreshRawData) {
    console.log("Refresh mode: existing rows will have content + raw_data rewritten");
  }
  console.log();

  // For dry run, we don't need the Timeline database
  let db: ReturnType<typeof getDb> | null = null;
  if (!dryRun) {
    db = getDb();
    initDb(db);
  }

  const stats = await importConductor(
    db as ReturnType<typeof getDb>,
    conductorDbPath,
    accountName,
    { dryRun, refreshRawData }
  );

  if (db) {
    db.close();
  }

  // Return event count for callers
  process.exit(stats.messages > 0 || dryRun ? 0 : 1);
}
