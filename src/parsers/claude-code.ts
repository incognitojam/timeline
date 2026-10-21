import { Database } from "bun:sqlite";
import { getDb, initDb } from "../db/schema";
import {
  onImportComplete,
  upsertIdentities,
  formatIdentifier,
  type UpsertIdentityOptions,
} from "../db/queries";
import { readdir } from "fs/promises";
import type { Dirent } from "fs";
import { join, basename } from "path";
import { insertStoredAttachment } from "../media/attachments";
import {
  type ContentBlock,
  extractText,
  toContentBlocks,
} from "./shared/format-content";
import {
  storeImageBlocks,
  storeImageRawContent,
  type StoredImageAttachment,
} from "./shared/image-blocks";

const DEFAULT_CLAUDE_DIR = `${process.env.HOME}/.claude/projects`;

interface ClaudeCodeMessage {
  type: "user" | "assistant" | "file-history-snapshot" | string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  slug?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  agentId?: string;
  message?: {
    role: "user" | "assistant";
    content: string | ContentBlock[];
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  // Newer Claude Code transcripts attach a `toolUseResult` summary on each
  // tool_result-bearing user row. For Agent/Task tool_results this carries
  // `agentId`, which directly identifies the spawned sidechain (the file is
  // named `agent-<agentId>.jsonl`). This is unambiguous even when two
  // parallel Task calls share an identical prompt.
  toolUseResult?: {
    agentId?: string;
    agentType?: string;
  };
}

interface SessionInfo {
  sessionId: string;
  projectPath: string;
  slug?: string;
  messages: ClaudeCodeMessage[];
}

interface ImportStats {
  sessions: number;
  messages: number;
  refreshed: number;
  skipped: number;
  identitiesUpserted: number;
}

export type StoredClaudeCodeImageAttachment = StoredImageAttachment;

export interface StoredClaudeCodeImageBlocks {
  blocks: ContentBlock[];
  attachments: StoredClaudeCodeImageAttachment[];
}

export interface StoredClaudeCodeImageRawContent {
  content: unknown[];
  attachments: StoredClaudeCodeImageAttachment[];
}

export interface ImportClaudeCodeOptions {
  refreshRawData?: boolean;
}

/**
 * Format model ID into a human-readable name.
 * Examples:
 *   claude-opus-4-5-20251101 -> Claude Opus 4.5
 *   claude-sonnet-4-20250514 -> Claude Sonnet 4
 */
function formatModelDisplayName(modelId: string | undefined): string {
  if (!modelId) return "Claude";

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

/**
 * Last-resort decode of a `~/.claude/projects/<dir>` directory name. The
 * encoding rewrites every `/` in the launch cwd to `-`, which is lossy: a
 * literal `-` inside a path segment is indistinguishable from a separator, so
 * `-Users-alice-Developer-example-service-api` could end in `api`,
 * `service-api`, or `example-service-api`. We can only guess the trailing
 * segment. Prefer `projectNameFromLaunchCwd()` whenever a real cwd is known.
 */
function getProjectNameFromPath(projectPath: string): string {
  const parts = projectPath.split("-");
  return parts[parts.length - 1] || projectPath;
}

/**
 * Project name from a session's launch working directory. Claude Code records
 * the real `cwd` on each message, so the basename of the launch cwd is the
 * unambiguous project name (`/Users/alice/Developer/example-service-api` ->
 * `example-service-api`). Returns null for an empty basename (e.g. `/`).
 */
export function projectNameFromLaunchCwd(launchCwd: string): string | null {
  return basename(launchCwd) || null;
}

/**
 * Resolve a session's project name, preferring the launch cwd basename and
 * falling back to the lossy directory decode only when no message carried a
 * cwd. `launchCwd` should be the launch directory's cwd — the one that encodes
 * to `projectDir`; callers resolve it by round-tripping each message's cwd
 * against `projectDir` so a mid-session `cd` can't rename the project.
 */
export function claudeCodeProjectName(
  launchCwd: string | undefined,
  projectDir: string
): string {
  if (launchCwd) {
    const name = projectNameFromLaunchCwd(launchCwd);
    if (name) return name;
  }
  return getProjectNameFromPath(projectDir);
}

function isConductorWorkspace(projectPath: string): boolean {
  // Conductor workspaces are stored in paths like:
  // -Users-alice-conductor-workspaces-timeline-sample-worktree
  // Skip these since they're imported by the conductor parser
  return projectPath.includes("-conductor-workspaces-");
}

/**
 * Parse the lines of a JSONL transcript into ClaudeCodeMessage objects.
 * Bad JSON lines are skipped silently to match the existing tolerant behavior.
 */
async function parseJsonlMessages(filePath: string): Promise<ClaudeCodeMessage[]> {
  const content = await Bun.file(filePath).text();
  const out: ClaudeCodeMessage[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ClaudeCodeMessage);
    } catch {
      // skip
    }
  }
  return out;
}

