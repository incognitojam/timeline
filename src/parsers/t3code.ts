#!/usr/bin/env bun
/**
 * T3 Code Chat Parser
 *
 * Imports chat threads from a T3 Code (desktop coding agent app) SQLite
 * state database. T3 Code drives external agent providers (claudeAgent,
 * codex, opencode, ...). Two stores exist, detected by schema:
 *
 * - v2 `statev2.sqlite` (current T3 Code and its styal fork, e.g.
 *   ~/.styal/userdata/statev2.sqlite) — read by ./t3code-v2.ts
 * - v1 `state.sqlite` (older T3 Code, ~/.t3/userdata/state.sqlite) —
 *   messages are plain text in projection tables, and tool calls are
 *   completed projection_thread_activities rows
 *
 * Tool calls import as assistant events whose raw_data.content carries
 * tool_use/tool_result blocks (payload shape differs per provider; all are
 * normalized to the shared ContentBlock vocabulary).
 *
 * The account distinguishes hosts: import each machine's database with its
 * own account.
 *
 * Usage:
 *   bun run src/parsers/t3code.ts <account> [db-path] [--dry-run] [--refresh-raw-data]
 *   bun run src/parsers/t3code.ts alice ~/.styal/userdata/statev2.sqlite --dry-run
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, extname, join } from "path";
import { extractConversationId } from "../db/conversation-id";
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
import {
  asString,
  type PlannedT3Event,
  type PlannedT3EventKind,
  t3EventTags,
  t3EventTitle,
} from "./t3code-events";
import { readT3CodeV2Events, T3_V2_REQUIRED_COLUMNS, type T3V2ReadStats } from "./t3code-v2";

export const DEFAULT_T3CODE_DB = `${process.env.HOME}/.t3/userdata/state.sqlite`;

/** Tables and columns the v1 reader queries; checked before any read. */
const T3_V1_REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  projection_threads: [
    "thread_id", "project_id", "title", "branch", "worktree_path",
    "model_selection_json", "archived_at", "deleted_at",
  ],
  projection_projects: ["project_id", "title", "workspace_root"],
  projection_thread_sessions: ["thread_id", "provider_name"],
  projection_thread_messages: [
    "message_id", "thread_id", "turn_id", "role", "text", "is_streaming", "created_at", "attachments_json",
  ],
  projection_thread_activities: ["activity_id", "thread_id", "turn_id", "kind", "payload_json", "created_at"],
};

export type T3Store = "v1" | "v2";

/**
 * Identify the store by its tables and verify every column the matching
 * reader queries. An unrecognised or drifted schema fails the import
 * instead of importing part of it.
 */
export function detectT3Store(t3Db: Database, t3DbPath: string): T3Store {
  const tables = new Set(
    (t3Db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((row) => row.name)
  );
  const store: T3Store | null = tables.has("orchestration_v2_projection_threads")
    ? "v2"
    : tables.has("projection_threads")
      ? "v1"
      : null;
  if (!store) {
    throw new Error(
      `Unrecognised T3 Code database at ${t3DbPath}: expected orchestration_v2_projection_threads (statev2.sqlite) or projection_threads (state.sqlite)`
    );
  }

  const required = store === "v2" ? T3_V2_REQUIRED_COLUMNS : T3_V1_REQUIRED_COLUMNS;
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(required)) {
    const present = new Set(
      (t3Db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[])
        .map((row) => row.name)
    );
    for (const column of columns) {
      if (!present.has(column)) missing.push(`${table}.${column}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Unsupported T3 Code ${store} schema at ${t3DbPath}: missing ${missing.join(", ")}`
    );
  }
  return store;
}

// Thread/project/session columns shared by the v1 message and activity queries.
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
  store: T3Store;
  /** Events inserted — or, on a dry run, planned — by kind. */
  messages: number;
  toolCalls: number;
  plans: number;
  reasoning: number;
  refreshed: number;
  skipped: number;
  threads: Set<string>;
  identitiesUpserted: number;
  /** v2 only: pass back as `cursor` to read only later changes. */
  cursor: string | null;
  /** v2 only: migrated v1 threads not yet readable from the v2 tables. */
  pendingTranscriptThreads: number;
  /** v2 only: source rows not planned as events, by reason. */
  skippedByReason: Record<string, number>;
}

