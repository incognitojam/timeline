import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import {
  onImportComplete,
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";
import { readdir } from "fs/promises";
import { join, basename } from "path";
import {
  type ContentBlock,
  extractText,
} from "./shared/format-content";

const DEFAULT_OPENCODE_DIR = `${process.env.HOME}/.local/share/opencode/storage`;

// ============ Type Definitions ============

interface OpenCodeProject {
  id: string;
  worktree: string;
  vcs?: string;
  time: {
    created: number;
    updated: number;
  };
}

interface OpenCodeSession {
  id: string;
  slug?: string;
  version?: string;
  projectID: string;
  directory: string;
  parentID?: string; // For subagent sessions
  title?: string;
  permission?: Array<{
    permission: string;
    action: string;
    pattern: string;
  }>;
  time: {
    created: number;
    updated: number;
  };
  summary?: {
    additions: number;
    deletions: number;
    files: number;
  };
}

interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: {
    created: number;
    completed?: number;
  };
  parentID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  agent?: string;
  path?: {
    cwd: string;
    root: string;
  };
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
  finish?: string;
  summary?: {
    title?: string;
    diffs?: Array<{ path: string; additions: number; deletions: number }>;
  };
  model?: {
    providerID: string;
    modelID: string;
  };
  tools?: Record<string, boolean>;
}

export interface OpenCodePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: "text" | "tool" | "step-start" | "step-finish";
  // For text parts
  text?: string;
  time?: {
    start: number;
    end: number;
  };
  // For tool parts
  callID?: string;
  tool?: string;
  state?: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    metadata?: {
      output?: string;
      exit?: number;
      description?: string;
      truncated?: boolean;
    };
    time?: {
      start: number;
      end: number;
    };
  };
  // For step-finish parts
  reason?: string;
  snapshot?: string;
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
}

interface ImportStats {
  sessions: number;
  messages: number;
  refreshed: number;
  skipped: number;
  parts: number;
  identitiesUpserted: number;
}

export interface ImportOpenCodeOptions {
  dryRun?: boolean;
  refreshRawData?: boolean;
}

/**
 * Format model ID into a human-readable name.
 * Examples:
 *   claude-opus-4-5-20251101 -> Claude Opus 4.5
 *   gpt-4o -> GPT-4o
 */
function formatModelDisplayName(modelId: string | undefined): string {
  if (!modelId) return "OpenCode";

  // Strip date suffix (e.g., -20251101)
  let cleaned = modelId.replace(/-\d{8}$/, "");

  // Handle GPT models specially
  if (cleaned.startsWith("gpt-")) {
    const version = cleaned.slice(4); // Remove "gpt-"
    return `GPT-${version.toUpperCase()}`;
  }

  // Convert version patterns (e.g., 4-5 -> 4.5)
  cleaned = cleaned.replace(/(\d+)-(\d+)(?=-|$)/g, "$1.$2");

  // Format as title case
  return cleaned
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

// ============ Helper Functions ============

async function loadJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await Bun.file(filePath).text();
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function loadAllInDirectory<T>(
  dirPath: string
): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  try {
    const files = await readdir(dirPath);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const id = basename(file, ".json");
      const data = await loadJsonFile<T>(join(dirPath, file));
      if (data) {
        result.set(id, data);
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  return result;
}

function getProjectNameFromPath(directory: string | undefined): string {
  if (!directory) return "unknown";
  const parts = directory.split("/");
  return parts[parts.length - 1] || "unknown";
}

/**
 * Convert OpenCode's on-disk `part` objects into the shared ContentBlock form.
 * A single `tool` part becomes two blocks: a `tool_use` (always) and, if the
 * tool has run, a matching `tool_result` linked by `id` / `tool_use_id`.
 * `step-start` / `step-finish` parts are metadata and dropped.
 */
export function normalizePartsToBlocks(parts: OpenCodePart[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.text) {
          blocks.push({ type: "text", text: part.text });
        }
        break;

      case "tool": {
        if (!part.tool) break;
        const toolId = part.callID;
        blocks.push({
          type: "tool_use",
          name: part.tool,
          id: toolId,
          input: part.state?.input,
        });
        const output = part.state?.output ?? part.state?.metadata?.output;
        if (output !== undefined) {
          const status = part.state?.status;
          const isError = status === "error" || status === "failed";
          blocks.push({
            type: "tool_result",
            tool_use_id: toolId,
            ...(isError ? { error: output } : { content: output }),
          });
        }
        break;
      }
      // step-start / step-finish are skipped.
    }
  }

  return blocks;
}