/**
 * Index sub-agent-spawning tool_use invocations in a session's messages by
 * their `input.prompt`, mapping to the `toolu_XXX` id. Claude Code names the
 * tool "Task" (older transcripts) or "Agent" (newer transcripts); both carry
 * `prompt` and `subagent_type` in `input`. The result is used to link a
 * sub-agent's sidechain JSONL back to the parent message that spawned it.
 */
function buildTaskPromptToToolUseIdMap(
  messages: ClaudeCodeMessage[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.type !== "assistant" || !msg.message) continue;
    const blocks = toContentBlocks(msg.message.content);
    for (const block of blocks) {
      if (block.type !== "tool_use" || !block.id) continue;
      if (block.name !== "Task" && block.name !== "Agent") continue;
      const input = recordFromUnknown(block.input);
      const prompt = input?.prompt;
      if (typeof prompt === "string" && prompt.length > 0) {
        map.set(prompt.trim(), block.id);
      }
    }
  }
  return map;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function storeClaudeCodeImageRawContent(options: {
  content: unknown[];
  sourceAccount: string;
  sessionId: string;
  messageUuid: string;
}): Promise<StoredClaudeCodeImageRawContent> {
  return storeImageRawContent({
    ...options,
    source: "claude-code",
    sourceLabel: "Claude Code",
    loggerPrefix: "claude-code",
    messageId: options.messageUuid,
  });
}

export async function storeClaudeCodeImageBlocks(options: {
  blocks: ContentBlock[];
  sourceAccount: string;
  sessionId: string;
  messageUuid: string;
}): Promise<StoredClaudeCodeImageBlocks> {
  return storeImageBlocks({
    ...options,
    source: "claude-code",
    sourceLabel: "Claude Code",
    loggerPrefix: "claude-code",
    messageId: options.messageUuid,
  });
}

/**
 * Extract the first user-role message's text content. Used to match a
 * sidechain JSONL against the parent's Task tool_use prompt.
 */
function getFirstUserPromptText(messages: ClaudeCodeMessage[]): string | null {
  for (const msg of messages) {
    if (msg.type !== "user" || !msg.message) continue;
    const text = extractText(toContentBlocks(msg.message.content)).trim();
    if (text.length > 0) return text;
  }
  return null;
}

/**
 * Build an `agentId → toolu_XXX` index by walking tool_result rows. Newer
 * Claude Code transcripts attach `toolUseResult.agentId` to the user-role
 * row that carries the matching tool_result block, giving us a direct,
 * collision-free link from a sidechain file (`agent-<agentId>.jsonl`) back
 * to the `toolu_XXX` that spawned it — even when two parallel Task calls
 * share an identical prompt.
 */
function buildAgentIdToToolUseIdMap(
  messages: ClaudeCodeMessage[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    const agentId = msg.toolUseResult?.agentId;
    if (!agentId || !msg.message) continue;
    for (const block of toContentBlocks(msg.message.content)) {
      if (block.type !== "tool_result") continue;
      const toolUseId = block.tool_use_id;
      if (typeof toolUseId === "string" && toolUseId.startsWith("toolu_")) {
        map.set(agentId, toolUseId);
        break;
      }
    }
  }
  return map;
}

