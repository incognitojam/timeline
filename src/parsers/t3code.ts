#!/usr/bin/env bun
/**
 * T3 Code Chat Parser
 *
 * Imports chat threads from T3 Code (desktop coding agent app) SQLite state
 * database at ~/.t3/userdata/state.sqlite. T3 Code drives external agent
 * providers (claudeAgent, codex, opencode, ...); messages are stored as plain
 * text in projection tables, and tool calls in projection_thread_activities.
 * Completed tool activities import as assistant events whose raw_data.content
 * carries tool_use/tool_result blocks (payload shape differs per provider;
 * both are normalized to the shared ContentBlock vocabulary).
 *
 * Usage:
 *   bun run src/parsers/t3code.ts [account] [--dry-run] [--refresh-raw-data]
 *   bun run src/parsers/t3code.ts alice ~/.t3/userdata/state.sqlite
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, extname, join } from "path";
import { onImportComplete } from "../db/queries";
import { getDb, initDb } from "../db/schema";
import { insertStoredAttachment } from "../media/attachments";
import { type StoreFileResult, storeFile } from "../media/storage";
import {
  type AiImportOptions,
  createEventWriter,
  createIdentityCollector,
} from "./shared/ai-import";
import type { ContentBlock } from "./shared/format-content";
import {
  errorMessage,
  imageExtensionsForMimeType,
  recordFromUnknown,
  safePathPart,
} from "./shared/image-blocks";

export const DEFAULT_T3CODE_DB = `${process.env.HOME}/.t3/userdata/state.sqlite`;

// Thread/project/session columns shared by the message and activity queries.
interface T3ThreadRow {
  thread_id: string;
  turn_id: string | null;
  created_at: string;
  thread_title: string | null;
  branch: string | null;
  worktree_path: string | null;
  model_selection_json: string | null;
  thread_archived: number;
  thread_deleted: number;
  project_title: string | null;
  workspace_root: string | null;
  provider_name: string | null;
}

interface T3CodeMessage extends T3ThreadRow {
  message_id: string;
  role: "user" | "assistant";
  text: string;
  attachments_json: string | null;
}

interface T3CodeActivity extends T3ThreadRow {
  activity_id: string;
  payload_json: string;
}

interface ModelSelection {
  instanceId?: string;
  model?: string;
  options?: { id: string; value: string }[];
}

interface T3CodeImageAttachmentMetadata {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes?: number;
  extension: string;
  diskExtensions: string[];
}

export interface StoredT3CodeImageAttachment {
  sourceId: string;
  filename: string;
  mimeType: string;
  stored: StoreFileResult;
}

export interface ImportStats {
  messages: number;
  toolCalls: number;
  refreshed: number;
  skipped: number;
  threads: Set<string>;
  identitiesUpserted: number;
}

function parseModelSelection(json: string | null): ModelSelection {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function parseAttachments(json: string | null): unknown[] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function t3CodeAttachmentsDir(t3DbPath: string): string {
  return join(dirname(t3DbPath), "attachments");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isSafePathPart(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function parseImageAttachmentMetadata(value: unknown): T3CodeImageAttachmentMetadata | null {
  const attachment = recordFromUnknown(value);
  if (!attachment || attachment.type !== "image") return null;

  const id = asString(attachment.id);
  const name = asString(attachment.name);
  const mimeType = asString(attachment.mimeType);
  if (!id || !name || !mimeType) return null;

  let allowedExtensions: string[];
  try {
    allowedExtensions = imageExtensionsForMimeType(mimeType, "T3 Code");
  } catch {
    return null;
  }

  const originalExtension = extname(name);
  const normalizedExtension = originalExtension.toLowerCase();
  if (normalizedExtension && !allowedExtensions.includes(normalizedExtension)) return null;

  const extension = normalizedExtension || allowedExtensions[0];
  const diskExtensions = uniqueStrings([
    extension,
    originalExtension === extension ? "" : originalExtension,
    ...allowedExtensions,
  ]);

  const sizeBytes = typeof attachment.sizeBytes === "number" ? attachment.sizeBytes : undefined;
  return { id, name, mimeType, sizeBytes, extension, diskExtensions };
}

function warnAttachmentSkipped(
  eventSourceId: string,
  attachmentId: string,
  reason: string
): void {
  console.warn(
    `t3code: skipping image attachment for ${eventSourceId} (${attachmentId}): ${reason}`
  );
}

export async function storeT3CodeImageAttachment(options: {
  attachment: unknown;
  attachmentsDir: string;
  sourceAccount: string;
  threadId: string;
  messageId: string;
  eventSourceId: string;
}): Promise<StoredT3CodeImageAttachment | null> {
  const metadata = parseImageAttachmentMetadata(options.attachment);
  if (!metadata) return null;

  if (!isSafePathPart(metadata.id)) {
    warnAttachmentSkipped(options.eventSourceId, metadata.id, "attachment id is not a safe filename");
    return null;
  }

  const triedPaths: string[] = [];
  let content: Buffer | undefined;
  for (const extension of metadata.diskExtensions) {
    const diskPath = join(options.attachmentsDir, `${metadata.id}${extension}`);
    try {
      content = await readFile(diskPath);
      break;
    } catch (error) {
      triedPaths.push(`${diskPath}: ${errorMessage(error)}`);
    }
  }

  if (!content) {
    warnAttachmentSkipped(options.eventSourceId, metadata.id, `cannot read ${triedPaths.join("; ")}`);
    return null;
  }

  if (metadata.sizeBytes !== undefined && content.length !== metadata.sizeBytes) {
    warnAttachmentSkipped(
      options.eventSourceId,
      metadata.id,
      `size mismatch: metadata=${metadata.sizeBytes} actual=${content.length}`
    );
    return null;
  }

  const mediaFilename = `attachment-${metadata.id}${metadata.extension}`;
  let stored: StoreFileResult;
  try {
    stored = await storeFile({
      source: "t3code",
      relativePath: join(
        safePathPart(options.sourceAccount, "sourceAccount", "T3 Code"),
        safePathPart(options.threadId, "threadId", "T3 Code"),
        safePathPart(options.messageId, "messageId", "T3 Code"),
        mediaFilename
      ),
      content,
    });
  } catch (error) {
    warnAttachmentSkipped(options.eventSourceId, metadata.id, `cannot store media: ${errorMessage(error)}`);
    return null;
  }

  return {
    sourceId: metadata.id,
    filename: metadata.name,
    mimeType: metadata.mimeType,
    stored,
  };
}

async function storeT3CodeImageAttachments(options: {
  attachments: unknown[] | undefined;
  attachmentsDir: string;
  sourceAccount: string;
  threadId: string;
  messageId: string;
  eventSourceId: string;
}): Promise<StoredT3CodeImageAttachment[]> {
  if (!options.attachments) return [];

  const stored: StoredT3CodeImageAttachment[] = [];
  for (const attachment of options.attachments) {
    const result = await storeT3CodeImageAttachment({
      attachment,
      attachmentsDir: options.attachmentsDir,
      sourceAccount: options.sourceAccount,
      threadId: options.threadId,
      messageId: options.messageId,
      eventSourceId: options.eventSourceId,
    });
    if (result) stored.push(result);
  }
  return stored;
}

// Flatten Anthropic-style tool_result content (string or text-block array)
// into plain text for the `error` field.
function resultContentText(content: unknown): string | null {
  if (typeof content === "string") return asString(content);
  if (!Array.isArray(content)) return null;
  const parts = content.map((item) => {
    const obj = recordFromUnknown(item);
    if (obj && obj.type === "text" && typeof obj.text === "string") return obj.text;
    return typeof item === "string" ? item : JSON.stringify(item);
  });
  return asString(parts.join("\n"));
}

/**
 * Map one `tool.completed` activity payload to tool_use/tool_result blocks.
 *
 * Two payload shapes exist, by provider:
 * - claudeAgent: `data.{toolName, input, result}` with an Anthropic-style
 *   result ({tool_use_id, content, is_error}) — passes through directly.
 * - codex: `data.item` keyed by `itemType` — normalized to the closest
 *   Anthropic tool vocabulary (Bash / Write / Edit / WebSearch) so the web
 *   app's per-tool summaries and icons apply.
 */