function extractToolUsage(parts: OpenCodePart[]): Record<string, number> {
  const toolCounts: Record<string, number> = {};

  for (const part of parts) {
    if (part.type === "tool" && part.tool) {
      toolCounts[part.tool] = (toolCounts[part.tool] || 0) + 1;
    }
  }

  return toolCounts;
}

// ============ Main Import Function ============

export async function importOpenCode(
  db: Database,
  openCodeDir: string,
  sourceAccount: string,
  options: ImportOpenCodeOptions = {}
) {
  const importBatch = `opencode-${sourceAccount}-${Date.now()}`;
  const dryRun = options.dryRun ?? false;
  const refreshRawData = options.refreshRawData ?? false;

  const stats: ImportStats = {
    sessions: 0,
    messages: 0,
    refreshed: 0,
    skipped: 0,
    parts: 0,
    identitiesUpserted: 0,
  };

  // Collect identities for batch upsert
  const identities = new Map<string, UpsertIdentityOptions>();

  // User identity (always present)
  const userIdentifier = formatIdentifier("opencode", sourceAccount);
  identities.set(userIdentifier, {
    platform: "opencode",
    platformId: sourceAccount,
    displayName: sourceAccount,
    username: sourceAccount,
  });

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (
      source, source_id, source_account, type, timestamp, end_timestamp, duration_ms,
      title, content, people, tags, raw_data, import_batch, conversation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateRefresh = db.prepare(`
    UPDATE events SET content = ?, raw_data = ?
    WHERE source = ? AND source_id = ? AND source_account = ?
  `);

  // Load all projects
  console.log("Loading projects...");
  const projectDir = join(openCodeDir, "project");
  const projects = await loadAllInDirectory<OpenCodeProject>(projectDir);
  console.log(`  Found ${projects.size} projects`);

  // Load all sessions (grouped by project)
  console.log("Loading sessions...");
  const sessionDir = join(openCodeDir, "session");
  const allSessions = new Map<string, OpenCodeSession>();

  try {
    const projectDirs = await readdir(sessionDir);
    for (const projId of projectDirs) {
      const sessionsPath = join(sessionDir, projId);
      const sessions = await loadAllInDirectory<OpenCodeSession>(sessionsPath);
      for (const [id, session] of sessions) {
        allSessions.set(id, session);
      }
    }
  } catch {
    console.error("Failed to read session directory");
  }
  console.log(`  Found ${allSessions.size} sessions`);

  // Filter out subagent sessions (those with parentID)
  const topLevelSessions = Array.from(allSessions.values()).filter(
    (s) => !s.parentID
  );
  console.log(`  ${topLevelSessions.length} top-level sessions (excluding subagents)`);

  // Load all messages
  console.log("Loading messages...");
  const messageDir = join(openCodeDir, "message");
  const allMessages = new Map<string, OpenCodeMessage[]>();

  try {
    const sessionDirs = await readdir(messageDir);
    for (const sessionId of sessionDirs) {
      const messagesPath = join(messageDir, sessionId);
      const messages = await loadAllInDirectory<OpenCodeMessage>(messagesPath);
      const messageList = Array.from(messages.values()).sort(
        (a, b) => a.time.created - b.time.created
      );
      allMessages.set(sessionId, messageList);
    }
  } catch {
    console.error("Failed to read message directory");
  }
  const totalMessages = Array.from(allMessages.values()).reduce(
    (sum, msgs) => sum + msgs.length,
    0
  );
  console.log(`  Found ${totalMessages} messages`);

  // Load all parts
  console.log("Loading parts...");
  const partDir = join(openCodeDir, "part");
  const allParts = new Map<string, OpenCodePart[]>();

  try {
    const messageDirs = await readdir(partDir);
    for (const messageId of messageDirs) {
      const partsPath = join(partDir, messageId);
      const parts = await loadAllInDirectory<OpenCodePart>(partsPath);
      // Sort parts by ID (they have timestamps embedded in the ID)
      const partList = Array.from(parts.values()).sort((a, b) =>
        a.id.localeCompare(b.id)
      );
      allParts.set(messageId, partList);
      stats.parts += partList.length;
    }
  } catch {
    console.error("Failed to read part directory");
  }
  console.log(`  Found ${stats.parts} parts`);

  if (dryRun) {
    console.log("\n=== DRY RUN - No changes will be made ===\n");
  } else {
    db.run("BEGIN TRANSACTION");
  }

  try {
    // Process each top-level session and its messages
    for (const session of topLevelSessions) {
      const project = projects.get(session.projectID);
      const projectName = project
        ? getProjectNameFromPath(project.worktree)
        : getProjectNameFromPath(session.directory);

      // Get all messages for this session AND any child sessions (subagents)
      const sessionMessages = allMessages.get(session.id) || [];

      // Also collect messages from child sessions (subagents)
      const childSessionIds = Array.from(allSessions.values())
        .filter((s) => s.parentID === session.id)
        .map((s) => s.id);

      const allSessionMessages = [
        ...sessionMessages,
        ...childSessionIds.flatMap((id) => allMessages.get(id) || []),
      ].sort((a, b) => a.time.created - b.time.created);

      if (allSessionMessages.length === 0) {
        stats.skipped++;
        continue;
      }

      for (const msg of allSessionMessages) {
        const parts = allParts.get(msg.id) || [];
        const blocks = normalizePartsToBlocks(parts);
        const contentText = extractText(blocks);

        // Skip rows with no structured blocks at all. Pure tool-use assistant
        // messages are kept: contentText may be empty but raw_data.content
        // preserves the structured blocks.
        if (blocks.length === 0) {
          stats.skipped++;
          continue;
        }

        const eventType =
          msg.role === "user"
            ? "opencode:message:user"
            : "opencode:message:assistant";

        // Build title: project name + session title/slug
        const sessionInfo = allSessions.get(msg.sessionID);
        const sessionTitle =
          sessionInfo?.title ||
          (sessionInfo?.slug ? `(${sessionInfo.slug})` : "");
        const title = sessionTitle
          ? `${projectName}: ${sessionTitle}`
          : projectName;

        // Build tags
        const tags: string[] = ["editor:opencode"];
        if (projectName) {
          tags.push(`project:${projectName}`);
        }
        const model = msg.modelID || msg.model?.modelID;
        const provider = msg.providerID || msg.model?.providerID;
        if (model) {
          tags.push(`model:${model}`);
        }

        // Build qualified identifiers for people
        let people: string[];
        if (msg.role === "user") {
          people = [userIdentifier];
        } else {
          // Assistant message - use model as identifier, fallback to "assistant"
          const assistantPlatformId = model || "assistant";
          const assistantIdentifier = formatIdentifier("opencode", assistantPlatformId);
          people = [assistantIdentifier, userIdentifier];

          // Add assistant identity if not already tracked
          if (!identities.has(assistantIdentifier)) {
            identities.set(assistantIdentifier, {
              platform: "opencode",
              platformId: assistantPlatformId,
              displayName: formatModelDisplayName(model),
              username: assistantPlatformId,
            });
          }
        }
        if (provider && provider !== "opencode") {
          tags.push(`provider:${provider}`);
        }
        if (msg.agent) {
          tags.push(`agent:${msg.agent}`);
        }
        if (msg.mode) {
          tags.push(`mode:${msg.mode}`);
        }

        // Tool usage is preserved in raw_data but not tagged.
        const toolUsage = extractToolUsage(parts);

        // Calculate duration for assistant messages
        const durationMs =
          msg.role === "assistant" && msg.time.completed
            ? msg.time.completed - msg.time.created
            : null;

        const timestamp = new Date(msg.time.created).toISOString();
        const endTimestamp = msg.time.completed
          ? new Date(msg.time.completed).toISOString()
          : null;

        // Build raw_data with all the juicy details
        const rawData = JSON.stringify({
          session_id: session.id,
          message_id: msg.id,
          message_session_id: msg.sessionID, // May differ if from subagent
          parent_message_id: msg.parentID,
          project_id: session.projectID,
          project_path: project?.worktree || session.directory,
          session_slug: session.slug,
          session_title: session.title,
          model: model,
          provider: provider,
          agent: msg.agent,
          mode: msg.mode,
          finish_reason: msg.finish,
          cost: msg.cost,
          tokens: msg.tokens,
          tool_usage: Object.keys(toolUsage).length > 0 ? toolUsage : undefined,
          summary: msg.summary,
          cwd: msg.path?.cwd,
          content: blocks,
          source_parts: parts,
        });

        const sourceId = `${session.id}:${msg.id}`;

        if (dryRun) {
          console.log(`Would insert: ${eventType} - ${title}`);
          console.log(`  Timestamp: ${timestamp}`);
          console.log(`  Duration: ${durationMs}ms`);
          console.log(`  Tokens: ${JSON.stringify(msg.tokens)}`);
          console.log(`  Cost: $${msg.cost?.toFixed(6)}`);
          console.log(`  Tools: ${JSON.stringify(toolUsage)}`);
          console.log(`  Tags: ${tags.join(", ")}`);
          console.log(`  Blocks: ${blocks.length}`);
          console.log(`  Content preview: ${contentText.slice(0, 100)}...`);
          console.log("");
          stats.messages++;
        } else {
          const result = insert.run(
            "opencode",
            sourceId,
            sourceAccount,
            eventType,
            timestamp,
            endTimestamp,
            durationMs,
            title,
            contentText,
            JSON.stringify(people),
            tags.length > 0 ? JSON.stringify(tags) : null,
            rawData,
            importBatch,
            session.id
          );

          if (result.changes > 0) {
            stats.messages++;
          } else if (refreshRawData) {
            updateRefresh.run(
              contentText,
              rawData,
              "opencode",
              sourceId,
              sourceAccount
            );
            stats.refreshed++;
          } else {
            stats.skipped++;
          }
        }
      }

      stats.sessions++;

      // Progress indicator
      if (stats.sessions % 10 === 0) {
        console.log(
          `  Processed ${stats.sessions} sessions, ${stats.messages.toLocaleString()} messages...`
        );
      }
    }

    if (!dryRun) {
      db.run("COMMIT");
    }
  } catch (error) {
    if (!dryRun) {
      db.run("ROLLBACK");
    }
    throw error;
  }

  // Upsert all collected identities (only on actual import)
  if (!dryRun && identities.size > 0) {
    upsertIdentities(db, [...identities.values()]);
    stats.identitiesUpserted = identities.size;
  }

  // Print summary
  console.log(`\n${"=".repeat(50)}`);
  console.log(dryRun ? "Dry run complete:" : "Import complete:");
  console.log(`  Sessions: ${stats.sessions}`);
  console.log(`  Messages: ${stats.messages.toLocaleString()}`);
  if (refreshRawData) {
    console.log(`  Refreshed: ${stats.refreshed.toLocaleString()}`);
  }
  console.log(`  Parts loaded: ${stats.parts.toLocaleString()}`);
  console.log(`  Identities: ${stats.identitiesUpserted}`);
  console.log(`  Skipped: ${stats.skipped}`);
  if (!dryRun) {
    console.log(`  Batch ID: ${importBatch}`);
    onImportComplete(db);
  }

  return stats;
}

// ============ CLI ============

if (import.meta.main) {
  const args = process.argv.slice(2);

  // Parse flags
  const dryRun = args.includes("--dry-run");
  const refreshRawData = args.includes("--refresh-raw-data");
  const filteredArgs = args.filter((a) => !a.startsWith("--"));

  const openCodeDir = filteredArgs[0]
    ? filteredArgs[0].startsWith("~")
      ? filteredArgs[0].replace("~", process.env.HOME || "")
      : filteredArgs[0]
    : DEFAULT_OPENCODE_DIR;

  const accountName = filteredArgs[1] || "default";

  console.log(`Importing OpenCode sessions from ${openCodeDir}`);
  console.log(`Account: ${accountName}`);
  if (dryRun) {
    console.log("Mode: DRY RUN");
  }
  if (refreshRawData) {
    console.log("Refresh mode: existing rows will have content + raw_data rewritten");
  }
  console.log();

  const db = getDb();
  initDb(db);

  await importOpenCode(db, openCodeDir, accountName, {
    dryRun,
    refreshRawData,
  });

  db.close();
}