export interface T3ImportOptions extends AiImportOptions {
  /** v2 only: `cursor` from a previous run's stats. */
  cursor?: string | null;
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


/**
 * Plan events from a v1 store. The model is thread-level state there, so it
 * reflects the thread's last selection, not necessarily the model that
 * produced a specific message.
 */
function* readT3CodeV1Events(t3Db: Database, stats: ImportStats): Generator<PlannedT3Event> {
  const threadColumns = `
      t.title AS thread_title, t.branch, t.worktree_path,
      t.model_selection_json,
      t.archived_at IS NOT NULL AS thread_archived,
      t.deleted_at IS NOT NULL AS thread_deleted,
      p.title AS project_title, p.workspace_root,
      s.provider_name`;

  // Messages still streaming are incomplete snapshots - skip them; they'll
  // import on the next run once T3 marks them complete.
  const messages = t3Db.prepare(`
    SELECT
      m.message_id, m.thread_id, m.turn_id, m.role, m.text, m.created_at,
      m.attachments_json,${threadColumns}
    FROM projection_thread_messages m
    JOIN projection_threads t ON t.thread_id = m.thread_id
    LEFT JOIN projection_projects p ON p.project_id = t.project_id
    LEFT JOIN projection_thread_sessions s ON s.thread_id = m.thread_id
    WHERE m.is_streaming = 0
    ORDER BY m.created_at ASC
  `).all() as T3CodeMessage[];

  // Only completed tool calls carry a final input+result; started/updated
  // rows are in-flight snapshots and import on a later run once completed.
  const activities = t3Db.prepare(`
    SELECT
      a.activity_id, a.thread_id, a.turn_id, a.payload_json, a.created_at,${threadColumns}
    FROM projection_thread_activities a
    JOIN projection_threads t ON t.thread_id = a.thread_id
    LEFT JOIN projection_projects p ON p.project_id = t.project_id
    LEFT JOIN projection_thread_sessions s ON s.thread_id = a.thread_id
    WHERE a.kind = 'tool.completed'
    ORDER BY a.created_at ASC
  `).all() as T3CodeActivity[];

  const threadContext = (row: T3ThreadRow) => {
    const modelSelection = parseModelSelection(row.model_selection_json);
    const model = modelSelection.model || null;
    const provider = row.provider_name || modelSelection.instanceId || null;
    return {
      title: t3EventTitle(row.project_title, row.thread_title),
      model,
      tags: t3EventTags({ projectTitle: row.project_title, model, provider, branch: row.branch }),
      raw: {
        thread_id: row.thread_id,
        turn_id: row.turn_id,
        provider,
        model,
        model_options: modelSelection.options,
        thread_title: row.thread_title,
        thread_archived: Boolean(row.thread_archived),
        thread_deleted: Boolean(row.thread_deleted),
        branch: row.branch,
        worktree_path: row.worktree_path,
        project_title: row.project_title,
        workspace_root: row.workspace_root,
      },
    };
  };

  for (const msg of messages) {
    const attachments = parseAttachments(msg.attachments_json);
    // Skip rows with nothing to show
    if (msg.text.trim() === "" && !attachments) {
      stats.skipped++;
      continue;
    }
    const ctx = threadContext(msg);
    yield {
      kind: "message",
      sourceId: `${msg.thread_id}:${msg.message_id}`,
      role: msg.role,
      timestamp: msg.created_at,
      title: ctx.title,
      content: msg.text,
      model: ctx.model,
      tags: ctx.tags,
      raw: { ...ctx.raw, message_id: msg.message_id, attachments },
      attachments: attachments && { messageId: msg.message_id, items: attachments },
    };
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
    const ctx = threadContext(activity);
    // Tool calls are assistant actions; content stays empty so tool noise
    // never reaches FTS (matching the other AI parsers).
    yield {
      kind: "tool_call",
      sourceId: `${activity.thread_id}:${activity.activity_id}`,
      role: "assistant",
      timestamp: activity.created_at,
      title: ctx.title,
      content: "",
      model: ctx.model,
      tags: ctx.tags,
      raw: {
        ...ctx.raw,
        activity_id: activity.activity_id,
        content: blocks,
        // Original payload, preserved for reprocessing (blocks are derived).
        activity: payload,
      },
    };
  }
}

const STAT_BY_KIND: Record<PlannedT3EventKind, "messages" | "toolCalls" | "plans" | "reasoning"> = {
  message: "messages",
  tool_call: "toolCalls",
  plan: "plans",
  reasoning: "reasoning",
};

export async function importT3Code(
  db: Database | null,
  t3DbPath: string,
  sourceAccount: string,
  options: T3ImportOptions = {}
): Promise<ImportStats> {
  const importBatch = `t3code-${sourceAccount}-${Date.now()}`;
  const dryRun = options.dryRun ?? false;
  const refreshRawData = options.refreshRawData ?? false;
  const attachmentsDir = t3CodeAttachmentsDir(t3DbPath);

  // Read-only, so the live T3 Code process keeps writing; one read
  // transaction gives every query the same WAL snapshot.
  const t3Db = new Database(t3DbPath, { readonly: true });
  t3Db.run("PRAGMA busy_timeout = 5000");

  try {
    const store = detectT3Store(t3Db, t3DbPath);
    const stats: ImportStats = {
      store,
      messages: 0,
      toolCalls: 0,
      plans: 0,
      reasoning: 0,
      refreshed: 0,
      skipped: 0,
      threads: new Set(),
      identitiesUpserted: 0,
      cursor: null,
      pendingTranscriptThreads: 0,
      skippedByReason: {},
    };
    const v2Stats: T3V2ReadStats = { cursor: null, pendingTranscriptThreads: 0, skipped: {} };

    if (!dryRun && !db) throw new Error("importT3Code needs a Timeline database unless dryRun is set");
    const identityCollector = createIdentityCollector("t3code", sourceAccount);
    const userIdentifier = identityCollector.userIdentifier;
    const eventWriter = db && !dryRun
      ? createEventWriter(db, {
          source: "t3code",
          sourceAccount,
          importBatch,
          refreshRawData,
          // v2 rows are re-read when they change (edited prompts, reopened
          // subagents, renamed or archived threads), so rewrite what differs.
          updateChanged: store === "v2",
        })
      : null;

    t3Db.run("BEGIN");
    if (db && eventWriter) db.run("BEGIN TRANSACTION");
    try {
      const events =
        store === "v2"
          ? readT3CodeV2Events(t3Db, { cursor: options.cursor ?? null }, v2Stats)
          : readT3CodeV1Events(t3Db, stats);

      for (const event of events) {
        stats.threads.add(event.raw.thread_id);
        if (!eventWriter) {
          stats[STAT_BY_KIND[event.kind]]++;
          continue;
        }

        const people =
          event.role === "user"
            ? [userIdentifier]
            : [identityCollector.registerAssistant(event.model), userIdentifier];
        const conversationId = extractConversationId("t3code", event.raw);
        if (!conversationId) throw new Error(`T3 Code event ${event.sourceId} has no thread_id`);

        const { outcome, eventId } = eventWriter.write({
          sourceId: event.sourceId,
          eventType: `t3code:message:${event.role}`,
          timestamp: event.timestamp,
          title: event.title,
          content: event.content,
          people,
          tags: event.tags,
          rawData: JSON.stringify(event.raw),
          conversationId,
        });
        if (outcome === "inserted") stats[STAT_BY_KIND[event.kind]]++;
        else if (outcome === "refreshed") stats.refreshed++;
        else stats.skipped++;

        if (db && event.attachments && eventId !== null && outcome !== "skipped") {
          const storedAttachments = await storeT3CodeImageAttachments({
            attachments: event.attachments.items,
            attachmentsDir,
            sourceAccount,
            threadId: event.raw.thread_id,
            messageId: event.attachments.messageId,
            eventSourceId: event.sourceId,
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
      if (db && eventWriter) db.run("COMMIT");
    } catch (error) {
      if (db?.inTransaction) db.run("ROLLBACK");
      throw error;
    } finally {
      t3Db.run("COMMIT");
    }

    stats.cursor = v2Stats.cursor;
    stats.pendingTranscriptThreads = v2Stats.pendingTranscriptThreads;
    stats.skippedByReason = v2Stats.skipped;
    stats.skipped += Object.values(v2Stats.skipped).reduce((sum, n) => sum + n, 0);

    if (db && eventWriter) {
      stats.identitiesUpserted = identityCollector.upsertAll(db);
    }

    printSummary(stats, { dryRun, refreshRawData, importBatch });
    if (db && eventWriter) onImportComplete(db);
    return stats;
  } finally {
    t3Db.close();
  }
}

function printSummary(
  stats: ImportStats,
  run: { dryRun: boolean; refreshRawData: boolean; importBatch: string }
): void {
  console.log(`\n${"=".repeat(50)}`);
  console.log(run.dryRun ? `Dry run (${stats.store} store), events planned:` : `Import complete (${stats.store} store):`);
  console.log(`  Threads: ${stats.threads.size}`);
  console.log(`  Messages: ${stats.messages.toLocaleString()}`);
  console.log(`  Tool calls: ${stats.toolCalls.toLocaleString()}`);
  if (stats.store === "v2") {
    console.log(`  Proposed plans: ${stats.plans.toLocaleString()}`);
    console.log(`  Reasoning: ${stats.reasoning.toLocaleString()}`);
  }
  if (run.refreshRawData) {
    console.log(`  Refreshed: ${stats.refreshed.toLocaleString()}`);
  }
  if (!run.dryRun) console.log(`  Identities: ${stats.identitiesUpserted}`);
  console.log(`  Skipped: ${stats.skipped.toLocaleString()}`);
  for (const [reason, count] of Object.entries(stats.skippedByReason).sort()) {
    console.log(`    ${reason}: ${count.toLocaleString()}`);
  }
  if (stats.pendingTranscriptThreads > 0) {
    console.warn(
      `  Pending: ${stats.pendingTranscriptThreads} migrated v1 thread(s) await T3 Code's transcript import and were skipped`
    );
  }
  if (stats.cursor) console.log(`  Cursor: ${stats.cursor}`);
  if (!run.dryRun) console.log(`  Batch ID: ${run.importBatch}`);
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);

  const dryRun = args.includes("--dry-run");
  const refreshRawData = args.includes("--refresh-raw-data");
  const positionalArgs = args.filter((a) => !a.startsWith("--"));

  const accountName = positionalArgs[0];
  if (!accountName) {
    console.error("Usage: bun run src/parsers/t3code.ts <account> [db-path] [--dry-run] [--refresh-raw-data]");
    process.exit(1);
  }
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

  const stats = await importT3Code(db, t3DbPath, accountName, { dryRun, refreshRawData });

  if (db) {
    db.close();
  }

  const planned = stats.messages + stats.toolCalls + stats.plans + stats.reasoning;
  process.exit(planned > 0 || dryRun ? 0 : 1);
}
