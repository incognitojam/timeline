import { Database } from "bun:sqlite";
import { readdir } from "fs/promises";
import { basename, join } from "path";
import { fileURLToPath } from "url";
import { extractConversationId } from "../db/conversation-id";
import {
  formatIdentifier,
  onImportComplete,
  type UpsertIdentityOptions,
  upsertIdentities,
} from "../db/queries";
import { getDb, initDb } from "../db/schema";
import {
  type ContentBlock,
  extractText,
} from "./shared/format-content";

const DEFAULT_AMP_DIR = `${process.env.HOME}/.local/share/amp/threads`;

export interface AmpMessage {
  role: "user" | "assistant";
  messageId?: number;
  content: AmpContentBlock[];
  userState?: {
    currentlyVisibleFiles?: string[];
    runningTerminalCommands?: string[];
  };
  agentMode?: string;
  meta?: {
    sentAt?: unknown;
  };
  state?: {
    type: string;
    stopReason?: string;
  };
  usage?: {
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    totalInputTokens?: number;
    credits?: number;
    timestamp?: unknown;
  };
  originalToolUseInput?: Record<string, unknown>;
  fileMentions?: Record<string, unknown>;
  threadMentions?: unknown[];
  turnElapsedMs?: number;
  interrupted?: boolean;
}

interface AmpWorkspaceTree {
  displayName?: string;
  fsPath?: string;
  uri?: string;
}

export interface AmpEnv {
  initial?: {
    trees?: AmpWorkspaceTree[];
  };
  systemPromptData?: {
    workingDirectory?: string;
  };
}

interface ResolvedAmpProject {
  name: string;
  source:
    | "workspace_roots"
    | "env.initial.trees[0].displayName"
    | "env.initial.trees[0].fsPath"
    | "env.initial.trees[0].uri"
    | "env.systemPromptData.workingDirectory";
  path?: string;
}

/**
 * Amp's on-disk block shape. Tool results live under `run` rather than
 * `content`/`error` on the block itself, and tool_use blocks use `toolUseID`
 * (camelCase) rather than the Anthropic-style `tool_use_id`. Inline images use
 * a camelCase `source.mediaType`; compaction summaries carry a nested `summary`
 * object whose `type` is "message" (a summary text) or "thread" (a referenced
 * thread id).
 */
export interface AmpContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "image" | "summary";
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  toolUseID?: string;
  run?: {
    status: string;
    result?: unknown;
    error?: { message: string };
  };
  source?: {
    type?: string;
    data?: string;
    mediaType?: string;
  };
  summary?: {
    type?: string;
    summary?: string;
    thread?: string;
  };
}

/**
 * Normalize Amp's native block shape into the shared ContentBlock form used
 * across parsers. Tool results are flattened out of `block.run` into
 * `{ content, error, tool_use_id }` on the block itself. Inline images keep
 * their `media_type` (the base64 bytes stay in `raw_data.source_content`), and
 * compaction summaries surface their text or referenced thread id.
 */
export function normalizeAmpBlocks(blocks: AmpContentBlock[]): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type === "image") {
      return {
        type: "image",
        media_type: nonEmptyString(block.source?.mediaType),
      };
    }
    if (block.type === "summary") {
      const summary = block.summary;
      return {
        type: "summary",
        summary_type: nonEmptyString(summary?.type),
        text: nonEmptyString(summary?.summary),
        thread_id: nonEmptyString(summary?.thread),
      };
    }
    if (block.type === "tool_result") {
      const run = block.run;
      const toolUseId = block.toolUseID;
      if (run?.status === "error" && run.error?.message) {
        return {
          type: "tool_result",
          tool_use_id: toolUseId,
          error: run.error.message,
        };
      }
      const result = run?.result;
      const content =
        typeof result === "string" ? result : result === undefined ? undefined : JSON.stringify(result);
      return {
        type: "tool_result",
        tool_use_id: toolUseId,
        content,
      };
    }
    if (block.type === "tool_use") {
      return {
        type: "tool_use",
        name: block.name,
        id: block.id,
        input: block.input,
      };
    }
    if (block.type === "thinking") {
      return { type: "thinking", thinking: block.thinking };
    }
    return { type: "text", text: block.text };
  });
}

export interface AmpThread {
  v: number;
  id: string;
  created: number;
  messages: AmpMessage[];
  title?: string;
  updatedAt?: number;
  workspaceRoots?: string[];
  env?: AmpEnv;
  nextMessageId?: number;
  agentMode?: string;
  reasoningEffort?: string;
  activatedSkills?: unknown[];
  usageLedger?: Record<string, unknown>;
  relationships?: unknown[];
  originThreadID?: string;
  forkPointIndex?: number;
  forkThreads?: Record<string, unknown>;
  mainThreadID?: string;
  archived?: boolean;
  meta?: Record<string, unknown>;
  summaryThreads?: unknown[];
}