export function activityToBlocks(payload: unknown, activityId: string): ContentBlock[] {
  const p = recordFromUnknown(payload);
  if (!p) return [];
  const data = recordFromUnknown(p.data);
  if (!data) return [];

  const toolName = asString(data.toolName);
  if (toolName) {
    const result = recordFromUnknown(data.result);
    const id = asString(result?.tool_use_id) ?? activityId;
    const blocks: ContentBlock[] = [
      { type: "tool_use", name: toolName, id, input: recordFromUnknown(data.input) ?? undefined },
    ];
    if (result) {
      blocks.push(
        result.is_error === true
          ? {
              type: "tool_result",
              tool_use_id: id,
              error: resultContentText(result.content) ?? "Tool call failed",
            }
          : { type: "tool_result", tool_use_id: id, content: result.content }
      );
    }
    return blocks;
  }

  const item = recordFromUnknown(data.item);
  if (!item) return [];
  const itemType = asString(p.itemType);
  switch (itemType) {
    case "command_execution": {
      const id = asString(item.id) ?? activityId;
      // `item.command` is the raw shell invocation ("/bin/zsh -lc '...'");
      // a single commandActions entry carries the unwrapped command.
      const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
      const actionCommand =
        actions.length === 1 ? asString(recordFromUnknown(actions[0])?.command) : null;
      const command = actionCommand ?? asString(item.command);
      if (!command) return [];
      const input: Record<string, unknown> = { command };
      const cwd = asString(item.cwd);
      if (cwd) input.cwd = cwd;
      const output = asString(item.aggregatedOutput);
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      const blocks: ContentBlock[] = [{ type: "tool_use", name: "Bash", id, input }];
      if (exitCode !== null && exitCode !== 0) {
        blocks.push({
          type: "tool_result",
          tool_use_id: id,
          error: output ?? `exit code ${exitCode}`,
        });
      } else if (output) {
        blocks.push({ type: "tool_result", tool_use_id: id, content: output });
      }
      return blocks;
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const itemId = asString(item.id) ?? activityId;
      const blocks: ContentBlock[] = [];
      changes.forEach((value, index) => {
        const change = recordFromUnknown(value);
        const path = asString(change?.path);
        if (!change || !path) return;
        const kind = asString(recordFromUnknown(change.kind)?.type);
        const name = kind === "add" ? "Write" : kind === "delete" ? "Delete" : "Edit";
        const id = changes.length > 1 ? `${itemId}:${index}` : itemId;
        blocks.push({ type: "tool_use", name, id, input: { file_path: path } });
        const diff = asString(change.diff);
        if (diff) {
          blocks.push({ type: "tool_result", tool_use_id: id, content: diff });
        }
      });
      return blocks;
    }
    case "web_search": {
      const query = asString(item.query) ?? asString(recordFromUnknown(item.action)?.query);
      return [
        {
          type: "tool_use",
          name: "WebSearch",
          id: asString(item.id) ?? activityId,
          input: query ? { query } : undefined,
        },
      ];
    }
    default:
      // Unrecognized item shape — keep it visible as a generic tool row; the
      // full payload stays in raw_data.activity for reprocessing.
      return [
        { type: "tool_use", name: itemType ?? "tool", id: activityId, input: item },
      ];
  }
}