export async function importClaudeCode(
  db: Database,
  claudeDir: string,
  sourceAccount: string,
  options: ImportClaudeCodeOptions = {}
) {
  const importBatch = `claude-code-${sourceAccount}-${Date.now()}`;
  const refreshRawData = options.refreshRawData ?? false;

  const stats: ImportStats = {
    sessions: 0,
    messages: 0,
    refreshed: 0,
    skipped: 0,
    identitiesUpserted: 0,
  };

  // Collect identities for batch upsert
  const identities = new Map<string, UpsertIdentityOptions>();

  // User identity (always present)
  const userIdentifier = formatIdentifier("claude-code", sourceAccount);
  identities.set(userIdentifier, {
    platform: "claude-code",
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
  const findEventId = db.prepare(`
    SELECT id FROM events
    WHERE source = ? AND source_id = ? AND source_account = ?
  `);

  // Find all project directories
  const projectDirs = await readdir(claudeDir);

  // Wrap entire import in a transaction for massive speedup
  db.run("BEGIN TRANSACTION");

  console.log(`Found ${projectDirs.length} project directories`);

  // Insert/update a single parsed message. Captures outer scope (db, stmts,
  // stats, identities, batch). `parentToolUseId` is supplied when the message
  // came from a sidechain JSONL whose parent Task tool_use we resolved;
  // `orphanSidechain` marks sidechains whose parent prompt didn't match.
  const processMessage = async (
    msg: ClaudeCodeMessage,
    sessionId: string,
    sessionSlug: string | undefined,
    projectName: string,
    parentToolUseId?: string,
    orphanSidechain?: boolean
  ) => {
    if (msg.type !== "user" && msg.type !== "assistant") return;
    if (!msg.message || !msg.uuid || !msg.timestamp) return;

    const blocks = toContentBlocks(msg.message.content);
    if (blocks.length === 0) {
      stats.skipped++;
      return;
    }

    const sourceId = `${sessionId}:${msg.uuid}`;
    const existingEvent = findEventId.get(
      "claude-code",
      sourceId,
      sourceAccount
    ) as { id: number } | undefined;
    if (existingEvent && !refreshRawData) {
      stats.skipped++;
      return;
    }

    const storedImageBlocks = await storeClaudeCodeImageBlocks({
      blocks,
      sourceAccount,
      sessionId,
      messageUuid: msg.uuid,
    });
    const normalizedBlocks = storedImageBlocks.blocks;

    const eventType =
      msg.type === "user"
        ? "claude-code:message:user"
        : "claude-code:message:assistant";
    const contentText = extractText(normalizedBlocks);
    const title = sessionSlug ? `${projectName} (${sessionSlug})` : projectName;

    const tags: string[] = ["editor:claude-code"];
    tags.push(`project:${projectName}`);
    if (msg.gitBranch) tags.push(`branch:${msg.gitBranch}`);
    if (msg.message.model) tags.push(`model:${msg.message.model}`);

    let people: string[];
    if (msg.type === "user") {
      people = [userIdentifier];
    } else {
      const model = msg.message.model;
      const assistantPlatformId = model || "assistant";
      const assistantIdentifier = formatIdentifier("claude-code", assistantPlatformId);
      people = [assistantIdentifier, userIdentifier];

      if (!identities.has(assistantIdentifier)) {
        identities.set(assistantIdentifier, {
          platform: "claude-code",
          platformId: assistantPlatformId,
          displayName: formatModelDisplayName(model),
          username: assistantPlatformId,
        });
      }
    }

    const rawData = JSON.stringify({
      session_id: sessionId,
      message_uuid: msg.uuid,
      parent_uuid: msg.parentUuid,
      cwd: msg.cwd,
      git_branch: msg.gitBranch,
      slug: msg.slug,
      model: msg.message.model,
      usage: msg.message.usage,
      is_sidechain: msg.isSidechain ?? false,
      agent_id: msg.agentId,
      parent_tool_use_id: parentToolUseId,
      orphan_sidechain: orphanSidechain ? true : undefined,
      content: normalizedBlocks,
    });

    let eventId: number;
    if (existingEvent) {
      updateRefresh.run(
        contentText,
        rawData,
        "claude-code",
        sourceId,
        sourceAccount
      );
      eventId = existingEvent.id;
      stats.refreshed++;
    } else {
      const result = insert.run(
        "claude-code",
        sourceId,
        sourceAccount,
        eventType,
        msg.timestamp,
        title,
        contentText,
        JSON.stringify(people),
        tags.length > 0 ? JSON.stringify(tags) : null,
        rawData,
        importBatch,
        sessionId
      );

      if (result.changes === 0) {
        stats.skipped++;
        return;
      }

      const insertedEvent = findEventId.get(
        "claude-code",
        sourceId,
        sourceAccount
      ) as { id: number } | undefined;
      if (!insertedEvent) {
        throw new Error(`Failed to resolve inserted Claude Code event ${sourceId}`);
      }
      eventId = insertedEvent.id;
      stats.messages++;
    }

    for (const attachment of storedImageBlocks.attachments) {
      insertStoredAttachment(db, {
        eventId,
        source: "claude-code",
        sourceId: attachment.sourceId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        width: attachment.width,
        height: attachment.height,
      }, attachment.stored);
    }
  };

  try {
    for (const projectDir of projectDirs) {
      // Skip Conductor workspaces - they're imported by conductor parser
      if (isConductorWorkspace(projectDir)) {
        continue;
      }

      const projectPath = join(claudeDir, projectDir);

      // List project entries; capture .jsonl files and session-named
      // subdirectories (the latter hold subagents/ JSONLs).
      let entries: Dirent[];
      try {
        entries = await readdir(projectPath, { withFileTypes: true });
      } catch {
        continue;
      }

      const files: string[] = [];
      const sessionSubdirs = new Set<string>();
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(entry.name);
        } else if (entry.isDirectory()) {
          sessionSubdirs.add(entry.name);
        }
      }

      if (files.length === 0) continue;

      for (const file of files) {
        const sessionId = basename(file, ".jsonl");
        const filePath = join(projectPath, file);

        const messages = await parseJsonlMessages(filePath);

        // Capture session metadata. For the project name we want the launch
        // directory's cwd — the one Claude Code encoded into `projectDir` by
        // rewriting every `/` to `-`. Prefer the cwd that round-trips to
        // `projectDir` (robust when a session starts in a container dir and
        // `cd`s into the real project, or vice versa); fall back to the first
        // cwd seen, then to the lossy dir decode.
        let sessionSlug: string | undefined;
        let firstCwd: string | undefined;
        let launchCwd: string | undefined;
        for (const m of messages) {
          if (!sessionSlug && m.slug) sessionSlug = m.slug;
          if (m.cwd) {
            if (firstCwd === undefined) firstCwd = m.cwd;
            if (launchCwd === undefined && m.cwd.replaceAll("/", "-") === projectDir) {
              launchCwd = m.cwd;
            }
          }
          if (sessionSlug && launchCwd) break;
        }
        const projectName = claudeCodeProjectName(launchCwd ?? firstCwd, projectDir);

        // Read all sidechain JSONLs for this session upfront. We need them
        // available before building the taskMap so nested sub-agents — a
        // Task tool_use that lives inside another sidechain — can resolve
        // to their parent toolu_XXX. Without this, nested sidechains end
        // up with parent_tool_use_id: null and appear inline in the main
        // flow instead of nested under their spawning Task.
        const sidechainFiles: { name: string; messages: ClaudeCodeMessage[] }[] = [];
        if (sessionSubdirs.has(sessionId)) {
          const subagentDir = join(projectPath, sessionId, "subagents");
          let agentFiles: string[] = [];
          try {
            agentFiles = (await readdir(subagentDir)).filter(
              (f) => f.startsWith("agent-") && f.endsWith(".jsonl")
            );
          } catch {
            // No subagents/ directory; skip.
          }
          for (const agentFile of agentFiles) {
            const agentMessages = await parseJsonlMessages(
              join(subagentDir, agentFile)
            );
            sidechainFiles.push({ name: agentFile, messages: agentMessages });
          }
        }

        // Build two indexes over main + sidechain messages: an
        // agentId → toolu_XXX map (unambiguous when present) and a
        // prompt → toolu_XXX map (fallback for older transcripts that
        // lack `toolUseResult.agentId`).
        const allMessagesForIndex = [
          ...messages,
          ...sidechainFiles.flatMap((f) => f.messages),
        ];
        const agentIdMap = buildAgentIdToToolUseIdMap(allMessagesForIndex);
        const taskMap = buildTaskPromptToToolUseIdMap(allMessagesForIndex);

        // Insert main session messages.
        for (const msg of messages) {
          await processMessage(msg, sessionId, sessionSlug, projectName);
        }

        // Insert sidechain messages, linked back to the Task tool_use that
        // spawned each transcript. Prefer agentId-based linking (collision
        // free) and fall back to prompt-matching for older transcripts.
        for (const { name, messages: agentMessages } of sidechainFiles) {
          if (agentMessages.length === 0) continue;
          // Sidechain filename is `agent-<agentId>.jsonl`. Strip prefix
          // and extension to recover the agentId.
          const agentId = name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
          let parentToolUseId = agentIdMap.get(agentId);
          if (!parentToolUseId) {
            const firstPrompt = getFirstUserPromptText(agentMessages);
            if (firstPrompt) parentToolUseId = taskMap.get(firstPrompt);
          }
          const orphanSidechain = !parentToolUseId;

          for (const msg of agentMessages) {
            await processMessage(
              msg,
              sessionId,
              sessionSlug,
              projectName,
              parentToolUseId,
              orphanSidechain
            );
          }
        }

        stats.sessions++;

        // Progress indicator
        if (stats.sessions % 50 === 0) {
          console.log(
            `  Processed ${stats.sessions} sessions, ${stats.messages.toLocaleString()} messages...`
          );
        }
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
  console.log(`  Sessions: ${stats.sessions}`);
  console.log(`  Messages: ${stats.messages.toLocaleString()}`);
  if (refreshRawData) {
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

  const claudeDir = positional[0]
    ? positional[0].startsWith("~")
      ? positional[0].replace("~", process.env.HOME || "")
      : positional[0]
    : DEFAULT_CLAUDE_DIR;

  const accountName = positional[1] || "default";

  console.log(`Importing Claude Code sessions from ${claudeDir}`);
  console.log(`Account: ${accountName}`);
  if (refreshRawData) {
    console.log("Refresh mode: existing rows will have content + raw_data rewritten");
  }
  console.log();

  const db = getDb();
  initDb(db);

  await importClaudeCode(db, claudeDir, accountName, { refreshRawData });

  db.close();
}