export interface ImportStats {
  threads: number;
  messages: number;
  refreshed: number;
  skipped: number;
  identitiesUpserted: number;
}

export interface ImportAmpOptions {
  refreshRawData?: boolean;
  updateExisting?: boolean;
}

async function* readAmpThreadFiles(
  ampDir: string,
  threadFiles: string[]
): AsyncGenerator<AmpThread> {
  for (const file of threadFiles) {
    const threadId = basename(file, ".json");
    const filePath = join(ampDir, file);

    try {
      const content = await Bun.file(filePath).text();
      const thread = JSON.parse(content) as AmpThread;
      if (!thread.id) {
        thread.id = threadId;
      }
      yield thread;
    } catch {
      console.warn(`Failed to parse ${file}, skipping`);
    }
  }
}

/**
 * Format model ID into a human-readable name.
 * Examples:
 *   claude-opus-4-5-20251101 -> Claude Opus 4.5
 *   claude-sonnet-4-20250514 -> Claude Sonnet 4
 */
function formatModelDisplayName(modelId: string | undefined): string {
  if (!modelId) return "Amp";

  // Strip date suffix (e.g., -20251101)
  let cleaned = modelId.replace(/-\d{8}$/, "");

  // Convert version patterns (e.g., 4-5 -> 4.5)
  cleaned = cleaned.replace(/(\d+)-(\d+)(?=-|$)/g, "$1.$2");

  // Format as title case
  return cleaned
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Convert an epoch-millis number (Amp's `meta.sentAt`) into an ISO timestamp,
 * or undefined when missing or not a valid date. Guards against null (a JSON
 * boundary value) and non-finite numbers, which `new Date()` would otherwise
 * coerce into epoch 0 / an invalid date.
 */
function isoFromEpochMillis(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Normalize an ISO timestamp string (Amp's assistant `usage.timestamp`) into a
 * canonical ISO timestamp, or undefined when missing or unparseable.
 */
function isoFromTimestampString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = nonEmptyString(value);
  if (!trimmed) return undefined;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function pathFromUri(value: string): string {
  if (!value.startsWith("file://")) {
    return value;
  }

  try {
    return fileURLToPath(value);
  } catch {
    return value;
  }
}

function projectNameFromPath(value: string | undefined): string | undefined {
  const path = nonEmptyString(value);
  if (!path) return undefined;

  return nonEmptyString(basename(pathFromUri(path)));
}

function firstTree(thread: AmpThread): AmpWorkspaceTree | undefined {
  return thread.env?.initial?.trees?.[0];
}

function resolveAmpProject(thread: AmpThread): ResolvedAmpProject | undefined {
  const workspaceRoot = nonEmptyString(thread.workspaceRoots?.[0]);
  const workspaceProject = projectNameFromPath(workspaceRoot);
  if (workspaceProject) {
    return {
      name: workspaceProject,
      source: "workspace_roots",
      path: workspaceRoot,
    };
  }

  const tree = firstTree(thread);
  const displayName = nonEmptyString(tree?.displayName);
  if (displayName) {
    return {
      name: displayName,
      source: "env.initial.trees[0].displayName",
      path: nonEmptyString(tree?.fsPath),
    };
  }

  const fsPath = nonEmptyString(tree?.fsPath);
  const fsPathProject = projectNameFromPath(fsPath);
  if (fsPathProject) {
    return {
      name: fsPathProject,
      source: "env.initial.trees[0].fsPath",
      path: fsPath,
    };
  }

  const uri = nonEmptyString(tree?.uri);
  const uriProject = projectNameFromPath(uri);
  if (uri && uriProject) {
    return {
      name: uriProject,
      source: "env.initial.trees[0].uri",
      path: pathFromUri(uri),
    };
  }

  const workingDirectory = nonEmptyString(
    thread.env?.systemPromptData?.workingDirectory
  );
  const workingDirectoryProject = projectNameFromPath(workingDirectory);
  if (workingDirectoryProject) {
    return {
      name: workingDirectoryProject,
      source: "env.systemPromptData.workingDirectory",
      path: workingDirectory,
    };
  }

  return undefined;
}

function workspaceRawData(
  thread: AmpThread,
  project: ResolvedAmpProject | undefined
) {
  const tree = firstTree(thread);
  const workingDirectory = nonEmptyString(
    thread.env?.systemPromptData?.workingDirectory
  );

  if (!project && !tree && !workingDirectory) {
    return undefined;
  }

  return {
    project_name: project?.name,
    project_source: project?.source,
    project_path: project?.path,
    display_name: nonEmptyString(tree?.displayName),
    fs_path: nonEmptyString(tree?.fsPath),
    uri: nonEmptyString(tree?.uri),
    working_directory: workingDirectory,
  };
}

function rawMetadataWithout(
  value: object,
  omittedKeys: ReadonlySet<string>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !omittedKeys.has(key))
  ) as Record<string, unknown>;
}

const THREAD_METADATA_OMITTED_KEYS = new Set(["messages", "~debug"]);
const MESSAGE_METADATA_OMITTED_KEYS = new Set(["content"]);

export async function importAmp(
  db: Database,
  ampDir: string,
  sourceAccount: string,
  options: ImportAmpOptions = {}
) {
  // Find all thread JSON files
  let threadFiles: string[];
  try {
    threadFiles = (await readdir(ampDir)).filter((f) => f.endsWith(".json"));
  } catch (error) {
    console.error(`Failed to read Amp directory: ${ampDir}`);
    throw error;
  }

  console.log(`Found ${threadFiles.length} thread files`);

  return importAmpThreads(
    db,
    readAmpThreadFiles(ampDir, threadFiles),
    sourceAccount,
    options
  );
}

export async function importAmpThreads(
  db: Database,
  threads: Iterable<AmpThread> | AsyncIterable<AmpThread>,
  sourceAccount: string,
  options: ImportAmpOptions = {}
) {
  const importBatch = `amp-${sourceAccount}-${Date.now()}`;
  const refreshRawData = options.refreshRawData ?? false;
  const updateExistingRows = options.updateExisting ?? false;

  const stats: ImportStats = {
    threads: 0,
    messages: 0,
    refreshed: 0,
    skipped: 0,
    identitiesUpserted: 0,
  };

  // Collect identities for batch upsert
  const identities = new Map<string, UpsertIdentityOptions>();

  // User identity (always present)
  const userIdentifier = formatIdentifier("amp", sourceAccount);
  identities.set(userIdentifier, {
    platform: "amp",
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

  const updateRefresh = db.prepare(`
    UPDATE events SET content = ?, raw_data = ?
    WHERE source = ? AND source_id = ? AND source_account = ?
  `);

  const updateExisting = db.prepare(`
    UPDATE events SET
      type = ?,
      timestamp = ?,
      title = ?,
      content = ?,
      people = ?,
      tags = ?,
      raw_data = ?,
      conversation_id = ?
    WHERE source = ? AND source_id = ? AND source_account = ?
  `);

  // Wrap entire import in a transaction for massive speedup
  db.run("BEGIN TRANSACTION");

  try {
    for await (const thread of threads) {
      const threadId = thread.id;

      if (!thread.messages || thread.messages.length === 0) {
        continue;
      }

      const project = resolveAmpProject(thread);
      const projectName = project?.name;
      const threadTitle = thread.title || projectName || threadId;
      const workspace = workspaceRawData(thread, project);
      const threadMetadata = rawMetadataWithout(
        thread,
        THREAD_METADATA_OMITTED_KEYS
      );

      for (const [messageIndex, msg] of thread.messages.entries()) {
        // Skip messages without content
        if (!msg.content || msg.content.length === 0) {
          stats.skipped++;
          continue;
        }

        // Determine timestamp by precedence:
        //   1. meta.sentAt (epoch millis) when present and valid
        //   2. assistant usage.timestamp (ISO string) when present and valid
        //   3. fallback estimate from thread.created + message order
        // usageLedger.events[] is intentionally not used: its events map to
        // message ranges (fromMessageId..toMessageId) and auxiliary operations
        // (title-generation, oracle, etc.), so they cannot be attributed to a
        // single message deterministically.
        const sentAt = isoFromEpochMillis(msg.meta?.sentAt);
        const usageTimestamp =
          msg.role === "assistant"
            ? isoFromTimestampString(msg.usage?.timestamp)
            : undefined;
        let timestamp: string;
        if (sentAt) {
          timestamp = sentAt;
        } else if (usageTimestamp) {
          timestamp = usageTimestamp;
        } else {
          const messageOffset = msg.messageId ?? messageIndex;
          timestamp = new Date(
            thread.created + messageOffset * 1000
          ).toISOString();
        }

        const eventType =
          msg.role === "user" ? "amp:message:user" : "amp:message:assistant";

        const blocks = normalizeAmpBlocks(msg.content);
        const contentText = extractText(blocks);

        // Skip rows with no blocks. Pure tool-use assistant messages are kept:
        // contentText may be empty but raw_data.content preserves the blocks.
        if (blocks.length === 0) {
          stats.skipped++;
          continue;
        }

        // Build tags
        const tags: string[] = ["editor:amp"];
        if (projectName) {
          tags.push(`project:${projectName}`);
        }
        const model = msg.usage?.model;
        if (model) {
          tags.push(`model:${model}`);
        }
        if (msg.agentMode) {
          tags.push(`mode:${msg.agentMode}`);
        }

        // Build qualified identifiers for people
        let people: string[];
        if (msg.role === "user") {
          people = [userIdentifier];
        } else {
          // Assistant message - use model as identifier, fallback to "assistant"
          const assistantPlatformId = model || "assistant";
          const assistantIdentifier = formatIdentifier("amp", assistantPlatformId);
          people = [assistantIdentifier, userIdentifier];

          // Add assistant identity if not already tracked
          if (!identities.has(assistantIdentifier)) {
            identities.set(assistantIdentifier, {
              platform: "amp",
              platformId: assistantPlatformId,
              displayName: formatModelDisplayName(model),
              username: assistantPlatformId,
            });
          }
        }

        const sourceId =
          msg.messageId !== undefined
            ? `${threadId}:${msg.messageId}`
            : `${threadId}:idx:${messageIndex}`;
        const peopleJson = JSON.stringify(people);
        const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null;
        const rawDataFields = {
          thread_id: threadId,
          message_id: msg.messageId,
          message_index: messageIndex,
          workspace_roots: thread.workspaceRoots,
          workspace,
          thread_metadata: threadMetadata,
          message_metadata: rawMetadataWithout(msg, MESSAGE_METADATA_OMITTED_KEYS),
          model: model,
          agent_mode: msg.agentMode,
          usage: msg.usage,
          content: blocks,
          source_content: msg.content,
        };
        const rawData = JSON.stringify(rawDataFields);
        // Derived from the same object persisted to raw_data, so this
        // matches what extractConversationId reads back off the row.
        const conversationId = extractConversationId("amp", rawDataFields);

        const result = insert.run(
          "amp",
          sourceId,
          sourceAccount,
          eventType,
          timestamp,
          threadTitle,
          contentText,
          peopleJson,
          tagsJson,
          rawData,
          importBatch,
          conversationId
        );

        if (result.changes > 0) {
          stats.messages++;
        } else if (updateExistingRows) {
          updateExisting.run(
            eventType,
            timestamp,
            threadTitle,
            contentText,
            peopleJson,
            tagsJson,
            rawData,
            conversationId,
            "amp",
            sourceId,
            sourceAccount
          );
          stats.refreshed++;
        } else if (refreshRawData) {
          updateRefresh.run(
            contentText,
            rawData,
            "amp",
            sourceId,
            sourceAccount
          );
          stats.refreshed++;
        } else {
          stats.skipped++;
        }
      }

      stats.threads++;

      // Progress indicator
      if (stats.threads % 50 === 0) {
        console.log(
          `  Processed ${stats.threads} threads, ${stats.messages.toLocaleString()} messages...`
        );
      }
    }

    // Commit the transaction
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }

  // Upsert all collected identities
  if (identities.size > 0) {
    upsertIdentities(db, [...identities.values()]);
    stats.identitiesUpserted = identities.size;
  }

  // Print summary
  console.log(`\n${"=".repeat(50)}`);
  console.log("Import complete:");
  console.log(`  Threads: ${stats.threads}`);
  console.log(`  Messages: ${stats.messages.toLocaleString()}`);
  if (refreshRawData || updateExistingRows) {
    console.log(`  Refreshed: ${stats.refreshed.toLocaleString()}`);
  }
  console.log(`  Identities: ${stats.identitiesUpserted}`);
  console.log(`  Skipped: ${stats.skipped}`);
  console.log(`  Batch ID: ${importBatch}`);

  onImportComplete(db);

  return stats;
}

// CLI
if (import.meta.main) {
  const args = process.argv.slice(2);
  const refreshRawData = args.includes("--refresh-raw-data");
  const positional = args.filter((a) => !a.startsWith("--"));

  const ampDir = positional[0]
    ? positional[0].startsWith("~")
      ? positional[0].replace("~", process.env.HOME || "")
      : positional[0]
    : DEFAULT_AMP_DIR;

  const accountName = positional[1] || "default";

  console.log(`Importing Amp threads from ${ampDir}`);
  console.log(`Account: ${accountName}`);
  if (refreshRawData) {
    console.log("Refresh mode: existing rows will have content + raw_data rewritten");
  }
  console.log();

  const db = getDb();
  initDb(db);

  await importAmp(db, ampDir, accountName, { refreshRawData });

  db.close();
}