export async function importT3Code(
  db: Database,
  t3DbPath: string,
  sourceAccount: string,
  options: AiImportOptions = {}
): Promise<ImportStats> {
  const importBatch = `t3code-${sourceAccount}-${Date.now()}`;
  const dryRun = options.dryRun ?? false;
  const refreshRawData = options.refreshRawData ?? false;
  const attachmentsDir = t3CodeAttachmentsDir(t3DbPath);

  const stats: ImportStats = {
    messages: 0,
    toolCalls: 0,
    refreshed: 0,
    skipped: 0,
    threads: new Set(),
    identitiesUpserted: 0,
  };

  // Collect identities for batch upsert
  const identityCollector = createIdentityCollector("t3code", sourceAccount);
  const userIdentifier = identityCollector.userIdentifier;

  // Open T3 Code state DB read-only
  const t3Db = new Database(t3DbPath, { readonly: true });

  const threadColumns = `
      t.title AS thread_title, t.branch, t.worktree_path,
      t.model_selection_json,
      t.archived_at IS NOT NULL AS thread_archived,
      t.deleted_at IS NOT NULL AS thread_deleted,
      p.title AS project_title, p.workspace_root,
      s.provider_name`;

  // Messages still streaming are incomplete snapshots - skip them; they'll
  // import on the next run once T3 marks them complete.
  const query = `
    SELECT
      m.message_id, m.thread_id, m.turn_id, m.role, m.text, m.created_at,
      m.attachments_json,${threadColumns}
    FROM projection_thread_messages m
    JOIN projection_threads t ON t.thread_id = m.thread_id
    LEFT JOIN projection_projects p ON p.project_id = t.project_id
    LEFT JOIN projection_thread_sessions s ON s.thread_id = m.thread_id
    WHERE m.is_streaming = 0
    ORDER BY m.created_at ASC
  `;

  // Only completed tool calls carry a final input+result; started/updated
  // rows are in-flight snapshots and import on a later run once completed.
  const activityQuery = `
    SELECT
      a.activity_id, a.thread_id, a.turn_id, a.payload_json, a.created_at,${threadColumns}
    FROM projection_thread_activities a
    JOIN projection_threads t ON t.thread_id = a.thread_id
    LEFT JOIN projection_projects p ON p.project_id = t.project_id
    LEFT JOIN projection_thread_sessions s ON s.thread_id = a.thread_id
    WHERE a.kind = 'tool.completed'
    ORDER BY a.created_at ASC
  `;

  const messages = t3Db.prepare(query).all() as T3CodeMessage[];
  const activities = t3Db.prepare(activityQuery).all() as T3CodeActivity[];
  console.log(
    `Found ${messages.length.toLocaleString()} messages and ${activities.length.toLocaleString()} completed tool calls in T3 Code DB`
  );

  if (dryRun) {
    const threads = new Set(messages.map((m) => m.thread_id));
    console.log(`Threads: ${threads.size}`);
    console.log("\nSample messages:");
    for (const msg of messages.slice(0, 5)) {
      const preview = msg.text.slice(0, 100).replace(/\n/g, " ");
      console.log(
        `  [${msg.role}] ${msg.project_title || "?"}: ${msg.thread_title || "?"}: ${preview}...`
      );
    }
    t3Db.close();
    return stats;
  }

  const eventWriter = createEventWriter(db, {
    source: "t3code",
    sourceAccount,
    importBatch,
    refreshRawData,
  });

  // Per-thread context shared by message and activity rows. The model is
  // thread-level state, so it reflects the thread's last selection, not
  // necessarily the model that produced a specific message. Registers the
  // assistant identity as a side effect.
  const threadContext = (row: T3ThreadRow) => {
    const modelSelection = parseModelSelection(row.model_selection_json);
    const modelId = modelSelection.model || null;
    const provider = row.provider_name || modelSelection.instanceId || null;

    const title =
      [row.project_title, row.thread_title].filter(Boolean).join(": ") ||
      "T3 Code Chat";

    const tags = [
      "editor:t3code",
      row.project_title && `project:${row.project_title}`,
      modelId && `model:${modelId}`,
      provider && `provider:${provider}`,
      row.branch && `branch:${row.branch}`,
    ].filter((t): t is string => Boolean(t));

    const assistantIdentifier = identityCollector.registerAssistant(modelId);

    const threadRaw = {
      thread_id: row.thread_id,
      turn_id: row.turn_id,
      provider,
      model: modelId,
      model_options: modelSelection.options,
      thread_title: row.thread_title,
      thread_archived: Boolean(row.thread_archived),
      thread_deleted: Boolean(row.thread_deleted),
      branch: row.branch,
      worktree_path: row.worktree_path,
      project_title: row.project_title,
      workspace_root: row.workspace_root,
    };

    return { title, tags, assistantIdentifier, threadRaw };
  };

  db.run("BEGIN TRANSACTION");

  try {
    for (const msg of messages) {
      const attachments = parseAttachments(msg.attachments_json);

      // Skip rows with nothing to show
      if (msg.text.trim() === "" && !attachments) {
        stats.skipped++;
        continue;
      }

      stats.threads.add(msg.thread_id);

      const ctx = threadContext(msg);
      const eventType =
        msg.role === "user" ? "t3code:message:user" : "t3code:message:assistant";
      const people =
        msg.role === "user"
          ? [userIdentifier]
          : [ctx.assistantIdentifier, userIdentifier];

      const rawData = JSON.stringify({
        ...ctx.threadRaw,
        message_id: msg.message_id,
        attachments,
      });

      const sourceId = `${msg.thread_id}:${msg.message_id}`;
      const { outcome, eventId } = eventWriter.write({
        sourceId,
        eventType,
        timestamp: msg.created_at,
        title: ctx.title,
        content: msg.text,
        people,
        tags: ctx.tags,
        rawData,
        conversationId: msg.thread_id,
      });
      if (outcome === "inserted") stats.messages++;
      else if (outcome === "refreshed") stats.refreshed++;
      else stats.skipped++;

      if (eventId !== null && outcome !== "skipped") {
        const storedAttachments = await storeT3CodeImageAttachments({
          attachments,
          attachmentsDir,
          sourceAccount,
          threadId: msg.thread_id,
          messageId: msg.message_id,
          eventSourceId: sourceId,
        });
        for (const attachment of storedAttachments) {
          insertStoredAttachment(db, {
            eventId,
            source: "t3code",
            sourceId: attachment.sourceId,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
          }, attachment.stored);
        }
      }
    }

    for (const activity of activities) {
      let payload: unknown;
      try {
        payload = JSON.parse(activity.payload_json);
      } catch {
        payload = null;
      }

      const blocks = activityToBlocks(payload, activity.activity_id);
      if (blocks.length === 0) {
        stats.skipped++;
        continue;
      }

      stats.threads.add(activity.thread_id);

      const ctx = threadContext(activity);
      const rawData = JSON.stringify({
        ...ctx.threadRaw,
        activity_id: activity.activity_id,
        content: blocks,
        // Original payload, preserved for reprocessing (blocks are derived).
        activity: payload,
      });

      // Tool calls are assistant actions; content stays empty so tool noise
      // never reaches FTS (matching the other AI parsers).
      const { outcome } = eventWriter.write({
        sourceId: `${activity.thread_id}:${activity.activity_id}`,
        eventType: "t3code:message:assistant",
        timestamp: activity.created_at,
        title: ctx.title,
        content: "",
        people: [ctx.assistantIdentifier, userIdentifier],
        tags: ctx.tags,
        rawData,
        conversationId: activity.thread_id,
      });
      if (outcome === "inserted") stats.toolCalls++;
      else if (outcome === "refreshed") stats.refreshed++;
      else stats.skipped++;
    }

    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    t3Db.close();
    throw error;
  }

  t3Db.close();

  // Upsert all collected identities (only on actual import)
  stats.identitiesUpserted = identityCollector.upsertAll(db);

  // Print summary
  console.log(`\n${"=".repeat(50)}`);
  console.log("Import complete:");
  console.log(`  Threads: ${stats.threads.size}`);
  console.log(`  Messages: ${stats.messages.toLocaleString()}`);
  console.log(`  Tool calls: ${stats.toolCalls.toLocaleString()}`);
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

  const dryRun = args.includes("--dry-run");
  const refreshRawData = args.includes("--refresh-raw-data");
  const positionalArgs = args.filter((a) => !a.startsWith("--"));

  const accountName = positionalArgs[0] || "default";
  const t3DbPath = positionalArgs[1]
    ? positionalArgs[1].startsWith("~")
      ? positionalArgs[1].replace("~", process.env.HOME || "")
      : positionalArgs[1]
    : DEFAULT_T3CODE_DB;

  if (!existsSync(t3DbPath)) {
    console.error(`T3 Code database not found at: ${t3DbPath}`);
    process.exit(1);
  }

  console.log(`Importing T3 Code threads from ${t3DbPath}`);
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

  const stats = await importT3Code(
    db as ReturnType<typeof getDb>,
    t3DbPath,
    accountName,
    { dryRun, refreshRawData }
  );

  if (db) {
    db.close();
  }

  process.exit(stats.messages > 0 || stats.toolCalls > 0 || dryRun ? 0 : 1);
}
